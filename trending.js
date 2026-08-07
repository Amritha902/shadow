// Trending dance feed.
//
// The whole point of this file: the home screen should never be empty and should
// never go stale. It keeps a rolling set of dance challenges that are actually
// circulating right now, refreshed on a timer, cached to disk so a restart is
// instant and a flaky network shows yesterday's feed instead of nothing.
//
// Two sources, tried in order:
//
//   1. YouTube Data API (if YOUTUBE_API_KEY is set) — the real "most popular in
//      Music" chart plus a dance-challenge search. Higher quality, quota-limited.
//   2. yt-dlp search (always available, no key) — searches the queries below and
//      keeps whatever comes back. Lower quality ranking, but it needs nothing.
//
// Everything is normalised to the same shape the library uses, so the client
// treats a trending card and a saved routine identically.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const REFRESH_MS = 6 * 60 * 60 * 1000; // 6h — trends move in days, not minutes
const WANT = 24;                        // cards to keep in the feed

// Rotated so the feed isn't the same twelve videos every refresh. Phrased the
// way people title dance content, biased toward learnable single-dancer clips.
const QUERIES = [
  'dance challenge tutorial',
  'trending dance 2026',
  'tiktok dance tutorial mirrored',
  'kpop dance cover mirrored',
  'viral dance routine slow',
  'hook step tutorial',
  'easy dance challenge steps',
  'afrobeats dance tutorial',
];

// Titles that are clips of a crowd, a concert, or a compilation rather than one
// dancer you can shadow. Cheap heuristic, not perfect.
const REJECT = /\b(concert|live performance|compilation|reaction|awards|fancam|edit|amv|full song|lyrics)\b/i;

function normalise(entries, source) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const id = e.id || e.videoId;
    if (!id || !/^[\w-]{11}$/.test(id) || seen.has(id)) continue;
    const title = e.title || e.snippet?.title || '';
    if (!title || REJECT.test(title)) continue;
    const dur = e.duration ?? null;
    if (dur != null && (dur < 8 || dur > 12 * 60)) continue; // skip stings and full sets
    seen.add(id);
    out.push({
      id,
      title,
      channel: e.channel || e.uploader || e.snippet?.channelTitle || '',
      duration: dur,
      thumbnail:
        e.thumbnails?.[e.thumbnails.length - 1]?.url ||
        e.snippet?.thumbnails?.medium?.url ||
        `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
      source,
    });
  }
  return out;
}

async function fromApiKey(key, fetchImpl) {
  const base = 'https://www.googleapis.com/youtube/v3';
  // The Music chart is genuinely "what's popular now"; the search catches dance
  // content that isn't charting as a song.
  const urls = [
    `${base}/videos?part=snippet&chart=mostPopular&videoCategoryId=10&maxResults=25&regionCode=US&key=${key}`,
    `${base}/search?part=snippet&q=${encodeURIComponent('dance challenge tutorial')}&type=video&order=viewCount&maxResults=25&videoEmbeddable=true&key=${key}`,
  ];
  const collected = [];
  for (const url of urls) {
    const r = await fetchImpl(url);
    if (!r.ok) throw new Error(`YouTube API ${r.status}`);
    const data = await r.json();
    for (const item of data.items || []) {
      collected.push({ id: item.id?.videoId || item.id, ...item });
    }
  }
  return normalise(collected, 'youtube-api');
}

async function fromYtdlp(ytdlp) {
  // A couple of queries per refresh, rotated by the clock so the feed drifts.
  const rot = Math.floor(Date.now() / REFRESH_MS) % QUERIES.length;
  const picks = [QUERIES[rot], QUERIES[(rot + 3) % QUERIES.length], QUERIES[(rot + 5) % QUERIES.length]];
  const collected = [];
  for (const q of picks) {
    try {
      const out = await ytdlp([
        '--flat-playlist', '-J', '--playlist-end', '12',
        `ytsearch12:${q}`,
      ]);
      const entries = JSON.parse(out).entries || [];
      collected.push(...entries);
    } catch { /* one bad query shouldn't empty the feed */ }
  }
  return normalise(collected, 'ytdlp');
}

export function createTrending({ ytdlp, cacheFile, fetchImpl = fetch, apiKey = process.env.YOUTUBE_API_KEY }) {
  let cache = { at: 0, items: [] };
  let inflight = null;

  async function loadDisk() {
    if (existsSync(cacheFile)) {
      try { cache = JSON.parse(await readFile(cacheFile, 'utf8')); } catch { /* ignore */ }
    }
  }

  async function refresh() {
    let items = [];
    if (apiKey) {
      try { items = await fromApiKey(apiKey, fetchImpl); }
      catch { items = []; } // fall through to yt-dlp on quota/network error
    }
    if (items.length < WANT / 2) {
      const more = await fromYtdlp(ytdlp);
      // Merge, API results first, de-duped by id.
      const ids = new Set(items.map((i) => i.id));
      for (const m of more) if (!ids.has(m.id)) items.push(m);
    }
    if (items.length) {
      cache = { at: Date.now(), items: items.slice(0, WANT) };
      writeFile(cacheFile, JSON.stringify(cache)).catch(() => {});
    }
    return cache;
  }

  return {
    async init() {
      await loadDisk();
      // Refresh on boot only if the disk copy is stale; never block startup.
      if (Date.now() - cache.at > REFRESH_MS) this.get().catch(() => {});
      setInterval(() => this.get(true).catch(() => {}), REFRESH_MS).unref?.();
    },
    // Returns cached items immediately when fresh; otherwise refreshes, but
    // collapses concurrent callers onto one refresh so a burst of loads is one
    // set of searches.
    async get(force = false) {
      const stale = Date.now() - cache.at > REFRESH_MS;
      if (!force && !stale && cache.items.length) return cache;
      inflight ||= refresh().finally(() => { inflight = null; });
      // If we already have something, don't make the caller wait on the network.
      if (cache.items.length && !force) return cache;
      return inflight;
    },
    hasApiKey: Boolean(apiKey),
  };
}

// Choreo — learn any dance from a YouTube link, then battle your friends to it.
//
// The server stays deliberately thin: fetch videos with yt-dlp, serve them with
// range support, cache the pose data the browser extracts, and relay party-room
// messages. All the vision work happens client-side.
import express from 'express';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createTrending } from './trending.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, 'data');
const VIDEOS = path.join(DATA, 'videos');
const POSES = path.join(DATA, 'poses');
const META = path.join(DATA, 'meta');
const SCORES = path.join(DATA, 'scores.json');
const TRENDING = path.join(DATA, 'trending.json');
for (const d of [DATA, VIDEOS, POSES, META]) mkdirSync(d, { recursive: true });

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/videos', express.static(VIDEOS, { acceptRanges: true }));

// In-memory job state; survives only while the server runs. Disk is the real cache.
const jobs = new Map(); // videoId -> { state, progress, error, meta }

const YT_ID = /^[\w-]{11}$/;
function parseYouTubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1, 12);
    if (u.hostname.endsWith('youtube.com')) {
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const m = u.pathname.match(/^\/(shorts|embed)\/([\w-]{11})/);
      if (m) return m[2];
    }
  } catch { /* fall through */ }
  return null;
}

function ytdlp(args) {
  return new Promise((resolve, reject) => {
    execFile('yt-dlp', args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.toString().split('\n').filter(Boolean).pop() || err.message));
      else resolve(stdout);
    });
  });
}

// Rolling feed of dance challenges circulating right now. Keyless by default
// (yt-dlp search); set YOUTUBE_API_KEY for the real "most popular" chart.
const trending = createTrending({ ytdlp, cacheFile: TRENDING });
trending.init().catch(() => {});

app.post('/api/videos', async (req, res) => {
  const id = parseYouTubeId(req.body?.url || '');
  if (!id || !YT_ID.test(id)) return res.status(400).json({ error: 'That does not look like a YouTube link.' });

  const file = path.join(VIDEOS, `${id}.mp4`);
  const metaFile = path.join(META, `${id}.json`);

  if (existsSync(file) && existsSync(metaFile)) {
    const meta = JSON.parse(await readFile(metaFile, 'utf8'));
    jobs.set(id, { state: 'ready', progress: 100, meta });
    return res.json({ id, state: 'ready', meta });
  }
  const existing = jobs.get(id);
  if (existing && (existing.state === 'downloading' || existing.state === 'fetching')) {
    return res.json({ id, state: existing.state });
  }

  jobs.set(id, { state: 'fetching', progress: 0 });
  res.json({ id, state: 'fetching' });

  try {
    const info = JSON.parse(await ytdlp(['-J', '--no-playlist', `https://www.youtube.com/watch?v=${id}`]));
    const meta = {
      id,
      title: info.title,
      channel: info.channel || info.uploader || '',
      duration: info.duration,
      thumbnail: info.thumbnail,
      addedAt: new Date().toISOString(),
    };
    if (info.duration > 15 * 60) {
      jobs.set(id, { state: 'error', error: 'Video is longer than 15 minutes — pick a shorter clip of the routine.' });
      return;
    }
    await writeFile(metaFile, JSON.stringify(meta, null, 2));
    jobs.set(id, { state: 'downloading', progress: 0, meta });

    // Progressive mp4 ≤720p keeps downloads single-file (no ffmpeg merge needed).
    // YouTube hands out an intermittent 403 on the first attempt often enough
    // that a couple of quiet retries are worth more than a good error message.
    const attempt = (left) => {
      const dl = spawn('yt-dlp', [
        '--no-playlist', '--newline',
        '-f', 'best[ext=mp4][height<=720]/best[ext=mp4]/b',
        '-o', file,
        `https://www.youtube.com/watch?v=${id}`,
      ]);
      dl.stdout.on('data', (buf) => {
        const m = buf.toString().match(/\[download\]\s+([\d.]+)%/);
        if (m) {
          const j = jobs.get(id);
          if (j && j.state === 'downloading') j.progress = parseFloat(m[1]);
        }
      });
      let errTail = '';
      dl.stderr.on('data', (buf) => { errTail = (errTail + buf.toString()).slice(-500); });
      dl.on('close', (code) => {
        if (code === 0 && existsSync(file)) return jobs.set(id, { state: 'ready', progress: 100, meta });
        if (left > 0) return setTimeout(() => attempt(left - 1), 1200);
        jobs.set(id, { state: 'error', error: errTail.split('\n').filter(Boolean).pop() || 'Download failed.' });
      });
    };
    attempt(2);
  } catch (e) {
    jobs.set(id, { state: 'error', error: e.message });
  }
});

app.get('/api/videos/:id/status', (req, res) => {
  const { id } = req.params;
  const job = jobs.get(id);
  if (job) return res.json({ id, ...job });
  if (existsSync(path.join(VIDEOS, `${id}.mp4`))) return res.json({ id, state: 'ready', progress: 100 });
  res.json({ id, state: 'unknown' });
});

// Pose cache — extracted once in the browser, shared by every later visit.
app.get('/api/videos/:id/poses', async (req, res) => {
  const f = path.join(POSES, `${req.params.id}.json`);
  if (!existsSync(f)) return res.status(404).json({ error: 'not extracted yet' });
  res.type('json').send(await readFile(f, 'utf8'));
});
app.post('/api/videos/:id/poses', async (req, res) => {
  const { id } = req.params;
  if (!YT_ID.test(id)) return res.status(400).json({ error: 'bad id' });
  await writeFile(path.join(POSES, `${id}.json`), JSON.stringify(req.body));
  res.json({ ok: true });
});

// Library of everything processed so far.
app.get('/api/library', async (_req, res) => {
  const files = (await readdir(META)).filter((f) => f.endsWith('.json'));
  const items = [];
  for (const f of files) {
    try {
      const meta = JSON.parse(await readFile(path.join(META, f), 'utf8'));
      if (existsSync(path.join(VIDEOS, `${meta.id}.mp4`))) {
        meta.hasPoses = existsSync(path.join(POSES, `${meta.id}.json`));
        items.push(meta);
      }
    } catch { /* skip corrupt */ }
  }
  items.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
  res.json(items);
});

// What's circulating now — the feed the home screen opens on.
app.get('/api/trending', async (_req, res) => {
  try {
    const { items, at } = await trending.get();
    res.json({ items, updatedAt: at, live: trending.hasApiKey });
  } catch {
    res.json({ items: [], updatedAt: 0, live: false });
  }
});

// Related routines: other people's takes on the same song, so you can find a
// tutorial that breaks the move down slower than the original did.
app.get('/api/videos/:id/similar', async (req, res) => {
  const metaFile = path.join(META, `${req.params.id}.json`);
  if (!existsSync(metaFile)) return res.json([]);
  const meta = JSON.parse(await readFile(metaFile, 'utf8'));
  // Strip the noise creators put in titles so the query is just song + intent.
  const stem = meta.title
    .replace(/[([].*?[)\]]/g, ' ')
    .replace(/\b(official|video|dance|cover|choreography|choreo|4k|hd|mv)\b/gi, ' ')
    .replace(/[|\-–—].*$/, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  try {
    const out = await ytdlp([
      '--flat-playlist', '-J', '--playlist-end', '12',
      `ytsearch12:${stem} dance tutorial slow mirrored`,
    ]);
    const entries = JSON.parse(out).entries || [];
    res.json(entries
      .filter((e) => e.id && e.id !== meta.id && (e.duration || 0) < 20 * 60)
      .slice(0, 8)
      .map((e) => ({
        id: e.id,
        title: e.title,
        channel: e.channel || e.uploader || '',
        duration: e.duration,
        thumbnail: e.thumbnails?.[e.thumbnails.length - 1]?.url || `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
      })));
  } catch {
    res.json([]); // search is a nicety, never an error the user should see
  }
});

// ---------- scores ----------
async function readScores() {
  try { return JSON.parse(await readFile(SCORES, 'utf8')); } catch { return {}; }
}
app.get('/api/scores/:id', async (req, res) => {
  const all = await readScores();
  res.json((all[req.params.id] || []).slice(0, 20));
});
app.post('/api/scores/:id', async (req, res) => {
  const { id } = req.params;
  if (!YT_ID.test(id)) return res.status(400).json({ error: 'bad id' });
  const { name, score, accuracy, mode } = req.body || {};
  if (typeof score !== 'number') return res.status(400).json({ error: 'bad score' });
  const all = await readScores();
  const list = all[id] || [];
  list.push({
    name: String(name || 'Anonymous').slice(0, 24),
    score: Math.round(score),
    accuracy: Math.round(accuracy || 0),
    mode: mode === 'party' ? 'party' : 'solo',
    at: new Date().toISOString(),
  });
  list.sort((a, b) => b.score - a.score);
  all[id] = list.slice(0, 50);
  await writeFile(SCORES, JSON.stringify(all, null, 2));
  res.json(all[id].slice(0, 20));
});

// Spotify uses PKCE, so the browser needs only a client id — no secret ever
// touches this server. Set SPOTIFY_CLIENT_ID, or let each user paste their own.
app.get('/api/config', (_req, res) => {
  res.json({ spotifyClientId: process.env.SPOTIFY_CLIENT_ID || null });
});

const server = createServer(app);

// ---------- party rooms ----------
// A room is ephemeral: it lives as long as someone is in it. The host's client
// decides what's playing; the server only relays and tallies.
const rooms = new Map(); // code -> { code, videoId, hostId, players: Map, state, startAt }

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 — safe to read aloud
function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

const wss = new WebSocketServer({ server, path: '/party' });

function roomPayload(room) {
  return {
    code: room.code,
    videoId: room.videoId,
    videoTitle: room.videoTitle,
    hostId: room.hostId,
    state: room.state,
    startAt: room.startAt,
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, avatar: p.avatar, ready: p.ready,
      score: p.score, combo: p.combo, best: p.best, done: p.done, accuracy: p.accuracy,
    })),
  };
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.ws.readyState === 1) p.ws.send(data);
  }
}
const sync = (room) => broadcast(room, { type: 'room', room: roomPayload(room) });

let nextId = 1;

wss.on('connection', (ws) => {
  const player = {
    id: `p${nextId++}`, ws, name: 'Dancer', avatar: '💃',
    ready: false, score: 0, combo: 0, best: 0, accuracy: 0, done: false,
  };
  let room = null;
  const send = (msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };

  const leave = () => {
    if (!room) return;
    room.players.delete(player.id);
    if (room.players.size === 0) {
      rooms.delete(room.code);
    } else {
      // Hosting passes to whoever has been in the room longest.
      if (room.hostId === player.id) room.hostId = room.players.keys().next().value;
      sync(room);
    }
    room = null;
  };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const identify = () => {
      player.name = String(msg.name || 'Dancer').slice(0, 20);
      player.avatar = String(msg.avatar || '💃').slice(0, 4);
    };

    switch (msg.type) {
      case 'create': {
        leave();
        identify();
        const code = newCode();
        room = {
          code, videoId: msg.videoId || null, videoTitle: msg.videoTitle || '',
          hostId: player.id, players: new Map(), state: 'lobby', startAt: 0,
        };
        room.players.set(player.id, player);
        rooms.set(code, room);
        send({ type: 'joined', you: player.id, code });
        sync(room);
        break;
      }
      case 'join': {
        const target = rooms.get(String(msg.code || '').toUpperCase());
        if (!target) return send({ type: 'error', error: 'No room with that code.' });
        if (target.players.size >= 12) return send({ type: 'error', error: 'That room is full — 12 dancers max.' });
        leave();
        identify();
        room = target;
        room.players.set(player.id, player);
        send({ type: 'joined', you: player.id, code: room.code });
        sync(room);
        break;
      }
      case 'setVideo': {
        if (!room || room.hostId !== player.id) return;
        room.videoId = msg.videoId;
        room.videoTitle = msg.videoTitle || '';
        for (const p of room.players.values()) p.ready = false;
        sync(room);
        break;
      }
      case 'ready': {
        if (!room) return;
        player.ready = !!msg.ready;
        sync(room);
        break;
      }
      case 'start': {
        if (!room || room.hostId !== player.id || !room.videoId) return;
        for (const p of room.players.values()) { p.score = 0; p.combo = 0; p.best = 0; p.done = false; }
        room.state = 'dancing';
        // Everyone counts in off the same wall clock; 5 s absorbs WS jitter and
        // covers the "3, 2, 1" the client draws.
        room.startAt = Date.now() + 5000;
        sync(room);
        break;
      }
      case 'score': {
        if (!room) return;
        player.score = Math.max(0, Math.round(msg.score || 0));
        player.combo = Math.max(0, Math.round(msg.combo || 0));
        player.best = Math.max(player.best, player.combo);
        broadcast(room, { type: 'tick', id: player.id, score: player.score, combo: player.combo });
        break;
      }
      case 'finish': {
        if (!room) return;
        player.done = true;
        player.score = Math.max(0, Math.round(msg.score ?? player.score));
        player.accuracy = Math.round(msg.accuracy || 0);
        if ([...room.players.values()].every((p) => p.done)) room.state = 'results';
        sync(room);
        break;
      }
      case 'again': {
        if (!room || room.hostId !== player.id) return;
        room.state = 'lobby';
        for (const p of room.players.values()) { p.ready = false; p.done = false; p.score = 0; p.combo = 0; }
        sync(room);
        break;
      }
      case 'react': {
        if (!room) return;
        broadcast(room, { type: 'react', id: player.id, emoji: String(msg.emoji || '🔥').slice(0, 4) });
        break;
      }
      case 'leave':
        leave();
        break;
    }
  });

  ws.on('close', leave);
  ws.on('error', leave);
});

const PORT = process.env.PORT || 4173;
server.listen(PORT, () => console.log(`Choreo running on http://localhost:${PORT}`));

// Shadow — app shell. Hash routing, four screens, one WebSocket.

import { extractPoses } from './pose.js';
import { drawStickman, segmentSteps, weakestStep } from './stickman.js';
import { Studio } from './studio.js';
import { Battle } from './battle.js';
import { Party } from './party.js';
import * as spotify from './spotify.js';
import { recordSession } from './fitness.js';
import { h, $, clear, fmtTime, toast, confetti, store, beep } from './ui.js';

const bodyWeightKg = () => Number(store.get('weightKg', 65)) || 65;

const app = $('#app');
const party = new Party();
let config = {};

// Party events are wired exactly once. Screens register what they want to do
// with each event here; without this, every navigation would stack another
// listener on the same socket.
const partyScreen = { room: null, tick: null };
party.on('room', (m) => {
  const room = party.room;
  if (room?.state === 'dancing' && !location.hash.startsWith('#/battle')) {
    partyStart = room.startAt;
    location.hash = `#/battle/${room.videoId}?party=1`;
    return;
  }
  partyScreen.room?.(m);
});
party.on('tick', (m) => partyScreen.tick?.(m));
party.on('error', (m) => toast(m.error, 'bad'));
party.on('joined', () => {
  if (location.hash.startsWith('#/party')) history.replaceState({}, '', `#/party/${party.code}`);
});

const identity = () => ({
  name: store.get('name', '') || 'Dancer',
  avatar: store.get('avatar', '💃'),
});

// ---------- shared chrome ----------
function shell(...children) {
  const me = identity();
  return h('div', { class: 'page' },
    h('nav', { class: 'nav' },
      h('a', { class: 'brand', href: '#/' }, h('b', {}, 'Shadow'), h('i', {}, 'learn the move')),
      h('div', { class: 'nav-right' },
        h('a', { class: 'nav-link', href: '#/party' }, 'Party'),
        h('a', { class: 'nav-link', href: '#/settings' }, 'Settings'),
        h('span', { class: 'nav-me', title: me.name }, me.avatar),
      ),
    ),
    h('main', {}, ...children),
  );
}

function render(node) {
  clear(app).append(node);
  scrollTo(0, 0);
}

// ---------- pipeline: link → video → poses ----------
async function ensureVideo(url, onStatus) {
  const res = await fetch('/api/videos', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
  });
  const first = await res.json();
  if (first.error) throw new Error(first.error);
  const id = first.id;
  if (first.state === 'ready') return id;

  for (;;) {
    await new Promise((r) => setTimeout(r, 700));
    const s = await (await fetch(`/api/videos/${id}/status`)).json();
    if (s.state === 'error') throw new Error(s.error || 'Could not fetch that video.');
    if (s.state === 'ready') return id;
    onStatus?.(s);
  }
}

async function ensurePoses(id, ui) {
  const cached = await fetch(`/api/videos/${id}/poses`);
  if (cached.ok) return cached.json();

  // Nobody has watched this one yet, so we extract here and hand the result
  // back to the server — the next person gets it instantly.
  //
  // The element has to stay visible while it plays: browsers pause muted,
  // video-only playback that they consider backgrounded, which would truncate
  // the extraction with no error. Showing the work is the honest fix, and it is
  // the best thirty seconds of the product anyway — you watch the skeleton
  // assemble itself over the dancer.
  const v = h('video', { src: `/videos/${id}.mp4`, playsinline: true, muted: true, class: 'peek-video' });
  const peek = ui.peek(v);
  await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('Video would not load.')); });
  try {
    const pose = await extractPoses(v, (p, lm) => {
      ui.say('Watching the dancer, frame by frame…', 0.3 + p * 0.65);
      peek.draw(lm);
    });
    fetch(`/api/videos/${id}/poses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pose),
    }).catch(() => {});
    return pose;
  } finally {
    peek.remove();
  }
}

function loadingScreen(title) {
  const label = h('p', { class: 'load-label' }, 'Starting up…');
  const fill = h('i');
  const figure = h('div', { class: 'load-figure' }, h('span', {}, '🕺'));
  const node = shell(h('div', { class: 'loading' },
    figure,
    h('h1', {}, title),
    label,
    h('div', { class: 'load-bar' }, fill),
    h('p', { class: 'muted small' }, 'Pose tracking runs on your machine, in this tab. A routine is read once and then cached for everyone who opens it after you.'),
  ));
  render(node);

  return {
    say(text, pct) {
      label.textContent = text;
      if (pct != null) fill.style.width = `${Math.round(pct * 100)}%`;
    },
    // Swaps the bobbing emoji for the video being read, with the skeleton drawn
    // on top as it is found.
    peek(video) {
      const canvas = h('canvas', { class: 'peek-canvas' });
      const box = h('div', { class: 'peek' }, video, canvas);
      figure.replaceWith(box);
      const ctx = canvas.getContext('2d');
      return {
        draw(lm) {
          const r = box.getBoundingClientRect();
          const dpr = Math.min(devicePixelRatio || 1, 2);
          if (canvas.width !== r.width * dpr) {
            canvas.width = r.width * dpr; canvas.height = r.height * dpr;
          }
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, r.width, r.height);
          if (lm) drawStickman(ctx, lm, { W: r.width, H: r.height, color: '#faf5ec', lineWidth: Math.max(3, r.width * 0.014) });
        },
        remove() { box.replaceWith(figure); video.pause(); video.removeAttribute('src'); },
      };
    },
  };
}

// Everything a screen needs about a routine, fetched once.
const metaCache = new Map();
async function loadRoutine(id, ui) {
  let meta = metaCache.get(id);
  if (!meta) {
    const lib = await (await fetch('/api/library')).json();
    meta = lib.find((m) => m.id === id);
    if (meta) metaCache.set(id, meta);
  }
  if (!meta) throw new Error('That routine is not in the library yet — paste its link on the home screen.');
  ui.say('Loading the pose model…', 0.25);
  const pose = await ensurePoses(id, ui);
  return { meta, pose };
}

// ---------- home ----------
async function viewHome() {
  const input = h('input', {
    class: 'link-input', type: 'url', placeholder: 'Paste a YouTube link — a routine, a Short, a hookstep',
    spellcheck: 'false', autocomplete: 'off',
  });
  const go = h('button', { class: 'btn primary big' }, 'Break it down');
  const form = h('form', { class: 'link-form', onsubmit: (e) => { e.preventDefault(); openLink(input.value); } }, input, go);

  const libGrid = h('div', { class: 'lib-grid' });
  const suggestBox = h('div', { class: 'suggest' });
  const trendingBox = h('div', { class: 'trending' });

  const node = shell(
    h('section', { class: 'hero' },
      h('h1', {},
        'Any dance. ', h('em', {}, 'Any link.'), h('br'), 'Learn it. Battle it. Break a sweat.',
      ),
      h('p', { class: 'lede' },
        'Shadow watches the video, strips the dancer down to a stickman, and finds the phrase the routine keeps repeating. You loop it at your own speed — then it turns on your camera, scores you move for move, and counts the calories while you go.',
      ),
      form,
      h('div', { class: 'hero-row' },
        h('a', { class: 'btn ghost', href: '#/party' }, '👯 Start a party'),
        h('span', { class: 'muted small' }, 'Up to 12 phones, one routine, one leaderboard.'),
      ),
    ),
    fitnessStrip(),
    trendingBox,
    h('section', { class: 'features' },
      feature('★', 'Hookstep finder', 'It finds the repeated phrase on its own — the eight counts everyone actually knows.'),
      feature('🕺', 'Stickman mode', 'No outfit, no crowd, no camera swing. Just the shape your body has to make.'),
      feature('🎯', 'Scored live', 'Your webcam pose against theirs, bone by bone. PERFECT, GREAT, or check your left arm.'),
      feature('👯', 'Party rooms', 'Four-letter code. Everyone dances the same routine on their own screen. Podium at the end.'),
    ),
    suggestBox,
    h('section', { class: 'library' }, h('h2', {}, 'Your studio'), libGrid),
  );
  render(node);

  fetch('/api/library').then((r) => r.json()).then((items) => {
    clear(libGrid);
    if (!items.length) {
      libGrid.append(h('p', { class: 'muted' }, 'Nothing here yet. Paste a link above and it lands in your studio.'));
      return;
    }
    for (const m of items) {
      metaCache.set(m.id, m);
      libGrid.append(h('article', { class: 'lib-card' },
        h('button', { class: 'lib-thumb', onclick: () => (location.hash = `#/learn/${m.id}`) },
          h('img', { src: m.thumbnail, alt: '', loading: 'lazy' }),
          m.hasPoses ? h('span', { class: 'badge' }, 'ready') : h('span', { class: 'badge dim' }, 'needs a pass'),
        ),
        h('h3', {}, m.title),
        h('p', { class: 'muted small' }, m.channel, ' · ', fmtTime(m.duration)),
        h('div', { class: 'lib-actions' },
          h('a', { class: 'btn tiny', href: `#/learn/${m.id}` }, 'Learn'),
          h('a', { class: 'btn tiny ghost', href: `#/battle/${m.id}` }, 'Battle'),
        ),
      ));
    }
  });

  paintSuggestions(suggestBox);
  paintTrending(trendingBox);
}

// The workout at a glance — only once there's a history to show, so a first-time
// visitor isn't met with a wall of zeroes.
function fitnessStrip() {
  const f = JSON.parse(localStorage.getItem('shadow.fitness.v1') || '{}');
  if (!f.sessions) return null;
  const mins = Math.round((f.totalSeconds || 0) / 60);
  return h('section', { class: 'fit-strip' },
    stat('🔥', f.streak || 0, (f.streak === 1 ? 'day' : 'days') + ' in a row'),
    stat('⚡', Math.round(f.totalKcal || 0), 'kcal burned'),
    stat('⏱', mins, mins === 1 ? 'active minute' : 'active minutes'),
    stat('🏅', f.sessions || 0, f.sessions === 1 ? 'routine danced' : 'routines danced'),
  );
}
function stat(icon, value, label) {
  return h('div', { class: 'fit-stat' },
    h('span', { class: 'fit-icon' }, icon),
    h('b', {}, value.toLocaleString()),
    h('small', {}, label),
  );
}

// Trending: the auto-updating feed. Cards open the same pipeline as pasting a
// link — tap one and it downloads, extracts, and drops you in the studio.
async function paintTrending(box) {
  clear(box);
  box.append(h('div', { class: 'section-head' },
    h('h2', {}, 'Trending now'),
    h('span', { class: 'muted small' }, 'Dance challenges going around this week'),
  ));
  const grid = h('div', { class: 'trend-grid' });
  box.append(grid, h('p', { class: 'muted small load-note' }, 'Pulling the latest…'));
  try {
    const { items } = await (await fetch('/api/trending')).json();
    box.querySelector('.load-note')?.remove();
    if (!items?.length) { box.remove(); return; }
    for (const it of items) {
      grid.append(h('button', {
        class: 'trend-card',
        onclick: () => openLink(`https://www.youtube.com/watch?v=${it.id}`),
      },
        h('img', { src: it.thumbnail, alt: '', loading: 'lazy' }),
        h('span', { class: 'trend-title' }, it.title),
        h('span', { class: 'trend-meta' }, it.channel || 'YouTube', it.duration ? ` · ${fmtTime(it.duration)}` : ''),
      ));
    }
  } catch {
    box.remove(); // the feed is a bonus, never a blocker
  }
}

function feature(icon, title, body) {
  return h('div', { class: 'feature' }, h('span', { class: 'f-icon' }, icon), h('h3', {}, title), h('p', {}, body));
}

async function paintSuggestions(box) {
  clear(box);
  if (!spotify.isConnected()) {
    box.append(h('div', { class: 'spotify-cta' },
      h('div', {},
        h('h3', {}, 'Dance to what you actually listen to'),
        h('p', { class: 'muted' }, 'Connect Spotify and Shadow pulls your rotation, then points you at routines for the songs already stuck in your head.'),
      ),
      h('a', { class: 'btn ghost', href: '#/settings' }, 'Connect Spotify'),
    ));
    return;
  }
  const p = await spotify.profile();
  if (!p) return;
  const v = spotify.vibe(p);
  box.append(h('section', { class: 'suggest-inner' },
    h('div', { class: 'suggest-head' },
      p.image ? h('img', { class: 'avatar', src: p.image, alt: '' }) : null,
      h('div', {},
        h('h2', {}, `On rotation for ${p.name}`),
        h('p', { class: 'muted' }, v ? `Your month has been very ${v.toLowerCase()}. Here's what to learn.` : 'Here is what to learn next.'),
      ),
    ),
    h('div', { class: 'suggest-grid' }, ...spotify.suggestions(p).map((s) => h('a', {
      class: 'suggest-card', href: s.search, target: '_blank', rel: 'noreferrer',
      title: 'Opens YouTube — copy a routine link and paste it above',
    },
      s.image ? h('img', { src: s.image, alt: '' }) : null,
      h('span', { class: 'sug-name' }, s.name),
      h('span', { class: 'sug-artist' }, s.artist),
      h('span', { class: 'sug-go' }, 'find a routine →'),
    ))),
  ));
}

async function openLink(url) {
  if (!url?.trim()) return;
  const ui = loadingScreen('Fetching the routine');
  try {
    const id = await ensureVideo(url.trim(), (s) => {
      ui.say(s.state === 'downloading' ? `Downloading — ${Math.round(s.progress || 0)}%` : 'Asking YouTube nicely…',
        (s.progress || 0) / 100 * 0.3);
    });
    location.hash = `#/learn/${id}`;
  } catch (e) {
    toast(e.message, 'bad');
    location.hash = '#/';
  }
}

// ---------- learn ----------
let teardown = null;
async function viewLearn(id) {
  const ui = loadingScreen('Reading the choreography');
  try {
    const { meta, pose } = await loadRoutine(id, ui);
    const studio = Studio({
      meta, pose,
      onBattle: (region) => { sessionStorage.setItem('shadow.region', JSON.stringify(region)); location.hash = `#/battle/${id}`; },
      onOpen: (url) => openLink(url),
    });
    teardown = () => studio.destroy();
    render(shell(studio.el));
  } catch (e) {
    toast(e.message, 'bad');
    location.hash = '#/';
  }
}

// ---------- battle ----------
async function viewBattle(id, { partyMode = false, startAt = 0 } = {}) {
  const ui = loadingScreen('Setting the stage');
  let meta, pose;
  try {
    ({ meta, pose } = await loadRoutine(id, ui));
  } catch (e) {
    toast(e.message, 'bad');
    location.hash = '#/';
    return;
  }

  let region = [0, pose.duration || meta.duration];
  try {
    const saved = JSON.parse(sessionStorage.getItem('shadow.region') || 'null');
    if (Array.isArray(saved) && !partyMode) region = saved;
  } catch { /* ignore */ }
  if (partyMode) {
    // Everyone must dance the same bars, so party runs use the hook if there is
    // one and the whole clip otherwise — never a per-device selection.
    const { findHook } = await import('./hook.js');
    const { hook } = findHook(pose.frames, pose.duration || meta.duration);
    if (hook) region = [hook.start, Math.min(hook.end + (hook.end - hook.start) * 2, pose.duration)];
  }

  const stage = h('div', { class: 'battle-mount' });
  const roster = h('div', { class: 'battle-roster' });
  render(shell(h('div', { class: 'battle' },
    h('header', { class: 'battle-head' },
      h('div', {}, h('h1', {}, meta.title), h('p', { class: 'muted small' }, `${fmtTime(region[0])} – ${fmtTime(region[1])}`)),
      h('button', { class: 'btn ghost tiny', onclick: () => history.back() }, 'Leave'),
    ),
    stage,
    partyMode ? roster : null,
  )));

  // The same auto-cut steps the studio shows, trimmed to the bars being danced,
  // so the results can say which step to go back and drill.
  const steps = segmentSteps(pose.frames, pose.duration || meta.duration)
    .map((s) => ({ ...s, start: Math.max(s.start, region[0]), end: Math.min(s.end, region[1]) }))
    .filter((s) => s.end - s.start > 0.3);

  const b = new Battle({
    mount: stage, frames: pose.frames, videoUrl: `/videos/${id}.mp4`, region, mirror: true, steps,
    aspect: pose.aspect || 16 / 9, weightKg: bodyWeightKg(),
    onTick: ({ score, combo }) => { if (partyMode) party.tick(score, combo); },
    onEnd: (result) => finishBattle(id, meta, result, partyMode),
  });
  teardown = () => b.stop();

  try {
    await b.mountUI();
  } catch (e) {
    toast(e.name === 'NotAllowedError'
      ? 'Shadow needs the camera to score you. Allow it and reload.'
      : `Camera trouble: ${e.message}`, 'bad');
    location.hash = `#/learn/${id}`;
    return;
  }

  if (partyMode) {
    const paint = () => {
      clear(roster);
      const players = [...(party.room?.players || [])].sort((x, y) => y.score - x.score);
      players.forEach((p, i) => roster.append(h('div', { class: `roster-row${p.id === party.you ? ' you' : ''}` },
        h('b', {}, `${i + 1}`), h('span', { class: 'ava' }, p.avatar), h('span', { class: 'nm' }, p.name),
        h('span', { class: 'sc' }, p.score.toLocaleString()),
      )));
    };
    partyScreen.room = paint;
    // Re-rank on every score packet, not only on full room syncs.
    partyScreen.tick = (m) => {
      const p = party.room?.players.find((x) => x.id === m.id);
      if (p) { p.score = m.score; p.combo = m.combo; }
      paint();
    };
    paint();
  }

  await b.start(startAt || 0);
}

async function finishBattle(id, meta, result, partyMode) {
  const me = identity();
  if (partyMode) party.finish(result.score, result.accuracy);
  if (result.rank === 'S' || result.rank === 'A') confetti();
  beep(880, 0.12, 0.1, 'triangle');

  // Log the workout: calories toward lifetime totals, and today toward the
  // streak. Done before the board fetch so the number is ready to show.
  const fit = recordSession({ kcal: result.kcal || 0, seconds: result.activeSeconds || 0, intensity: result.intensity || 0 });

  let board = [];
  try {
    board = await (await fetch(`/api/scores/${id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: me.name, score: result.score, accuracy: result.accuracy, mode: partyMode ? 'party' : 'solo' }),
    })).json();
  } catch { /* leaderboard is a bonus */ }

  const card = h('div', { class: `scorecard rank-${result.rank}` },
    h('div', { class: 'rank' }, result.rank),
    h('div', { class: 'sc-body' },
      h('h1', {}, result.score.toLocaleString()),
      h('p', { class: 'muted' }, `${result.accuracy}% match · best combo ${result.bestCombo}`),
      h('div', { class: 'burn-row' },
        h('span', { class: 'burn-chip' }, h('b', {}, `${(result.kcal || 0).toFixed(0)}`), ' kcal'),
        h('span', { class: 'burn-chip' }, result.intensityLabel || 'light'),
        fit.streakChanged
          ? h('span', { class: 'burn-chip streak' }, `🔥 ${fit.streak}-day streak`)
          : h('span', { class: 'burn-chip' }, `🔥 ${fit.streak}-day streak`),
      ),
      h('div', { class: 'tally' }, ...Object.entries(result.tally).map(([k, v]) =>
        h('span', { class: `t ${k.toLowerCase()}` }, h('b', {}, v), k))),
    ),
  );

  const steps = result.steps || [];
  const weakest = weakestStep(steps);
  const drill = (s) => {
    sessionStorage.setItem('shadow.studioRegion', JSON.stringify([s.start, s.end]));
    location.hash = `#/learn/${id}`;
  };
  const stepReport = steps.length > 1 ? h('section', { class: 'step-report' },
    h('h2', {}, 'Step by step'),
    weakest ? h('p', { class: 'muted small' },
      `Work on ${weakest.label}`, weakest.worst ? ` — mostly your ${weakest.worst}.` : '.') : null,
    h('ol', {}, ...steps.map((s) => {
      const pct = s.accuracy ?? 0;
      const tone = s.accuracy == null ? 'none' : pct >= 72 ? 'good' : pct >= 45 ? 'warn' : 'bad';
      return h('li', { class: `step-row ${tone}${s === weakest ? ' weakest' : ''}` },
        h('span', { class: 'lbl' }, s.label, h('small', {}, `${fmtTime(s.start)}–${fmtTime(s.end)}`)),
        h('span', { class: 'bar' }, h('i', { style: `width:${pct}%` })),
        h('b', {}, s.accuracy == null ? '—' : `${s.accuracy}%`),
        h('small', { class: 'why' }, s.accuracy == null ? 'not seen' : s.worst ? s.worst : ''),
        h('button', { class: 'btn tiny ghost', onclick: () => drill(s) }, 'Drill'),
      );
    })),
  ) : null;

  render(shell(h('div', { class: 'results' },
    h('p', { class: 'eyebrow' }, meta.title),
    card,
    stepReport,
    board.length ? h('section', { class: 'board' },
      h('h2', {}, 'Best on this routine'),
      h('ol', {}, ...board.slice(0, 8).map((r) => h('li', {},
        h('span', {}, r.name), h('b', {}, r.score.toLocaleString()), h('small', {}, `${r.accuracy}%`)))),
    ) : null,
    h('div', { class: 'result-actions' },
      h('a', { class: 'btn primary', href: `#/battle/${id}` }, 'Run it back'),
      h('a', { class: 'btn ghost', href: `#/learn/${id}` }, 'Back to the studio'),
      partyMode ? h('a', { class: 'btn ghost', href: '#/party' }, 'Party lobby') : null,
    ),
  )));
}

// ---------- party ----------
function viewParty(code) {
  party.connect();
  const me = identity();

  const body = h('div', { class: 'party' });
  render(shell(body));

  const paint = () => {
    clear(body);
    const room = party.room;

    if (!room) {
      const codeInput = h('input', { class: 'code-input', placeholder: 'CODE', maxlength: '4', autocapitalize: 'characters' });
      body.append(h('div', { class: 'party-entry' },
        h('h1', {}, 'Dance together'),
        h('p', { class: 'lede' }, 'One person starts a room and reads out four letters. Everyone else joins on their own phone or laptop, and you all dance the same hookstep at the same moment. Loudest room wins.'),
        h('div', { class: 'party-you' },
          h('span', { class: 'ava big' }, me.avatar),
          h('div', {}, h('b', {}, me.name), h('a', { class: 'muted small', href: '#/settings' }, ' change')),
        ),
        h('div', { class: 'party-actions' },
          h('button', { class: 'btn primary big', onclick: () => pickRoutineThen((id, title) => party.create(identity(), id, title)) }, 'Start a room'),
          h('form', { class: 'join-form', onsubmit: (e) => { e.preventDefault(); party.join(codeInput.value, identity()); } },
            codeInput, h('button', { class: 'btn' }, 'Join')),
        ),
      ));
      return;
    }

    if (room.state === 'lobby') {
      body.append(h('div', { class: 'lobby' },
        h('div', { class: 'lobby-code' }, h('small', {}, 'Room code'), h('b', {}, room.code)),
        h('p', { class: 'muted' }, room.videoTitle || 'No routine picked yet.'),
        h('div', { class: 'lobby-grid' }, ...room.players.map((p) => h('div', { class: `lp${p.ready ? ' ready' : ''}` },
          h('span', { class: 'ava big' }, p.avatar),
          h('b', {}, p.name),
          h('small', {}, p.id === room.hostId ? 'host' : p.ready ? 'ready' : 'waiting'),
        ))),
        h('div', { class: 'lobby-actions' },
          party.isHost ? h('button', { class: 'btn', onclick: () => pickRoutineThen((id, title) => party.setVideo(id, title)) }, 'Pick routine') : null,
          h('button', {
            class: `btn ${party.me?.ready ? 'ghost' : 'primary'}`,
            onclick: () => party.ready(!party.me?.ready),
          }, party.me?.ready ? "I'm not ready" : "I'm ready"),
          party.isHost ? h('button', {
            class: 'btn primary',
            disabled: !room.videoId || !room.players.every((p) => p.ready),
            onclick: () => party.start(),
          }, 'Start the battle') : h('span', { class: 'muted small' }, 'Waiting for the host…'),
          h('button', { class: 'btn ghost tiny', onclick: () => { party.leave(); paint(); } }, 'Leave'),
        ),
      ));
      return;
    }

    if (room.state === 'results') {
      const ranked = [...room.players].sort((a, b) => b.score - a.score);
      confetti();
      body.append(h('div', { class: 'podium-wrap' },
        h('h1', {}, 'Final call'),
        h('ol', { class: 'podium' }, ...ranked.map((p, i) => h('li', { class: `place p${i + 1}${p.id === party.you ? ' you' : ''}` },
          h('span', { class: 'ava big' }, p.avatar),
          h('b', {}, p.name),
          h('span', { class: 'sc' }, (p.score || 0).toLocaleString()),
          h('small', {}, `${p.accuracy || 0}% match`),
        ))),
        h('div', { class: 'lobby-actions' },
          party.isHost ? h('button', { class: 'btn primary', onclick: () => party.again() }, 'Go again') : h('span', { class: 'muted small' }, 'Host can restart.'),
          h('button', { class: 'btn ghost', onclick: () => { party.leave(); paint(); } }, 'Leave room'),
        ),
      ));
    }
  };

  partyScreen.room = paint;
  if (code && (!party.room || party.room.code !== code.toUpperCase())) party.join(code, identity());
  paint();
}

let partyStart = 0;

// Picking a routine mid-party: reuse the library rather than making the host
// leave the room to paste a link.
async function pickRoutineThen(cb) {
  const items = await (await fetch('/api/library')).json();
  const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) overlay.remove(); } });
  const input = h('input', { class: 'link-input', placeholder: 'or paste a YouTube link' });
  overlay.append(h('div', { class: 'sheet' },
    h('h2', {}, 'Pick the routine'),
    h('form', {
      class: 'link-form small',
      onsubmit: async (e) => {
        e.preventDefault();
        overlay.remove();
        const ui = loadingScreen('Fetching the routine');
        try {
          const id = await ensureVideo(input.value, (s) => ui.say(`Downloading — ${Math.round(s.progress || 0)}%`, (s.progress || 0) / 100));
          const lib = await (await fetch('/api/library')).json();
          cb(id, lib.find((m) => m.id === id)?.title || '');
        } catch (err) { toast(err.message, 'bad'); }
        location.hash = '#/party';
      },
    }, input, h('button', { class: 'btn primary' }, 'Use it')),
    h('div', { class: 'sheet-grid' }, ...items.map((m) => h('button', {
      class: 'sheet-card', onclick: () => { overlay.remove(); cb(m.id, m.title); },
    }, h('img', { src: m.thumbnail, alt: '' }), h('span', {}, m.title)))),
  ));
  document.body.append(overlay);
}

// ---------- settings ----------
async function viewSettings() {
  const me = identity();
  const nameInput = h('input', { class: 'text-input', value: me.name, placeholder: 'Your name' });
  const avatars = ['💃', '🕺', '🦵', '🔥', '🌀', '👑', '🐆', '🎧', '🫧', '⚡'];
  let avatar = me.avatar;
  const avaRow = h('div', { class: 'ava-row' }, ...avatars.map((a) => {
    const b = h('button', { class: `ava-pick${a === avatar ? ' on' : ''}`, onclick: () => {
      avatar = a; store.set('avatar', a);
      avaRow.querySelectorAll('.ava-pick').forEach((x) => x.classList.toggle('on', x.textContent === a));
    } }, a);
    return b;
  }));
  nameInput.addEventListener('input', () => store.set('name', nameInput.value.slice(0, 20)));

  const clientInput = h('input', {
    class: 'text-input', value: localStorage.getItem('shadow.spotify.clientId') || '',
    placeholder: 'Spotify client ID',
  });

  const spotifyBox = h('div', { class: 'card' });
  const paintSpotify = async () => {
    clear(spotifyBox);
    if (spotify.isConnected()) {
      const p = await spotify.profile();
      spotifyBox.append(
        h('div', { class: 'sp-row' },
          p?.image ? h('img', { class: 'avatar', src: p.image, alt: '' }) : h('span', { class: 'ava big' }, '🎧'),
          h('div', {}, h('b', {}, p?.name || 'Connected'),
            h('p', { class: 'muted small' }, p?.artists?.length ? `Top right now: ${p.artists.slice(0, 3).map((a) => a.name).join(', ')}` : 'Connected.')),
          h('button', { class: 'btn ghost tiny', onclick: () => { spotify.logout(); paintSpotify(); } }, 'Disconnect'),
        ),
      );
      return;
    }
    spotifyBox.append(
      h('p', { class: 'muted' },
        'Shadow talks to Spotify straight from your browser using PKCE — there is no server secret and your token never leaves this device. ',
        config.spotifyClientId ? '' : 'Create an app at developer.spotify.com, add ',
        config.spotifyClientId ? '' : h('code', {}, `${location.origin}/`),
        config.spotifyClientId ? '' : ' as a redirect URI, and paste the client ID here.',
      ),
      config.spotifyClientId ? null : h('div', { class: 'row' }, clientInput,
        h('button', { class: 'btn', onclick: () => { spotify.setClientId(clientInput.value); toast('Saved.'); paintSpotify(); } }, 'Save')),
      h('button', {
        class: 'btn primary', disabled: !spotify.clientId(),
        onclick: () => spotify.login().catch((e) => toast(e.message, 'bad')),
      }, 'Connect Spotify'),
    );
  };
  await paintSpotify();

  const weightInput = h('input', {
    class: 'text-input narrow', type: 'number', min: '30', max: '250',
    value: store.get('weightKg', 65), placeholder: '65',
  });
  weightInput.addEventListener('input', () => {
    const v = Math.max(30, Math.min(250, Number(weightInput.value) || 65));
    store.set('weightKg', v);
  });

  const f = JSON.parse(localStorage.getItem('shadow.fitness.v1') || '{}');

  render(shell(h('div', { class: 'settings' },
    h('h1', {}, 'Settings'),
    h('section', { class: 'card' },
      h('h2', {}, 'How you show up'),
      h('p', { class: 'muted small' }, 'This is the name and face your friends see on the leaderboard.'),
      h('div', { class: 'row' }, h('span', { class: 'ava big' }, avatar), nameInput),
      avaRow,
    ),
    h('section', { class: 'card' },
      h('h2', {}, 'Fitness'),
      h('p', { class: 'muted small' }, 'Your weight sharpens the calorie estimate. It stays on this device and is never uploaded.'),
      h('div', { class: 'row' }, h('label', { class: 'inline-label' }, 'Body weight'), weightInput, h('span', { class: 'muted small' }, 'kg')),
      f.sessions ? h('div', { class: 'fit-strip inset' },
        stat('🔥', f.bestStreak || f.streak || 0, 'best streak'),
        stat('⚡', Math.round(f.totalKcal || 0), 'kcal all-time'),
        stat('🏅', f.sessions || 0, 'routines'),
      ) : h('p', { class: 'muted small' }, 'Dance a routine and your streak starts here.'),
    ),
    h('section', {}, h('h2', {}, 'Spotify'), spotifyBox),
    h('section', { class: 'card' },
      h('h2', {}, 'How this works'),
      h('p', { class: 'muted' }, 'Videos are fetched with yt-dlp and kept locally. Pose tracking runs in this tab on your GPU — no video, no camera frame, and no pose data is ever uploaded anywhere except the pose cache on your own server.'),
    ),
  )));
}

// ---------- router ----------
function route() {
  teardown?.(); teardown = null;
  // Screens re-register these; clearing first stops a departed screen from
  // repainting a node that is no longer in the document.
  partyScreen.room = null; partyScreen.tick = null;
  const [pathPart, queryPart] = location.hash.replace(/^#/, '').split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const q = new URLSearchParams(queryPart || '');

  if (parts[0] === 'learn' && parts[1]) return viewLearn(parts[1]);
  if (parts[0] === 'battle' && parts[1]) {
    return viewBattle(parts[1], { partyMode: q.get('party') === '1', startAt: partyStart });
  }
  if (parts[0] === 'party') return viewParty(parts[1]);
  if (parts[0] === 'settings') return viewSettings();
  return viewHome();
}

addEventListener('hashchange', route);

(async function boot() {
  try { config = await (await fetch('/api/config')).json(); } catch { config = {}; }
  if (config.spotifyClientId) window.SHADOW_SPOTIFY_CLIENT_ID = config.spotifyClientId;
  if (await spotify.handleRedirect()) toast('Spotify connected.');
  route();
})();

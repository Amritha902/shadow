// Hookstep detection.
//
// The hook of a routine is the phrase the dancer repeats — the bit everyone
// actually wants to learn. We find it without hearing the music: build a
// scale- and position-invariant descriptor per sample, then look for the lag at
// which the routine best rhymes with a shifted copy of itself.
//
// Two things make this harder than a plain autocorrelation:
//
//   1. Bodies move slowly. Any two samples a tenth of a second apart look
//      nearly identical, so raw correlation falls off monotonically with lag
//      and the shortest lag always "wins". We detrend against a local baseline
//      and take the most prominent peak instead of the highest raw value.
//
//   2. Title cards, logo stings and empty frames are perfectly self-similar,
//      which makes them irresistible to a naive matcher. Every sample carries a
//      liveness flag, and dead stretches are excluded from both the correlation
//      and the candidate windows.

import { LM } from './stickman.js';

// Bones whose direction carries the choreography. Head and fingers are noise.
const SIG_BONES = [
  [LM.leftShoulder, LM.leftElbow], [LM.leftElbow, LM.leftWrist],
  [LM.rightShoulder, LM.rightElbow], [LM.rightElbow, LM.rightWrist],
  [LM.leftHip, LM.leftKnee], [LM.leftKnee, LM.leftAnkle],
  [LM.rightHip, LM.rightKnee], [LM.rightKnee, LM.rightAnkle],
  [LM.leftShoulder, LM.leftHip], [LM.rightShoulder, LM.rightHip],
  [LM.leftShoulder, LM.rightShoulder], [LM.leftHip, LM.rightHip],
];

const HZ = 10;               // samples per second — ample for phrase structure
const MIN_PHRASE = 2.0;      // shorter than this is a step, not a phrase
const MAX_PHRASE = 10;
const VIS = 0.3;

function descriptor(lm) {
  const d = new Float32Array(SIG_BONES.length * 2);
  let seen = 0;
  for (let i = 0; i < SIG_BONES.length; i++) {
    const [a, b] = SIG_BONES[i];
    if (Math.min(lm[a][3], lm[b][3]) < VIS) continue;
    const dx = lm[b][0] - lm[a][0];
    const dy = lm[b][1] - lm[a][1];
    const n = Math.hypot(dx, dy) || 1;
    d[i * 2] = dx / n;
    d[i * 2 + 1] = dy / n;
    seen++;
  }
  return { d, seen };
}

// Resample the pose track onto an even grid so a lag is a real duration, and
// mark which samples are worth comparing.
function resample(frames, duration) {
  const n = Math.max(2, Math.floor(duration * HZ));
  const sig = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = i / HZ;
    while (j < frames.length - 1 && frames[j + 1].t < t) j++;
    // A gap in the pose track means the dancer left frame — a title card, a
    // cutaway. Treat it as dead rather than holding the last pose forever.
    const stale = Math.abs(frames[j].t - t) > 0.5;
    const { d, seen } = descriptor(frames[j].lm);
    sig.push({ d, live: !stale && seen >= SIG_BONES.length * 0.6 });
  }

  // Also kill stretches that hold perfectly still: a frozen frame correlates
  // with everything and would otherwise dominate every candidate window.
  const STILL = 0.012;
  for (let i = 1; i < sig.length; i++) {
    let delta = 0;
    for (let k = 0; k < sig[i].d.length; k++) delta += Math.abs(sig[i].d[k] - sig[i - 1].d[k]);
    sig[i].moving = delta / sig[i].d.length > STILL;
  }
  if (sig.length) sig[0].moving = sig[1]?.moving ?? true;
  // Movement is bursty, so a sample counts as live if anything moved nearby.
  const W = Math.round(HZ * 0.6);
  return sig.map((s, i) => {
    let moved = false;
    for (let k = Math.max(0, i - W); k <= Math.min(sig.length - 1, i + W); k++) moved ||= sig[k].moving;
    return { d: s.d, live: s.live && moved };
  });
}

function similarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / SIG_BONES.length; // ~1 identical, ~0 unrelated, <0 opposed
}

// Mean similarity between the track and itself shifted by `lag`, over live
// samples only. Returns null when too little of the overlap is usable.
function corrAt(sig, lag) {
  let sum = 0, n = 0;
  for (let i = 0; i + lag < sig.length; i++) {
    if (!sig[i].live || !sig[i + lag].live) continue;
    sum += similarity(sig[i].d, sig[i + lag].d);
    n++;
  }
  const overlap = sig.length - lag;
  return n < overlap * 0.4 || n < HZ * 2 ? null : sum / n;
}

/**
 * @returns {{ hook: {start,end,confidence,reps}|null, period: number, loops: Array }}
 */
export function findHook(frames, duration) {
  const empty = { hook: null, period: 0, loops: [] };
  if (frames.length < 20 || duration < MIN_PHRASE * 2.5) return empty;

  const sig = resample(frames, duration);
  const N = sig.length;
  const liveCount = sig.filter((s) => s.live).length;
  if (liveCount < N * 0.25) return empty;

  // --- 1. detrended autocorrelation: where does the routine rhyme? ---
  const minLag = Math.round(MIN_PHRASE * HZ);
  const maxLag = Math.min(Math.round(MAX_PHRASE * HZ), Math.floor(N / 2));
  if (maxLag <= minLag + 2) return empty;

  const lags = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    const c = corrAt(sig, lag);
    if (c != null) lags.push({ lag, c });
  }
  if (lags.length < 5) return empty;

  // The baseline is what correlation would be at this lag from body inertia
  // alone. Anything standing proud of it is structure.
  const BW = Math.round(HZ * 1.2);
  const prominence = lags.map((p, i) => {
    let sum = 0, n = 0;
    for (let k = Math.max(0, i - BW); k <= Math.min(lags.length - 1, i + BW); k++) { sum += lags[k].c; n++; }
    return { ...p, prom: p.c - sum / n };
  });

  // Only true local maxima are candidate periods; a rising slope is not a beat.
  const peaks = prominence.filter((p, i) =>
    i > 0 && i < prominence.length - 1 &&
    p.prom >= prominence[i - 1].prom && p.prom >= prominence[i + 1].prom && p.prom > 0);
  if (!peaks.length) return empty;
  peaks.sort((a, b) => b.prom - a.prom);

  // Octave correction. An eight-count that repeats also repeats at four, so the
  // half-length peak is always there; prefer the longer phrase when it is
  // nearly as strong, since that is the unit dancers actually count.
  let best = peaks[0];
  const dbl = peaks.find((p) => Math.abs(p.lag - best.lag * 2) <= 2);
  if (dbl && dbl.prom > best.prom * 0.7) best = dbl;

  const win = best.lag;
  const period = win / HZ;

  // --- 2. slide a one-period window; score how well it repeats elsewhere ---
  const liveIn = (s, len) => {
    let live = 0;
    for (let i = s; i < s + len; i++) if (sig[i]?.live) live++;
    return live / len;
  };
  const matchAt = (a, b) => {
    let sum = 0, n = 0;
    for (let i = 0; i < win; i++) {
      if (!sig[a + i]?.live || !sig[b + i]?.live) continue;
      sum += similarity(sig[a + i].d, sig[b + i].d);
      n++;
    }
    return n < win * 0.5 ? null : sum / n;
  };

  const step = Math.max(1, Math.round(HZ / 5));
  const windows = [];
  for (let s = 0; s + win <= N; s += step) {
    if (liveIn(s, win) < 0.7) continue;
    const matches = [];
    for (let o = 0; o + win <= N; o += win) {
      if (Math.abs(o - s) < win) continue; // no overlap with itself
      const m = matchAt(s, o);
      if (m != null) matches.push(m);
    }
    if (!matches.length) continue;
    matches.sort((a, b) => b - a);
    // The best two recurrences matter more than the average: a phrase that
    // comes back twice, clearly, is the hook even if the rest is a bridge.
    const topTwo = matches.slice(0, 2).reduce((a, b) => a + b, 0) / Math.min(2, matches.length);
    const strong = matches.filter((m) => m > 0.7).length;
    windows.push({ s, score: topTwo * 0.75 + Math.min(strong / 3, 1) * 0.25, strong });
  }
  if (!windows.length) return empty;

  // Among windows that are essentially tied, take the earliest. When a routine
  // runs the same phrase five times, you want to be taught the first one — it
  // is where the video's own demonstration starts.
  const top = windows.reduce((a, b) => (b.score > a.score ? b : a));
  const bestWin = windows.find((w) => w.score >= top.score * 0.97) || top;

  // --- 3. find every place the winning window genuinely recurs ---
  // Strongest matches claim their slot first, so a clean recurrence is never
  // crowded out by a mediocre one that happened to start a beat earlier. The
  // hook itself is always the first marker, which keeps the timeline aligned.
  const candidates = [];
  for (let o = 0; o + win <= N; o++) {
    if (o === bestWin.s) continue;
    const m = matchAt(bestWin.s, o);
    if (m != null && m > 0.7) candidates.push({ i: o, match: m });
  }
  candidates.sort((a, b) => b.match - a.match);

  const taken = [{ i: bestWin.s, match: 1 }];
  for (const c of candidates) {
    if (taken.some((t) => Math.abs(t.i - c.i) < win)) continue;
    taken.push(c);
  }
  const loops = taken
    .sort((a, b) => a.i - b.i)
    .map(({ i, match }) => ({ i, start: i / HZ, end: (i + win) / HZ, match }));

  const confidence = Math.max(0, Math.min(1, (bestWin.score - 0.5) / 0.35));
  return {
    hook: {
      start: bestWin.s / HZ,
      end: Math.min(duration, (bestWin.s + win) / HZ),
      confidence,
      reps: Math.max(2, loops.length),
    },
    period,
    loops,
  };
}

// Beat grid inferred from motion, used for the count-in and to describe the
// routine. Dancers hit accents; accents are local maxima of limb speed.
export function estimateTempo(frames, duration) {
  if (frames.length < 30) return null;
  const KEYS = [LM.leftWrist, LM.rightWrist, LM.leftAnkle, LM.rightAnkle];
  const RATE = 20;
  const n = Math.floor(duration * RATE);
  if (n < 40) return null;
  const vel = new Float32Array(n);
  let j = 0;
  for (let i = 1; i < n; i++) {
    const t = i / RATE;
    while (j < frames.length - 1 && frames[j + 1].t < t) j++;
    const a = frames[Math.max(0, j - 1)], b = frames[j];
    let e = 0;
    for (const k of KEYS) e += Math.hypot(b.lm[k][0] - a.lm[k][0], b.lm[k][1] - a.lm[k][1]);
    vel[i] = e;
  }
  // Work on the accent envelope with its mean removed, or every lag correlates.
  const mean = vel.reduce((s, v) => s + v, 0) / n;
  for (let i = 0; i < n; i++) vel[i] -= mean;

  let bestBpm = null, bestScore = -Infinity;
  for (let bpm = 60; bpm <= 180; bpm += 0.5) {
    const lag = Math.round((60 / bpm) * RATE);
    if (lag < 2 || lag >= n / 2) continue;
    let sum = 0;
    for (let i = 0; i < n - lag; i++) sum += vel[i] * vel[i + lag];
    const score = sum / (n - lag);
    if (score > bestScore) { bestScore = score; bestBpm = bpm; }
  }
  if (!bestBpm || bestScore <= 0) return null;
  // Dance tempos read naturally in the 85–175 range; fold octaves into it.
  while (bestBpm < 85) bestBpm *= 2;
  while (bestBpm > 175) bestBpm /= 2;
  return Math.round(bestBpm);
}

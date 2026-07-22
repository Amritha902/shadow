// Hookstep detection.
//
// The "hook" of a routine is the phrase the dancer repeats — the bit everyone
// actually wants to learn. We find it without knowing the music: build a
// rotation/scale-invariant descriptor per frame, then look for the lag at which
// the whole routine best matches a shifted copy of itself. That lag is the
// period of the loop. The window that repeats most cleanly at that period is
// the hook.

import { LM } from './stickman.js';

// Bones whose *direction* carries the choreography. Head and fingers are noise.
const SIG_BONES = [
  [LM.leftShoulder, LM.leftElbow], [LM.leftElbow, LM.leftWrist],
  [LM.rightShoulder, LM.rightElbow], [LM.rightElbow, LM.rightWrist],
  [LM.leftHip, LM.leftKnee], [LM.leftKnee, LM.leftAnkle],
  [LM.rightHip, LM.rightKnee], [LM.rightKnee, LM.rightAnkle],
  [LM.leftShoulder, LM.leftHip], [LM.rightShoulder, LM.rightHip],
  [LM.leftShoulder, LM.rightShoulder], [LM.leftHip, LM.rightHip],
];

const HZ = 10; // descriptors per second — plenty for phrase-level structure

// One frame → unit vectors per bone, normalised by torso size so camera
// distance and framing drop out of the comparison.
function descriptor(lm) {
  const d = new Float32Array(SIG_BONES.length * 2);
  for (let i = 0; i < SIG_BONES.length; i++) {
    const [a, b] = SIG_BONES[i];
    const dx = lm[b][0] - lm[a][0];
    const dy = lm[b][1] - lm[a][1];
    const n = Math.hypot(dx, dy) || 1;
    const conf = Math.min(lm[a][3], lm[b][3]) > 0.3 ? 1 : 0;
    d[i * 2] = (dx / n) * conf;
    d[i * 2 + 1] = (dy / n) * conf;
  }
  return d;
}

// Resample the sparse pose track onto an even grid so lags are real durations.
function resample(frames, duration) {
  const n = Math.max(2, Math.floor(duration * HZ));
  const out = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = (i / HZ);
    while (j < frames.length - 1 && frames[j + 1].t < t) j++;
    out.push(descriptor(frames[j].lm));
  }
  return out;
}

function similarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (SIG_BONES.length); // ~1 identical, ~0 unrelated, <0 opposed
}

/**
 * @returns {{ hook: {start,end,confidence,reps}|null, period: number, loops: Array }}
 */
export function findHook(frames, duration, { minPhrase = 1.6, maxPhrase = 12 } = {}) {
  if (frames.length < 20 || duration < minPhrase * 2) {
    return { hook: null, period: 0, loops: [] };
  }
  const sig = resample(frames, duration);
  const N = sig.length;

  // --- 1. global autocorrelation over lag: where does the routine rhyme? ---
  const minLag = Math.round(minPhrase * HZ);
  const maxLag = Math.min(Math.round(maxPhrase * HZ), Math.floor(N / 2));
  if (maxLag <= minLag) return { hook: null, period: 0, loops: [] };

  const corr = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    const count = N - lag;
    for (let i = 0; i < count; i++) sum += similarity(sig[i], sig[i + lag]);
    // Longer lags compare fewer frames; a mild penalty stops the tail winning
    // on noise alone, without burying genuinely long phrases.
    corr.push({ lag, score: (sum / count) * (0.94 + 0.06 * (count / N)) });
  }
  corr.sort((a, b) => b.score - a.score);
  const best = corr[0];
  const period = best.lag / HZ;

  // --- 2. slide a one-period window; score how well it repeats elsewhere ---
  const win = best.lag;
  const step = Math.max(1, Math.round(HZ / 4));
  let bestWin = null;
  for (let s = 0; s + win <= N; s += step) {
    let total = 0, reps = 0;
    // Compare against every other non-overlapping placement of the same window.
    for (let o = 0; o + win <= N; o += win) {
      if (Math.abs(o - s) < win * 0.5) continue;
      let sum = 0;
      for (let i = 0; i < win; i++) sum += similarity(sig[s + i], sig[o + i]);
      const m = sum / win;
      total += m;
      if (m > 0.72) reps++;
    }
    const placements = Math.max(1, Math.floor(N / win) - 1);
    // Prefer windows that recur often AND recur strongly.
    const score = (total / placements) * 0.6 + Math.min(reps / 3, 1) * 0.4;
    if (!bestWin || score > bestWin.score) {
      bestWin = { start: s / HZ, end: (s + win) / HZ, score, reps: reps + 1 };
    }
  }
  if (!bestWin) return { hook: null, period, loops: [] };

  // --- 3. find every place the winning window actually recurs ---
  const s0 = Math.round(bestWin.start * HZ);
  const loops = [];
  for (let o = 0; o + win <= N; o++) {
    let sum = 0;
    for (let i = 0; i < win; i++) sum += similarity(sig[s0 + i], sig[o + i]);
    const m = sum / win;
    if (m > 0.7 && (!loops.length || o - loops[loops.length - 1].i > win * 0.7)) {
      loops.push({ i: o, start: o / HZ, end: (o + win) / HZ, match: m });
    }
  }

  const confidence = Math.max(0, Math.min(1, (bestWin.score - 0.35) / 0.45));
  return {
    hook: {
      start: bestWin.start,
      end: Math.min(duration, bestWin.end),
      confidence,
      reps: Math.max(bestWin.reps, loops.length),
    },
    period,
    loops,
  };
}

// Beat grid inferred from motion, used to snap the count-in and the metronome.
// Dancers hit accents; accents are local maxima of limb acceleration.
export function estimateTempo(frames, duration) {
  if (frames.length < 30) return null;
  const KEYS = [LM.leftWrist, LM.rightWrist, LM.leftAnkle, LM.rightAnkle];
  const n = Math.floor(duration * 20);
  const vel = new Float32Array(n);
  let j = 0;
  for (let i = 1; i < n; i++) {
    const t = i / 20;
    while (j < frames.length - 1 && frames[j + 1].t < t) j++;
    const a = frames[Math.max(0, j - 1)], b = frames[j];
    let e = 0;
    for (const k of KEYS) e += Math.hypot(b.lm[k][0] - a.lm[k][0], b.lm[k][1] - a.lm[k][1]);
    vel[i] = e;
  }
  // Autocorrelate the accent envelope across plausible dance tempos (60–180 BPM).
  let bestBpm = null, bestScore = -Infinity;
  for (let bpm = 60; bpm <= 180; bpm += 0.5) {
    const lag = Math.round((60 / bpm) * 20);
    if (lag < 2 || lag >= n / 2) continue;
    let sum = 0;
    for (let i = 0; i < n - lag; i++) sum += vel[i] * vel[i + lag];
    const score = sum / (n - lag);
    if (score > bestScore) { bestScore = score; bestBpm = bpm; }
  }
  // Dance tempos read better in the 90–150 range; fold octaves into it.
  while (bestBpm && bestBpm < 85) bestBpm *= 2;
  while (bestBpm && bestBpm > 175) bestBpm /= 2;
  return bestBpm ? Math.round(bestBpm) : null;
}

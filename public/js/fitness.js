// Fitness layer.
//
// Turns pose motion into an energy-expenditure estimate, so a routine is also a
// workout with a number on it. Two uses:
//
//   - routineBurn(frames, duration, opts) — offline, "this hookstep is worth
//     ~11 kcal and sits at a vigorous intensity", shown before you dance it.
//   - new BurnMeter(opts) — live, fed your own webcam pose each frame during a
//     battle, accumulating calories and an intensity read for the HUD.
//
// The method, and its honest limits:
//
// Pose landmarks are normalised to the frame, so raw pixel motion depends on how
// much of the shot the dancer fills. We divide every displacement by torso
// length, giving speed in *body-lengths per second* — scale- and distance-
// invariant. That maps to a MET (metabolic equivalent) between a slow sway and
// all-out dancing, and MET × body-mass × time is calories, the standard
// estimate physios use for cardio.
//
// This is a genuine estimate, not a measurement: it can't see how low you
// squat or how much you actually weigh, and it reads effort only from how fast
// your limbs travel. Treat the number as a consistent relative score — good for
// "harder than yesterday" and streaks — not a clinical calorimeter.

import { LM } from './stickman.js';

// Limbs whose travel reflects effort. Hands and feet move most in dance; hips
// carry the grounded, lower-body work that hands alone would miss.
const TRACKED = [
  LM.leftWrist, LM.rightWrist, LM.leftElbow, LM.rightElbow,
  LM.leftAnkle, LM.rightAnkle, LM.leftKnee, LM.rightKnee,
  LM.leftHip, LM.rightHip,
];

// Intensity → MET. 2.5 is a slow social sway; 5 is steady dance-cardio; ~9.5 is
// flat-out choreography. Endpoints from the Compendium of Physical Activities'
// dance entries (2.5–7.8, with performance/competitive dance higher).
const MET_MIN = 2.5;
const MET_MAX = 9.5;

// Body-lengths/sec that read as "resting" and "all-out". Calibrated so a gentle
// tutorial lands near 3–4 MET and fast hip-hop near 8. Empirical, not sacred.
const SPEED_REST = 0.15;
const SPEED_MAX = 2.6;

function torso(lm) {
  const sx = (lm[LM.leftShoulder][0] + lm[LM.rightShoulder][0]) / 2;
  const sy = (lm[LM.leftShoulder][1] + lm[LM.rightShoulder][1]) / 2;
  const hx = (lm[LM.leftHip][0] + lm[LM.rightHip][0]) / 2;
  const hy = (lm[LM.leftHip][1] + lm[LM.rightHip][1]) / 2;
  return Math.hypot(sx - hx, sy - hy);
}

// Mean tracked-limb speed between two frames, in body-lengths per second.
// Returns null when the pose is too incomplete to trust.
function limbSpeed(a, b, dt) {
  if (dt <= 0) return null;
  const scale = (torso(a.lm) + torso(b.lm)) / 2;
  if (scale < 1e-3) return null;
  let sum = 0, n = 0;
  for (const k of TRACKED) {
    if (Math.min(a.lm[k][3], b.lm[k][3]) < 0.3) continue;
    sum += Math.hypot(b.lm[k][0] - a.lm[k][0], b.lm[k][1] - a.lm[k][1]);
    n++;
  }
  if (n < TRACKED.length * 0.4) return null;
  return (sum / n) / scale / dt;
}

// speed (body-lengths/s) → 0..1 intensity, clamped, mildly curved so the middle
// of the range spreads out rather than saturating.
export function speedToIntensity(speed) {
  const t = (speed - SPEED_REST) / (SPEED_MAX - SPEED_REST);
  return Math.max(0, Math.min(1, t)) ** 0.85;
}

export function intensityToMet(intensity) {
  return MET_MIN + (MET_MAX - MET_MIN) * Math.max(0, Math.min(1, intensity));
}

// kcal burned over `seconds` at a given MET for a body mass.
// kcal = MET * 3.5 * kg / 200 * minutes  (standard ACSM form).
function kcal(met, kg, seconds) {
  return met * 3.5 * kg / 200 * (seconds / 60);
}

const DEFAULT_KG = 65;

/**
 * Whole-routine estimate.
 * @returns {{ kcal:number, met:number, intensity:number, activeSeconds:number,
 *             label:string }}
 */
export function routineBurn(frames, duration, { weightKg = DEFAULT_KG } = {}) {
  const empty = { kcal: 0, met: MET_MIN, intensity: 0, activeSeconds: 0, label: 'light' };
  if (!frames || frames.length < 3) return empty;

  let cal = 0, intenSum = 0, intenN = 0, active = 0;
  for (let i = 1; i < frames.length; i++) {
    const dt = frames[i].t - frames[i - 1].t;
    if (dt <= 0 || dt > 1) continue; // skip detection gaps
    const sp = limbSpeed(frames[i - 1], frames[i], dt);
    if (sp == null) continue;
    const intensity = speedToIntensity(sp);
    const met = intensityToMet(intensity);
    cal += kcal(met, weightKg, dt);
    intenSum += intensity; intenN++;
    if (intensity > 0.12) active += dt;
  }
  const intensity = intenN ? intenSum / intenN : 0;
  return {
    kcal: Math.round(cal * 10) / 10,
    met: Math.round(intensityToMet(intensity) * 10) / 10,
    intensity,
    activeSeconds: Math.round(active),
    label: intensityLabel(intensity),
  };
}

export function intensityLabel(intensity) {
  if (intensity >= 0.72) return 'all-out';
  if (intensity >= 0.5) return 'vigorous';
  if (intensity >= 0.28) return 'moderate';
  return 'light';
}

// Live accumulator for battle mode. Feed it the user's own landmarks each frame
// with a wall-clock timestamp; read .kcal / .intensity for the HUD.
export class BurnMeter {
  constructor({ weightKg = DEFAULT_KG, smoothing = 0.15 } = {}) {
    this.weightKg = weightKg;
    this.smoothing = smoothing;
    this.kcal = 0;
    this.intensity = 0;   // EMA-smoothed, for a HUD that doesn't jitter
    this.peakIntensity = 0;
    this.activeSeconds = 0;
    this._prev = null;     // { lm, t } in seconds
  }

  // t in seconds (e.g. performance.now()/1000). Returns the instantaneous
  // intensity for this frame, or null if the frame was unusable.
  push(lm, t) {
    if (!lm) return null;
    const cur = { lm, t };
    if (!this._prev) { this._prev = cur; return null; }
    const dt = t - this._prev.t;
    // Ignore absurd gaps (tab was backgrounded) so calories don't jump.
    if (dt <= 0 || dt > 0.5) { this._prev = cur; return null; }
    const sp = limbSpeed(this._prev, cur, dt);
    this._prev = cur;
    if (sp == null) return null;

    const inst = speedToIntensity(sp);
    const met = intensityToMet(inst);
    this.kcal += kcal(met, this.weightKg, dt);
    this.intensity += (inst - this.intensity) * this.smoothing;
    this.peakIntensity = Math.max(this.peakIntensity, inst);
    if (inst > 0.12) this.activeSeconds += dt;
    return inst;
  }

  summary() {
    return {
      kcal: Math.round(this.kcal * 10) / 10,
      peakIntensity: this.peakIntensity,
      activeSeconds: Math.round(this.activeSeconds),
      label: intensityLabel(this.peakIntensity),
    };
  }
}

// ---------- streaks & lifetime totals (localStorage) ----------
// Kept here so the fitness state has one home. Pure date math is unit-tested.

export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Given the last active day and today, return the streak delta:
//   'same'      already danced today — streak unchanged
//   'continue'  danced yesterday — streak + 1
//   'reset'     gap of 2+ days — streak back to 1
export function streakTransition(lastKey, todayKey) {
  if (lastKey === todayKey) return 'same';
  if (!lastKey) return 'reset';
  const [ly, lm, ld] = lastKey.split('-').map(Number);
  const [ty, tm, td] = todayKey.split('-').map(Number);
  const last = Date.UTC(ly, lm - 1, ld);
  const today = Date.UTC(ty, tm - 1, td);
  const days = Math.round((today - last) / 86400000);
  return days === 1 ? 'continue' : 'reset';
}

const FIT_KEY = 'choreo.fitness.v1';

export function loadFitness() {
  try { return JSON.parse(localStorage.getItem(FIT_KEY)) || {}; }
  catch { return {}; }
}

// Record a finished session; returns the updated profile including the new
// streak so the UI can celebrate it.
export function recordSession({ kcal = 0, seconds = 0, intensity = 0 } = {}, now = new Date()) {
  const f = loadFitness();
  const today = dayKey(now);
  const trans = streakTransition(f.lastDay, today);
  const streak = trans === 'same' ? (f.streak || 1)
    : trans === 'continue' ? (f.streak || 0) + 1 : 1;

  const next = {
    totalKcal: Math.round(((f.totalKcal || 0) + kcal) * 10) / 10,
    totalSeconds: (f.totalSeconds || 0) + Math.round(seconds),
    sessions: (f.sessions || 0) + 1,
    streak,
    bestStreak: Math.max(f.bestStreak || 0, streak),
    lastDay: today,
    // Per-day kcal for a little activity ring / calendar.
    days: { ...(f.days || {}), [today]: Math.round((((f.days || {})[today] || 0) + kcal) * 10) / 10 },
  };
  try { localStorage.setItem(FIT_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  return { ...next, streakChanged: trans !== 'same' };
}

// Fitness estimate tests. Two kinds: pure math (monotonicity, streak dates,
// calorie ordering) that must hold for any input, and sanity checks against
// real pose data that a routine's burn lands in a plausible human range.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  speedToIntensity, intensityToMet, intensityLabel,
  routineBurn, BurnMeter, streakTransition, dayKey,
} from '../public/js/fitness.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'poses');

test('intensity rises with limb speed and stays in 0..1', () => {
  assert.equal(speedToIntensity(0), 0);          // slower than resting → floor
  assert.equal(speedToIntensity(100), 1);        // absurdly fast → ceiling
  const a = speedToIntensity(0.5), b = speedToIntensity(1.5);
  assert.ok(b > a, 'faster limbs read as more intense');
  assert.ok(a >= 0 && b <= 1);
});

test('MET spans the dance range and tracks intensity', () => {
  assert.ok(intensityToMet(0) >= 2 && intensityToMet(0) <= 3);
  assert.ok(intensityToMet(1) >= 8, 'all-out dance is vigorous cardio');
  assert.ok(intensityToMet(1) > intensityToMet(0.5));
});

test('intensity labels are ordered', () => {
  assert.equal(intensityLabel(0.1), 'light');
  assert.equal(intensityLabel(0.35), 'moderate');
  assert.equal(intensityLabel(0.6), 'vigorous');
  assert.equal(intensityLabel(0.8), 'all-out');
});

test('calories scale with body mass', () => {
  // A minute of steady arm/leg motion at ~10 Hz. Long enough that the estimate
  // is a real number, not rounding noise; a heavier dancer must burn more over
  // the identical motion.
  const frames = Array.from({ length: 600 }, (_, i) => ({
    t: i * 0.1,
    lm: Array.from({ length: 33 }, (_, k) => {
      if (k === 11) return [0.4, 0.3, 0, 1];  // left shoulder
      if (k === 12) return [0.6, 0.3, 0, 1];  // right shoulder
      if (k === 23) return [0.42, 0.7, 0, 1]; // left hip
      if (k === 24) return [0.58, 0.7, 0, 1]; // right hip
      if (k === 15 || k === 16 || k === 27 || k === 28) {
        return [0.5 + 0.2 * Math.sin(i * 0.8), 0.5 + 0.2 * Math.cos(i * 0.8), 0, 1];
      }
      return [0.5, 0.5, 0, 1];
    }),
  }));
  const light = routineBurn(frames, 60, { weightKg: 50 });
  const heavy = routineBurn(frames, 60, { weightKg: 90 });
  assert.ok(light.kcal > 0, 'a minute of dancing burns something');
  assert.ok(heavy.kcal > light.kcal, 'heavier dancer burns more for the same motion');
  // kcal is linear in body mass, so the ratio should track the weight ratio.
  assert.ok(Math.abs(heavy.kcal / light.kcal - 90 / 50) < 0.05);
  assert.ok(light.intensity > 0 && light.intensity <= 1);
});

test('a still routine burns near-resting; a busy one burns more', () => {
  const still = Array.from({ length: 20 }, (_, i) => ({
    t: i * 0.1,
    lm: Array.from({ length: 33 }, (__, k) =>
      k === 11 ? [0.4, 0.3, 0, 1] : k === 12 ? [0.6, 0.3, 0, 1] :
      k === 23 ? [0.42, 0.7, 0, 1] : k === 24 ? [0.58, 0.7, 0, 1] : [0.5, 0.5, 0, 1]),
  }));
  const busy = still.map((f, i) => ({
    t: f.t,
    lm: f.lm.map((p, k) => (k === 15 || k === 16 || k === 27 || k === 28)
      ? [0.5 + 0.25 * Math.sin(i), 0.5 + 0.25 * Math.cos(i), 0, 1] : p),
  }));
  const s = routineBurn(still, 2);
  const b = routineBurn(busy, 2);
  assert.ok(b.intensity > s.intensity, 'moving limbs read as higher intensity');
  assert.ok(b.kcal > s.kcal);
});

test('BurnMeter ignores the first frame and huge time gaps', () => {
  const m = new BurnMeter();
  const lm = Array.from({ length: 33 }, (_, i) =>
    i === 11 ? [0.4, 0.3, 0, 1] : i === 12 ? [0.6, 0.3, 0, 1] :
    i === 23 ? [0.42, 0.7, 0, 1] : i === 24 ? [0.58, 0.7, 0, 1] : [0.5, 0.5, 0, 1]);
  assert.equal(m.push(lm, 0), null, 'first frame has no previous to compare');
  assert.equal(m.push(lm, 10), null, 'a 10s gap (backgrounded tab) is dropped');
  assert.equal(m.kcal, 0, 'no calories accrue from unusable frames');
});

test('streak: same day holds, next day continues, a gap resets', () => {
  assert.equal(streakTransition('2026-09-29', '2026-09-29'), 'same');
  assert.equal(streakTransition('2026-09-28', '2026-09-29'), 'continue');
  assert.equal(streakTransition('2026-09-26', '2026-09-29'), 'reset');
  assert.equal(streakTransition(undefined, '2026-09-29'), 'reset');
  // Across a month boundary the arithmetic still has to be right.
  assert.equal(streakTransition('2026-08-31', '2026-09-01'), 'continue');
  // 2026 is not a leap year, so Feb 28 → Mar 1 is consecutive.
  assert.equal(streakTransition('2026-02-28', '2026-03-01'), 'continue');
  // A leap year has Feb 29 between them, so the same span is a two-day gap.
  assert.equal(streakTransition('2024-02-28', '2024-03-01'), 'reset');
});

test('dayKey is stable and zero-padded', () => {
  assert.equal(dayKey(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(dayKey(new Date(2026, 11, 31)), '2026-12-31');
});

// Real-data sanity: a genuine routine should land in a human calorie range.
async function routines() {
  let files = [];
  try { files = (await readdir(DIR)).filter((f) => f.endsWith('.json')); } catch { /* none */ }
  return Promise.all(files.map(async (f) =>
    JSON.parse(await readFile(path.join(DIR, f), 'utf8'))));
}
const all = await routines();
if (all.length) {
  test('a real routine burns a plausible number of calories', () => {
    for (const r of all) {
      const burn = routineBurn(r.frames, r.duration);
      const perMin = burn.kcal / (r.duration / 60);
      // Dance cardio is ~5–15 kcal/min for a 65kg person; allow slack for the
      // estimate but catch anything off by an order of magnitude.
      assert.ok(perMin > 1 && perMin < 30, `${perMin.toFixed(1)} kcal/min is out of range`);
      assert.ok(burn.intensity >= 0 && burn.intensity <= 1);
    }
  });
}

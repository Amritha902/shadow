// Scoring and hookstep tests, run against real pose data extracted from real
// routines. `node --test test/` after opening at least one routine in the app.
//
// The point of these is the mirror case. A learner facing a screen answers the
// dancer's left arm with their right, and it is very easy to write a comparison
// that silently marks that wrong — it still returns plausible-looking numbers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { comparePoses, mirrorPose, poseAt, framesBounds, segmentSteps, LM } from '../public/js/stickman.js';
import { findHook, estimateTempo } from '../public/js/hook.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'poses');

async function routines() {
  let files = [];
  try { files = (await readdir(DIR)).filter((f) => f.endsWith('.json')); } catch { /* none yet */ }
  return Promise.all(files.map(async (f) => ({
    id: f.replace('.json', ''),
    ...JSON.parse(await readFile(path.join(DIR, f), 'utf8')),
  })));
}

const all = await routines();
if (!all.length) {
  console.warn('No pose data in data/poses — open a routine in the app first. Skipping.');
  process.exit(0);
}
const sample = all[0];
const midway = sample.frames[Math.floor(sample.frames.length / 2)].lm;

test('a pose matched against itself scores perfectly', () => {
  const r = comparePoses(midway, midway);
  assert.equal(r.score, 100);
});

test('mirroring swaps the sides of the body, not just the x axis', () => {
  const m = mirrorPose(midway);
  // The reflected left wrist is the original right wrist, reflected.
  assert.ok(Math.abs(m[LM.leftWrist][0] - (1 - midway[LM.rightWrist][0])) < 1e-9);
  assert.ok(Math.abs(m[LM.leftWrist][1] - midway[LM.rightWrist][1]) < 1e-9);
  // Reflecting twice is the identity.
  const back = mirrorPose(m);
  for (let i = 0; i < midway.length; i++) {
    assert.ok(Math.abs(back[i][0] - midway[i][0]) < 1e-9, `landmark ${i} x`);
    assert.ok(Math.abs(back[i][1] - midway[i][1]) < 1e-9, `landmark ${i} y`);
  }
});

test('a learner copying face-to-face scores as well as one copying side-on', () => {
  // Someone standing in front of the dancer and mirroring them produces the
  // reflection of the dancer's pose. Scored against the reflected reference,
  // that has to come out perfect — anything less means the mirror handling is
  // marking correct dancing as wrong.
  for (const r of all) {
    for (const frac of [0.2, 0.4, 0.6, 0.8]) {
      const ref = poseAt(r.frames, r.duration * frac);
      const learner = mirrorPose(ref);
      const scored = comparePoses(mirrorPose(ref), learner);
      assert.equal(scored.score, 100, `${r.id} at ${frac}`);
    }
  }
});

test('copying the wrong side is caught rather than quietly accepted', () => {
  // The same learner scored against the unreflected reference — the bug this
  // suite exists for. An asymmetric pose must not score full marks.
  let worst = 100;
  for (const r of all) {
    for (const frac of [0.2, 0.4, 0.6, 0.8]) {
      const ref = poseAt(r.frames, r.duration * frac);
      worst = Math.min(worst, comparePoses(ref, mirrorPose(ref)).score);
    }
  }
  assert.ok(worst < 90, `expected a mismatch to be visible, worst was ${worst}`);
});

test('a different moment in the routine does not score full marks', () => {
  const a = poseAt(sample.frames, sample.duration * 0.25);
  const b = poseAt(sample.frames, sample.duration * 0.75);
  assert.ok(comparePoses(a, b).score < 100);
});

test('comparison names the limb that is furthest off', () => {
  const ref = poseAt(sample.frames, sample.duration * 0.5);
  const bent = ref.map((p) => [...p]);
  bent[LM.leftWrist] = [ref[LM.leftShoulder][0], ref[LM.leftShoulder][1] - 0.3, 0, 1];
  const r = comparePoses(ref, bent);
  assert.equal(r.worst.name, 'left arm');
  assert.ok(r.score < 100);
});

test('interpolation stays inside the recorded track', () => {
  for (const r of all) {
    assert.deepEqual(poseAt(r.frames, -5), r.frames[0].lm);
    assert.deepEqual(poseAt(r.frames, r.duration + 5), r.frames.at(-1).lm);
    const mid = poseAt(r.frames, r.duration / 2);
    assert.equal(mid.length, 33);
    assert.ok(mid.every((p) => p.every(Number.isFinite)));
  }
});

test('framing bounds are a sane box around the dancer', () => {
  for (const r of all) {
    const b = framesBounds(r.frames);
    assert.ok(b, r.id);
    assert.ok(b.x1 > b.x0 && b.y1 > b.y0, `${r.id}: degenerate box`);
    // The tracker extrapolates limbs past the frame edge, so a little overhang
    // is expected and correct — a lot of it means the percentile trim failed.
    assert.ok(b.x0 > -0.25 && b.x1 < 1.25, `${r.id}: box escaped horizontally`);
    assert.ok(b.y0 > -0.25 && b.y1 < 1.25, `${r.id}: box escaped vertically`);
    // A dancer is taller than they are wide, and fills a decent part of frame.
    assert.ok(b.y1 - b.y0 > 0.2, `${r.id}: figure implausibly short`);
  }
});

test('every routine yields a confident, repeating hookstep', () => {
  for (const r of all) {
    const { hook, loops } = findHook(r.frames, r.duration);
    assert.ok(hook, `${r.id}: no hook found`);
    const len = hook.end - hook.start;
    assert.ok(len >= 2 && len <= 10, `${r.id}: implausible phrase of ${len.toFixed(1)}s`);
    assert.ok(hook.end <= r.duration + 1e-6, `${r.id}: hook runs past the end`);
    assert.ok(hook.confidence > 0.5, `${r.id}: confidence ${hook.confidence.toFixed(2)}`);
    assert.ok(hook.reps >= 2, `${r.id}: a hook that never comes back is not a hook`);

    // The hook is always the anchor of its own timeline, and no two markers
    // may overlap — an overlapping marker is the same repetition counted twice.
    assert.ok(loops.some((l) => Math.abs(l.start - hook.start) < 1e-6), `${r.id}: hook missing from its markers`);
    for (let i = 1; i < loops.length; i++) {
      assert.ok(loops[i].start - loops[i - 1].start >= len - 1e-6, `${r.id}: markers overlap`);
    }
  }
});

test('steps tile the routine end to end without gaps', () => {
  for (const r of all) {
    const steps = segmentSteps(r.frames, r.duration);
    assert.ok(steps.length >= 1, r.id);
    assert.equal(steps[0].start, 0, r.id);
    assert.ok(Math.abs(steps.at(-1).end - r.duration) < 1e-6, r.id);
    for (let i = 1; i < steps.length; i++) {
      assert.equal(steps[i].start, steps[i - 1].end, `${r.id}: gap before step ${i + 1}`);
    }
  }
});

test('tempo lands in the range people actually dance to', () => {
  for (const r of all) {
    const bpm = estimateTempo(r.frames, r.duration);
    assert.ok(bpm === null || (bpm >= 85 && bpm <= 175), `${r.id}: ${bpm} BPM`);
  }
});

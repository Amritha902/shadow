// Per-step report and live limb colouring. These need no recorded routine, so
// they run on a fresh clone.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scoreSteps, weakestStep, limbOfBone, LM } from '../public/js/stickman.js';

const steps = [
  { label: 'Step 1', start: 0, end: 2 },
  { label: 'Step 2', start: 2, end: 4 },
  { label: 'Step 3', start: 4, end: 6 },
];

test('each judgement lands in the step it happened in', () => {
  const r = scoreSteps(steps, [
    { t: 0.5, score: 90, worst: 'torso' },
    { t: 1.5, score: 70, worst: 'torso' },
    { t: 2.5, score: 40, worst: 'left arm' },
    { t: 3.5, score: 20, worst: 'left arm' },
    { t: 4.5, score: 80, worst: 'right leg' },
  ]);
  assert.deepEqual(r.map((s) => s.accuracy), [80, 30, 80]);
  assert.deepEqual(r.map((s) => s.judged), [2, 2, 1]);
});

test('a step boundary belongs to the step that starts there', () => {
  const r = scoreSteps(steps, [{ t: 2, score: 50, worst: null }]);
  assert.equal(r[0].accuracy, null);
  assert.equal(r[1].accuracy, 50);
});

test('a step nobody was judged in reports null, not zero', () => {
  // Zero would read as "you were terrible here" when the truth is "we never saw you".
  const r = scoreSteps(steps, [{ t: 0.5, score: 60, worst: 'torso' }]);
  assert.equal(r[1].accuracy, null);
  assert.equal(r[2].accuracy, null);
  assert.equal(weakestStep(r).label, 'Step 1');
});

test('the blamed limb is the one weakest most often, not in a single frame', () => {
  const r = scoreSteps([steps[0]], [
    { t: 0.1, score: 50, worst: 'right leg' },
    { t: 0.6, score: 50, worst: 'left arm' },
    { t: 1.1, score: 50, worst: 'left arm' },
  ]);
  assert.equal(r[0].worst, 'left arm');
});

test('weakest step is the lowest judged one', () => {
  const r = scoreSteps(steps, [
    { t: 0.5, score: 90, worst: null },
    { t: 2.5, score: 35, worst: 'left arm' },
    { t: 4.5, score: 60, worst: null },
  ]);
  assert.equal(weakestStep(r).label, 'Step 2');
  assert.equal(weakestStep(scoreSteps(steps, [])), null);
});

test('every arm and leg bone maps to its limb, in either order', () => {
  assert.equal(limbOfBone(LM.leftShoulder, LM.leftElbow), 'left arm');
  assert.equal(limbOfBone(LM.leftWrist, LM.leftElbow), 'left arm');
  assert.equal(limbOfBone(LM.rightKnee, LM.rightAnkle), 'right leg');
  assert.equal(limbOfBone(LM.leftShoulder, LM.rightShoulder), 'torso');
  // Feet aren't scored, so they are never painted as wrong.
  assert.equal(limbOfBone(LM.leftAnkle, LM.leftFoot), null);
});

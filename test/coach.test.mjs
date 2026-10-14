// The coach agent, tested without the network: a scripted fake client plays
// the model's side, so what's under test is everything Shadow owns — input
// hygiene, the tools, the loop, and the offline fallback.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runCoach, offlinePlan, sanitizeReport, readJoint, lookupTechnique, summariseHistory, makeToolbox, COACH_TOOLS,
} from '../coach.js';
import { jointAngles, scoreSteps } from '../public/js/stickman.js';

const report = sanitizeReport({
  title: 'Test routine', accuracy: 58, rank: 'C',
  steps: [
    { label: 'Step 1', start: 0, end: 2, accuracy: 81, worst: 'torso', judged: 4, limbs: { torso: 77 }, joints: {} },
    { label: 'Step 2', start: 2, end: 4.5, accuracy: 38, worst: 'left arm', judged: 5,
      limbs: { 'left arm': 52, 'right arm': 80 },
      joints: { 'left elbow': { you: 170, ref: 95 }, 'right knee': { you: 160, ref: 150 } } },
    { label: 'Step 3', start: 4.5, end: 6, accuracy: null, judged: 0 },
  ],
});

// ---------- angles ----------

const pose = () => Array.from({ length: 33 }, () => [0.5, 0.5, 0, 1]);

test('a straight arm is 180° at the elbow and a right angle is 90°', () => {
  const lm = pose();
  lm[11] = [0.3, 0.3, 0, 1]; lm[13] = [0.4, 0.3, 0, 1]; lm[15] = [0.5, 0.3, 0, 1];
  assert.equal(jointAngles(lm)['left elbow'], 180);
  lm[15] = [0.4, 0.4, 0, 1];
  assert.equal(jointAngles(lm)['left elbow'], 90);
});

test('joint angles respect frame aspect, so a 16:9 video is not squashed', () => {
  const lm = pose();
  // Forearm runs diagonally in normalised units (135° at the elbow), but on a
  // 2:1 frame its x run is twice as long in real space: acos(-1/√5) ≈ 117°.
  lm[11] = [0.4, 0.3, 0, 1]; lm[13] = [0.4, 0.4, 0, 1]; lm[15] = [0.5, 0.5, 0, 1];
  assert.equal(jointAngles(lm, 1)['left elbow'], 135);
  assert.equal(jointAngles(lm, 2)['left elbow'], 117);
});

test('hidden landmarks give null, not a guessed angle', () => {
  const lm = pose();
  lm[15] = [0.5, 0.5, 0, 0.1];
  assert.equal(jointAngles(lm)['left elbow'], null);
});

test('step joint averages only use moments where both bodies were seen', () => {
  const r = scoreSteps([{ label: 'Step 1', start: 0, end: 2 }], [
    { t: 0.5, score: 50, you: { 'left knee': 100 }, ref: { 'left knee': 140 } },
    { t: 1.0, score: 50, you: { 'left knee': 120 }, ref: { 'left knee': null } },
  ]);
  assert.deepEqual(r[0].joints['left knee'], { you: 100, ref: 140, diff: -40 });
});

// ---------- tools ----------

test('the browser report is clamped before anything reads it', () => {
  const r = sanitizeReport({ steps: [{ accuracy: 900, joints: { 'left elbow': { you: -5, ref: 400 }, nose: { you: 1, ref: 2 } } }] });
  assert.equal(r.steps[0].accuracy, 100);
  assert.deepEqual(r.steps[0].joints['left elbow'], { you: 0, ref: 180, diff: -180 });
  assert.equal(r.steps[0].joints.nose, undefined);
  assert.equal(sanitizeReport(null).steps.length, 0);
});

test('angle differences are read the right way round at every joint', () => {
  assert.equal(readJoint('left elbow', { you: 170, ref: 95, diff: 75 }).problem, 'too_straight');
  assert.equal(readJoint('right knee', { you: 90, ref: 150, diff: -60 }).problem, 'too_bent');
  assert.equal(readJoint('left shoulder', { you: 40, ref: 90, diff: -50 }).problem, 'too_low');
  assert.equal(readJoint('right shoulder', { you: 150, ref: 90, diff: 60 }).problem, 'too_high');
  assert.match(readJoint('left elbow', { you: 170, ref: 95, diff: 75 }).reading, /straighter.*75°/);
});

test('retrieval ranks a joint-and-problem match above the general cue', () => {
  const hits = lookupTechnique('left elbow', 'too_straight');
  assert.ok(hits.length >= 2);
  assert.match(hits[0].id, /^elbow-bend/);
  assert.equal(hits.at(-1).id, 'any-slow');
});

test('step detail flags only joints off by 20° or more', () => {
  const box = makeToolbox(report, []);
  const d = box.get_step_detail({ step: 'step 2' });
  assert.deepEqual(d.joints_off.map((j) => j.joint), ['left elbow']);
  assert.throws(() => box.get_step_detail({ step: 'Step 9' }), /No step called/);
});

test('memory summarises past attempts per step', () => {
  assert.equal(summariseHistory([]).attempts, 0);
  const h = summariseHistory([
    { accuracy: 40, steps: [{ label: 'Step 2', accuracy: 20 }] },
    { accuracy: 50, steps: [{ label: 'Step 2', accuracy: 31 }, { label: 'Step 3', accuracy: null }] },
  ]);
  assert.deepEqual(h.overall, [40, 50]);
  assert.deepEqual(h.steps, { 'Step 2': [20, 31] });
});

test('submit_plan is strict and every other tool takes a closed schema', () => {
  for (const t of COACH_TOOLS) assert.equal(t.input_schema.additionalProperties, false, t.name);
  assert.equal(COACH_TOOLS.find((t) => t.name === 'submit_plan').strict, true);
});

// ---------- the loop ----------

function fakeClient(turns) {
  const calls = [];
  return {
    calls,
    beta: { messages: { create: async (req) => {
      calls.push(structuredClone(req));
      const content = turns.shift();
      if (!content) throw new Error('script ran out');
      return { model: 'fake-model', stop_reason: 'tool_use', content };
    } } },
  };
}
const use = (id, name, input) => ({ type: 'tool_use', id, name, input });

test('the agent can investigate, recover from a bad call, and submit a plan', async () => {
  const client = fakeClient([
    [use('a', 'get_step_report', {}), use('b', 'get_past_attempts', {})],
    [use('c', 'get_step_detail', { step: 'Step 7' })], // wrong label: tool errors, agent retries
    [use('d', 'get_step_detail', { step: 'Step 2' }), use('e', 'lookup_technique', { joint: 'left elbow', problem: 'too_straight' })],
    [use('f', 'submit_plan', {
      headline: 'Bend the left elbow in step 2', focus_step: 'Step 2', why: 'It scored 38%.',
      cues: ['Soften the elbow'], speed: 0.5, loops: 6, progress_note: '',
    })],
  ]);
  const out = await runCoach({ client, report, history: [] });
  assert.equal(out.source, 'claude');
  assert.equal(out.plan.focus.label, 'Step 2');
  assert.deepEqual([out.plan.focus.start, out.plan.focus.end], [2, 4.5]);
  assert.equal(out.plan.speed, 0.5);
  assert.deepEqual(out.trace.map((t) => [t.tool, t.ok]), [
    ['get_step_report', true], ['get_past_attempts', true], ['get_step_detail', false],
    ['get_step_detail', true], ['lookup_technique', true], ['submit_plan', true],
  ]);
  // The failed call went back to the model as an error it could act on.
  const third = client.calls[2].messages.at(-1).content[0];
  assert.equal(third.is_error, true);
  assert.match(third.content, /Step 1, Step 2, Step 3/);
  // Parallel calls in one turn answered together in one message.
  assert.equal(client.calls[1].messages.at(-1).content.length, 2);
});

test('the request opts into server-side fallback and sets effort explicitly', async () => {
  const client = fakeClient([[use('a', 'submit_plan', {
    headline: 'x', focus_step: 'Step 1', why: 'y', cues: ['z'], speed: 1, loops: 4, progress_note: '',
  })]]);
  await runCoach({ client, report, history: [] });
  const req = client.calls[0];
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(req.output_config.effort, 'medium');
});

test('a plan for a step that does not exist is refused, not shown', async () => {
  const client = fakeClient([
    [use('a', 'submit_plan', { headline: 'x', focus_step: 'Step 12', why: 'y', cues: ['z'], speed: 1, loops: 4, progress_note: '' })],
  ]);
  await assert.rejects(runCoach({ client, report, history: [] }), /script ran out/);
});

test('a refusal or a chatty ending without a plan is an error, so the server falls back', async () => {
  const refuse = { beta: { messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } } };
  await assert.rejects(runCoach({ client: refuse, report, history: [] }), /declined/);
  const chat = fakeClient([[{ type: 'text', text: 'Great job!' }]]);
  await assert.rejects(runCoach({ client: chat, report, history: [] }), /without submitting/);
});

// ---------- offline ----------

test('the offline coach picks the weakest judged step and a matching cue', () => {
  const p = offlinePlan(report, [{ accuracy: 30, steps: [{ label: 'Step 2', accuracy: 25 }] }]);
  assert.equal(p.focus.label, 'Step 2');
  assert.equal(p.speed, 0.5);
  assert.match(p.headline, /left elbow is straighter/);
  assert.match(p.cues[0], /elbow/i);
  assert.equal(p.progress, 'Step 2 before: 25%; now 38%.');
});

test('the offline coach says so when nobody was seen', () => {
  const p = offlinePlan(sanitizeReport({ steps: [{ label: 'Step 1', accuracy: null }] }), []);
  assert.equal(p.focus, null);
  assert.match(p.headline, /never saw you/);
});

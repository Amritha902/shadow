// The coach — an agent that reads your battle and writes you one practice plan.
//
// The browser already knows exactly what went wrong: per-step accuracy, which
// limb was off, and your joint angles against the dancer's. What it can't do
// is say it like a teacher would. So the run is handed to Claude with a small
// set of tools, and Claude decides what to look at:
//
//   get_step_report    the whole run, step by step
//   get_step_detail    one step: limb scores and joint angles, yours vs theirs
//   get_past_attempts  memory — how this learner did on this routine before
//   lookup_technique   retrieval from a hand-written library of teaching cues
//   submit_plan        the answer: one step to drill, how, and why
//
// Every number the coach can quote comes out of a tool, so it can't invent one.
// Without credentials or on any API failure, offlinePlan() builds the same
// shape of plan deterministically, and the UI says which one you got.

import { CUES } from './coach-cues.js';

export const COACH_MODEL = process.env.SHADOW_COACH_MODEL || 'claude-opus-5-5';
const MAX_TURNS = 8;
// Below this a joint difference is noise — the tracker itself wobbles ~10°.
const ANGLE_FLAG = 20;

const JOINTS = ['left elbow', 'right elbow', 'left shoulder', 'right shoulder',
  'left hip', 'right hip', 'left knee', 'right knee'];
const PROBLEMS = ['too_straight', 'too_bent', 'too_high', 'too_low'];
const SPEEDS = [0.5, 0.75, 1];

// ---------- input hygiene ----------
// The report comes from the browser, so it is untrusted: clamp it to the shape
// and sizes the tools expect before anything reads it.
const num = (v, lo, hi) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : null);
const str = (v, n = 40) => (typeof v === 'string' ? v.slice(0, n) : null);

export function sanitizeReport(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const steps = (Array.isArray(r.steps) ? r.steps : []).slice(0, 24).map((s, i) => {
    const joints = {};
    for (const j of JOINTS) {
      const v = s?.joints?.[j];
      if (!v) continue;
      const you = num(v.you, 0, 180), ref = num(v.ref, 0, 180);
      if (you != null && ref != null) joints[j] = { you, ref, diff: you - ref };
    }
    const limbs = {};
    for (const [k, v] of Object.entries(s?.limbs || {}).slice(0, 8)) {
      const n = num(v, 0, 100);
      if (n != null) limbs[str(k, 20)] = n;
    }
    return {
      label: str(s?.label, 20) || `Step ${i + 1}`,
      start: num(s?.start, 0, 36000) ?? 0,
      end: num(s?.end, 0, 36000) ?? 0,
      accuracy: s?.accuracy == null ? null : num(s.accuracy, 0, 100),
      worst: str(s?.worst, 20),
      judged: num(s?.judged, 0, 100000) ?? 0,
      limbs, joints,
    };
  });
  return {
    title: str(r.title, 120) || 'this routine',
    accuracy: num(r.accuracy, 0, 100) ?? 0,
    rank: str(r.rank, 2) || '?',
    steps,
  };
}

// ---------- reading joint angles ----------
// The sign of an angle difference means different things at different joints,
// so translate it once, here, rather than trusting the model to get it right.
export function readJoint(name, { you, ref, diff }) {
  const kind = name.split(' ')[1];
  let problem, words;
  if (kind === 'shoulder') {
    problem = diff > 0 ? 'too_high' : 'too_low';
    words = diff > 0 ? 'arm is raised higher than' : 'arm is lower than';
  } else if (kind === 'hip') {
    problem = diff > 0 ? 'too_straight' : 'too_bent';
    words = diff > 0 ? 'hip is more upright than' : 'hip is more folded than';
  } else {
    problem = diff > 0 ? 'too_straight' : 'too_bent';
    words = diff > 0 ? `${kind} is straighter than` : `${kind} is more bent than`;
  }
  const side = name.split(' ')[0];
  return {
    joint: name, you, reference: ref, difference: diff, problem,
    reading: `Your ${side} ${words} the dancer's by ${Math.abs(diff)}° (you ${you}°, them ${ref}°).`,
  };
}

const flagged = (step) => Object.entries(step.joints || {})
  .filter(([, v]) => Math.abs(v.diff) >= ANGLE_FLAG)
  .sort((a, b) => Math.abs(b[1].diff) - Math.abs(a[1].diff))
  .map(([n, v]) => readJoint(n, v));

// ---------- retrieval ----------
// A tiny, hand-written knowledge base — so "retrieval" here means ranking
// teaching cues by how well they fit the joint and the problem, nothing grander.
export function lookupTechnique(joint, problem) {
  const kind = String(joint).split(' ').pop();
  const scored = CUES.map((c) => {
    let s = 0;
    if (c.joints.includes(kind)) s += 2;
    if (c.problems.includes(problem)) s += 2;
    if (c.joints.includes('any')) s += 0.5;
    return { c, s };
  }).filter((x) => x.s >= 2).sort((a, b) => b.s - a.s);
  return scored.slice(0, 3).map(({ c }) => ({ id: c.id, cue: c.cue, why: c.why }));
}

// ---------- memory ----------
// Past attempts are summarised per step label. Step cuts come from the routine
// itself, so the same label means the same bars run to run.
export function summariseHistory(history) {
  const runs = (history || []).slice(-6);
  if (!runs.length) return { attempts: 0, note: 'First time this learner has battled this routine.' };
  const byStep = {};
  for (const r of runs) {
    for (const s of r.steps || []) {
      if (s.accuracy == null) continue;
      (byStep[s.label] ||= []).push(s.accuracy);
    }
  }
  return {
    attempts: runs.length,
    overall: runs.map((r) => r.accuracy),
    steps: Object.fromEntries(Object.entries(byStep).map(([k, v]) => [k, v])),
  };
}

// ---------- tools ----------
const TOOLS = [
  {
    name: 'get_step_report',
    description: 'The whole battle: overall accuracy and rank, then every step with its time range, accuracy (0-100, null if the learner was never seen in it) and the limb that was weakest most often. Start here.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'get_step_detail',
    description: 'One step in detail: per-limb agreement (0-100) and the joints whose angle differed from the dancer by 20° or more, each with a plain-English reading and a problem code to pass to lookup_technique.',
    input_schema: {
      type: 'object',
      properties: { step: { type: 'string', description: 'Step label exactly as in the report, e.g. "Step 3".' } },
      required: ['step'], additionalProperties: false,
    },
  },
  {
    name: 'get_past_attempts',
    description: "This learner's previous battles on the same routine: overall accuracy per attempt, oldest first, and per-step accuracy history. Use it to say whether something is improving.",
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'lookup_technique',
    description: 'Retrieve teaching cues from the coaching library for one joint and one problem. Use the problem code given by get_step_detail.',
    input_schema: {
      type: 'object',
      properties: {
        joint: { type: 'string', enum: JOINTS },
        problem: { type: 'string', enum: PROBLEMS },
      },
      required: ['joint', 'problem'], additionalProperties: false,
    },
  },
  {
    name: 'submit_plan',
    description: 'Submit the practice plan. Call exactly once, last. Every number you mention must have come from a tool result.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        headline: { type: 'string', description: 'One short sentence, the main thing to fix.' },
        focus_step: { type: 'string', description: 'Label of the step to drill.' },
        why: { type: 'string', description: 'One or two sentences grounded in the data.' },
        cues: { type: 'array', items: { type: 'string' }, description: '1 to 3 short body cues, the way a dance teacher says them.' },
        speed: { type: 'number', enum: SPEEDS, description: 'Playback speed to drill at.' },
        loops: { type: 'integer', description: 'How many times to loop the step, 3 to 10.' },
        progress_note: { type: 'string', description: 'What changed since past attempts, or empty string if this is the first.' },
      },
      required: ['headline', 'focus_step', 'why', 'cues', 'speed', 'loops', 'progress_note'],
      additionalProperties: false,
    },
  },
];

export function makeToolbox(report, history) {
  const find = (label) => report.steps.find((s) => s.label.toLowerCase() === String(label).trim().toLowerCase());
  return {
    get_step_report: () => ({
      routine: report.title, accuracy: report.accuracy, rank: report.rank,
      steps: report.steps.map((s) => ({
        step: s.label, from: +s.start.toFixed(1), to: +s.end.toFixed(1),
        accuracy: s.accuracy, weakest_limb: s.worst, judged: s.judged,
      })),
    }),
    get_step_detail: ({ step }) => {
      const s = find(step);
      if (!s) throw new Error(`No step called "${step}". Labels: ${report.steps.map((x) => x.label).join(', ')}`);
      return {
        step: s.label, accuracy: s.accuracy, limbs: s.limbs,
        joints_off: flagged(s),
        note: s.accuracy == null ? 'The learner was not seen during this step.' : undefined,
      };
    },
    get_past_attempts: () => summariseHistory(history),
    lookup_technique: ({ joint, problem }) => {
      const cues = lookupTechnique(joint, problem);
      return cues.length ? { cues } : { cues: [], note: 'No cue in the library for that combination.' };
    },
    submit_plan: (input) => {
      const s = find(input.focus_step);
      if (!s) throw new Error(`focus_step "${input.focus_step}" is not a step. Labels: ${report.steps.map((x) => x.label).join(', ')}`);
      const cues = (input.cues || []).map(String).filter(Boolean).slice(0, 3);
      if (!cues.length) throw new Error('Give at least one cue.');
      return {
        headline: String(input.headline).slice(0, 160),
        focus: { label: s.label, start: s.start, end: s.end, accuracy: s.accuracy },
        why: String(input.why).slice(0, 400),
        cues: cues.map((c) => c.slice(0, 160)),
        speed: SPEEDS.includes(input.speed) ? input.speed : 0.75,
        loops: Math.max(3, Math.min(10, Math.round(input.loops) || 5)),
        progress: String(input.progress_note || '').slice(0, 240),
      };
    },
  };
}

const SYSTEM = `You are the coach inside Shadow, an app where people learn dance choreography by copying a stickman of the original dancer and getting scored on camera.

A learner has just finished a battle. Review it with your tools and submit one practice plan with submit_plan.

How to work:
- Start with get_step_report. Pick the step that will help most to drill: usually the weakest judged step, but a step that is almost there can be a better pick if the learner keeps missing the same limb.
- Look at that step with get_step_detail, check get_past_attempts, and use lookup_technique for the joint that is most off so your cues come from the library.
- Every number you mention must come from a tool result. Never invent scores, angles or history.
- Limb and joint names refer to the learner's own body. The learner copies a mirrored reference, so do not tell them to swap sides.
- Cues are short, physical and positive, the way a dance teacher talks: "elbow up to shoulder height", not "increase shoulder abduction".
- Pick a slower speed for low accuracy: 0.5 below 45%, 0.75 below 72%, 1 otherwise.
- If no step was judged, say the camera never saw them and make the plan about framing.`;

// ---------- the agent loop ----------
// A manual loop rather than the SDK's beta tool runner: it's short, and it lets
// the loop stop the moment submit_plan validates instead of asking the model
// for a closing message nobody reads.
export async function runCoach({ client, report, history, model = COACH_MODEL, onStep }) {
  const box = makeToolbox(report, history);
  const trace = [];
  const messages = [{
    role: 'user',
    content: `${report.title}: the learner just finished a battle at ${report.accuracy}% (rank ${report.rank}). Coach them.`,
  }];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      // A safety decline is re-run on Anthropic's recommended fallback model
      // inside the same call, instead of leaving the learner with no plan.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      system: SYSTEM,
      tools: TOOLS,
      messages,
    });
    if (res.stop_reason === 'refusal') throw new Error('The coach model declined this request.');
    if (res.stop_reason === 'max_tokens') throw new Error('The coach ran out of room mid-answer.');

    messages.push({ role: 'assistant', content: res.content });
    const uses = res.content.filter((b) => b.type === 'tool_use');
    if (!uses.length) throw new Error('The coach finished without submitting a plan.');

    const results = [];
    let plan = null;
    for (const u of uses) {
      let content, isError = false;
      try {
        const fn = box[u.name];
        if (!fn) throw new Error(`Unknown tool ${u.name}`);
        const out = fn(u.input || {});
        if (u.name === 'submit_plan') plan = out;
        content = JSON.stringify(out);
      } catch (e) {
        isError = true;
        content = e.message;
      }
      const entry = { tool: u.name, input: u.input || {}, ok: !isError };
      trace.push(entry);
      onStep?.(entry);
      results.push({ type: 'tool_result', tool_use_id: u.id, content, ...(isError ? { is_error: true } : {}) });
    }
    if (plan) return { plan, trace, source: 'claude', model: res.model };
    messages.push({ role: 'user', content: results });
  }
  throw new Error('The coach did not settle on a plan.');
}

// ---------- the offline coach ----------
// Same plan shape from fixed rules: weakest judged step, its most-off joint,
// the top library cue for it. Used with no API credentials or on any failure,
// and labelled as such in the UI.
export function offlinePlan(report, history) {
  const judged = report.steps.filter((s) => s.accuracy != null);
  if (!judged.length) {
    return {
      headline: 'The camera never saw you — fix the framing first.',
      focus: null,
      why: 'No step had a visible pose, so there is nothing to score yet.',
      cues: ['Step back until your whole body, head to feet, is in the camera preview.', 'Face the camera with light in front of you, not behind.'],
      speed: 0.75, loops: 3, progress: '',
    };
  }
  const s = judged.reduce((a, b) => (b.accuracy < a.accuracy ? b : a));
  const off = flagged(s);
  const cues = [];
  for (const j of off.slice(0, 2)) {
    const hit = lookupTechnique(j.joint, j.problem)[0];
    if (hit) cues.push(hit.cue);
  }
  if (!cues.length) cues.push(`Watch the stickman's ${s.worst || 'arms'} in ${s.label} at half speed, then copy just that limb.`);
  const past = summariseHistory(history);
  const prev = past.steps?.[s.label];
  return {
    headline: off[0]
      ? `${s.label}: ${off[0].reading.replace(/^Your/, 'your')}`
      : `${s.label} is your weakest step at ${s.accuracy}%.`,
    focus: { label: s.label, start: s.start, end: s.end, accuracy: s.accuracy },
    why: `${s.label} scored ${s.accuracy}%, the lowest of ${judged.length} judged steps${s.worst ? `, and your ${s.worst} was the weakest limb most often` : ''}.`,
    cues: [...new Set(cues)].slice(0, 3),
    speed: s.accuracy < 45 ? 0.5 : s.accuracy < 72 ? 0.75 : 1,
    loops: s.accuracy < 45 ? 8 : 5,
    progress: prev?.length ? `${s.label} before: ${prev.join('% → ')}%; now ${s.accuracy}%.` : '',
  };
}

export { TOOLS as COACH_TOOLS };

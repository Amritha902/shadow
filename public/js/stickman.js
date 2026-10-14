// Stickman rendering, pose interpolation, auto step-segmentation, and pose comparison.

// MediaPipe 33-landmark indices.
export const LM = {
  nose: 0, leftEye: 2, rightEye: 5, leftEar: 7, rightEar: 8,
  leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16, leftHip: 23, rightHip: 24,
  leftKnee: 25, rightKnee: 26, leftAnkle: 27, rightAnkle: 28,
  leftHeel: 29, rightHeel: 30, leftFoot: 31, rightFoot: 32,
};

const BONES = [
  [LM.leftShoulder, LM.rightShoulder],
  [LM.leftShoulder, LM.leftElbow], [LM.leftElbow, LM.leftWrist],
  [LM.rightShoulder, LM.rightElbow], [LM.rightElbow, LM.rightWrist],
  [LM.leftShoulder, LM.leftHip], [LM.rightShoulder, LM.rightHip],
  [LM.leftHip, LM.rightHip],
  [LM.leftHip, LM.leftKnee], [LM.leftKnee, LM.leftAnkle], [LM.leftAnkle, LM.leftFoot],
  [LM.rightHip, LM.rightKnee], [LM.rightKnee, LM.rightAnkle], [LM.rightAnkle, LM.rightFoot],
];

// ---------- interpolation ----------
export function poseAt(frames, t) {
  if (!frames.length) return null;
  let lo = 0, hi = frames.length - 1;
  if (t <= frames[0].t) return frames[0].lm;
  if (t >= frames[hi].t) return frames[hi].lm;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = frames[lo], b = frames[hi];
  const gap = b.t - a.t;
  // Across a detection gap (subject off-screen), don't tween — snap.
  if (gap > 0.5) return gap && t - a.t < gap / 2 ? a.lm : b.lm;
  const k = gap ? (t - a.t) / gap : 0;
  return a.lm.map((pa, i) => {
    const pb = b.lm[i];
    return [pa[0] + (pb[0] - pa[0]) * k, pa[1] + (pb[1] - pa[1]) * k,
            pa[2] + (pb[2] - pa[2]) * k, Math.min(pa[3], pb[3])];
  });
}

// ---------- framing ----------
// Landmarks are normalised to the source frame, so a dancer shot wide comes out
// as a thumbnail in the corner. Fitting to the figure's own bounds makes the
// stickman fill the pane — and, in a battle, makes you and the reference the
// same size no matter how far either of you stood from the lens.

const VISIBLE = 0.35;

export function poseBounds(lm) {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0, n = 0;
  for (const p of lm) {
    if (p[3] <= VISIBLE) continue;
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
    n++;
  }
  return n >= 4 ? { x0, y0, x1, y1 } : null;
}

// One box for the whole routine. Per-frame boxes would make the figure breathe
// as limbs extend; a fixed frame keeps it planted like a real dancer.
//
// Taken at a percentile rather than the extremes: the tracker guesses at
// landmarks that leave the frame, and a single wild guess in one frame would
// otherwise shrink the dancer for the entire routine.
const pick = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))];

export function framesBounds(frames, q = 0.02) {
  const x0 = [], y0 = [], x1 = [], y1 = [];
  for (const f of frames) {
    const b = poseBounds(f.lm);
    if (!b) continue;
    x0.push(b.x0); y0.push(b.y0); x1.push(b.x1); y1.push(b.y1);
  }
  if (!x0.length) return null;
  for (const a of [x0, y0, x1, y1]) a.sort((m, n) => m - n);
  return {
    x0: pick(x0, q), y0: pick(y0, q),
    x1: pick(x1, 1 - q), y1: pick(y1, 1 - q),
  };
}

// Blend a box toward a target — used for live poses, where an unsmoothed box
// would jitter the whole figure every frame.
export function easeBounds(current, target, k = 0.08) {
  if (!target) return current;
  if (!current) return { ...target };
  return {
    x0: current.x0 + (target.x0 - current.x0) * k,
    y0: current.y0 + (target.y0 - current.y0) * k,
    x1: current.x1 + (target.x1 - current.x1) * k,
    y1: current.y1 + (target.y1 - current.y1) * k,
  };
}

// ---------- drawing ----------
export function drawStickman(ctx, lm, opts = {}) {
  const {
    W = ctx.canvas.width, H = ctx.canvas.height,
    mirror = false, color = '#201b16', glow = null, lineWidth = null,
    alpha = 1, ghost = false, fit = null, aspect = 16 / 9, pad = 0.16,
    boneColor = null,
  } = opts;
  if (!lm) return;
  const vis = (p) => p[3] > VISIBLE;

  let X, Y;
  if (fit) {
    // Work in units of source height so the figure is never stretched, then
    // letterbox the padded bounding box into the canvas.
    const bx0 = fit.x0 * aspect, bx1 = fit.x1 * aspect;
    const padX = (bx1 - bx0) * pad, padY = (fit.y1 - fit.y0) * pad;
    const bw = (bx1 - bx0) + padX * 2 || 1;
    const bh = (fit.y1 - fit.y0) + padY * 2 || 1;
    const s = Math.min(W / bw, H / bh);
    const left = (W - bw * s) / 2;
    const top = (H - bh * s) / 2;
    // Mirroring flips around the bounding box rather than the source frame, so
    // the figure stays centred instead of sliding off to the opposite side.
    X = mirror
      ? (p) => ((bx1 + padX) - p[0] * aspect) * s + left
      : (p) => (p[0] * aspect - (bx0 - padX)) * s + left;
    Y = (p) => (p[1] - (fit.y0 - padY)) * s + top;
  } else {
    X = (p) => (mirror ? (1 - p[0]) : p[0]) * W;
    Y = (p) => p[1] * H;
  }

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const lw = lineWidth ?? Math.max(4, Math.min(W, H) * 0.02);

  if (glow) {
    ctx.shadowColor = glow;
    ctx.shadowBlur = lw * 1.6;
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  for (const [a, b] of BONES) {
    if (!vis(lm[a]) || !vis(lm[b])) continue;
    // A per-bone override lets the battle paint the limb you have wrong in a
    // different colour from the rest of you.
    const c = boneColor?.(a, b);
    if (c) { ctx.strokeStyle = c; if (glow) ctx.shadowColor = c; }
    ctx.beginPath();
    ctx.moveTo(X(lm[a]), Y(lm[a]));
    ctx.lineTo(X(lm[b]), Y(lm[b]));
    ctx.stroke();
    if (c) { ctx.strokeStyle = color; if (glow) ctx.shadowColor = glow; }
  }

  // Neck + head: circle sized from ear spread, sitting above the shoulder midpoint.
  const ls = lm[LM.leftShoulder], rs = lm[LM.rightShoulder], nose = lm[LM.nose];
  if (vis(ls) && vis(rs) && vis(nose)) {
    const cx = (X(ls) + X(rs)) / 2, cy = (Y(ls) + Y(rs)) / 2;
    const nx = X(nose), ny = Y(nose);
    const shoulderW = Math.hypot(X(ls) - X(rs), Y(ls) - Y(rs));
    const r = Math.max(lw * 1.15, shoulderW * 0.26);
    const dx = nx - cx, dy = ny - cy;
    const d = Math.hypot(dx, dy) || 1;
    const hx = cx + (dx / d) * (d + r * 0.15), hy = cy + (dy / d) * (d + r * 0.15);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(hx - (dx / d) * r, hy - (dy / d) * r);
    ctx.stroke();
    ctx.beginPath();
    ctx.fillStyle = ghost ? 'transparent' : color;
    ctx.arc(hx, hy, r, 0, Math.PI * 2);
    if (ghost) { ctx.stroke(); } else { ctx.fill(); }
  }
  ctx.restore();
}

// ---------- auto step segmentation ----------
// Finds pauses (local minima of motion energy) and cuts the routine there.
export function segmentSteps(frames, duration, { maxSteps = 12, minLen = 1.2 } = {}) {
  if (frames.length < 10) return [{ label: 'Step 1', start: 0, end: duration }];
  const KEYS = [LM.leftWrist, LM.rightWrist, LM.leftAnkle, LM.rightAnkle, LM.leftKnee, LM.rightKnee, LM.leftElbow, LM.rightElbow];
  const energy = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1], b = frames[i];
    const dt = b.t - a.t || 1 / 30;
    let e = 0;
    for (const k of KEYS) e += Math.hypot(b.lm[k][0] - a.lm[k][0], b.lm[k][1] - a.lm[k][1]);
    energy.push({ t: b.t, e: e / dt });
  }
  // Smooth with a moving average (~0.4 s window).
  const smoothed = energy.map((p, i) => {
    let sum = 0, n = 0;
    for (let j = i; j >= 0 && p.t - energy[j].t < 0.2; j--) { sum += energy[j].e; n++; }
    for (let j = i + 1; j < energy.length && energy[j].t - p.t < 0.2; j++) { sum += energy[j].e; n++; }
    return { t: p.t, e: sum / n };
  });
  const mean = smoothed.reduce((s, p) => s + p.e, 0) / smoothed.length;
  // Candidate cuts: local minima below 60% of mean energy.
  const cuts = [];
  for (let i = 2; i < smoothed.length - 2; i++) {
    const p = smoothed[i];
    if (p.e < mean * 0.6 && p.e <= smoothed[i - 1].e && p.e <= smoothed[i + 1].e) {
      if (!cuts.length || p.t - cuts[cuts.length - 1] > minLen) cuts.push(p.t);
    }
  }
  const bounds = [0, ...cuts.filter((t) => t > minLen && t < duration - minLen), duration];
  let steps = [];
  for (let i = 0; i < bounds.length - 1; i++) steps.push({ start: bounds[i], end: bounds[i + 1] });
  // Merge tiny segments, cap count by merging the shortest neighbours.
  steps = steps.filter((s) => s.end - s.start >= 0.4);
  while (steps.length > maxSteps) {
    let idx = 0, best = Infinity;
    for (let i = 0; i < steps.length; i++) {
      const len = steps[i].end - steps[i].start;
      if (len < best) { best = len; idx = i; }
    }
    if (idx === steps.length - 1) { steps[idx - 1].end = steps[idx].end; }
    else { steps[idx + 1].start = steps[idx].start; }
    steps.splice(idx, 1);
  }
  return steps.map((s, i) => ({ label: `Step ${i + 1}`, ...s }));
}

// ---------- mirroring ----------
// Every left/right landmark pair. Flipping x alone is not a mirror: it moves
// the dancer's left arm across the frame but leaves it labelled "left", so a
// learner copying face-to-face — who answers a left arm with their right —
// scores as if they had used the wrong limb entirely.
const MIRROR_PAIRS = [
  [1, 4], [2, 5], [3, 6], [7, 8], [9, 10],
  [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22],
  [23, 24], [25, 26], [27, 28], [29, 30], [31, 32],
];

// A true mirror image of a pose: x reflected, and the two sides of the body
// exchanged. What the learner sees is then what the learner should do.
export function mirrorPose(lm) {
  if (!lm) return null;
  const out = lm.map((p) => [1 - p[0], p[1], p[2], p[3]]);
  for (const [a, b] of MIRROR_PAIRS) {
    const t = out[a]; out[a] = out[b]; out[b] = t;
  }
  return out;
}

// ---------- pose comparison (practice mode) ----------
const LIMBS = [
  { name: 'left arm', pairs: [[LM.leftShoulder, LM.leftElbow], [LM.leftElbow, LM.leftWrist]] },
  { name: 'right arm', pairs: [[LM.rightShoulder, LM.rightElbow], [LM.rightElbow, LM.rightWrist]] },
  { name: 'left leg', pairs: [[LM.leftHip, LM.leftKnee], [LM.leftKnee, LM.leftAnkle]] },
  { name: 'right leg', pairs: [[LM.rightHip, LM.rightKnee], [LM.rightKnee, LM.rightAnkle]] },
  { name: 'torso', pairs: [[LM.leftShoulder, LM.leftHip], [LM.rightShoulder, LM.rightHip], [LM.leftShoulder, LM.rightShoulder]] },
];

// Which named limb a bone belongs to, so a drawing can colour it by that
// limb's score. Keyed both ways round because BONES and LIMBS list some pairs
// in opposite orders.
const BONE_LIMB = new Map();
for (const limb of LIMBS) {
  for (const [a, b] of limb.pairs) {
    BONE_LIMB.set(`${a}-${b}`, limb.name);
    BONE_LIMB.set(`${b}-${a}`, limb.name);
  }
}
export const limbOfBone = (a, b) => BONE_LIMB.get(`${a}-${b}`) ?? null;

function limbVec(lm, a, b) {
  const dx = lm[b][0] - lm[a][0], dy = lm[b][1] - lm[a][1];
  const n = Math.hypot(dx, dy) || 1;
  return [dx / n, dy / n];
}

// Compares bone *directions*, so it is blind to where in frame you are and how
// big you look. Both poses must already be in the same handedness — mirror the
// reference with mirrorPose() first if the dancer is being copied face-to-face.
export function comparePoses(refLm, userLm) {
  if (!refLm || !userLm) return null;
  const limbScores = [];
  for (const limb of LIMBS) {
    let sum = 0, n = 0;
    for (const [a, b] of limb.pairs) {
      if (refLm[a][3] < 0.35 || refLm[b][3] < 0.35 || userLm[a][3] < 0.35 || userLm[b][3] < 0.35) continue;
      const [rx, ry] = limbVec(refLm, a, b);
      const [ux, uy] = limbVec(userLm, a, b);
      sum += (rx * ux + ry * uy + 1) / 2; // cosine → 0..1
      n++;
    }
    if (n) limbScores.push({ name: limb.name, score: sum / n });
  }
  if (!limbScores.length) return null;
  // Harsh curve so "arms roughly hanging down" doesn't score 80.
  const raw = limbScores.reduce((s, l) => s + l.score, 0) / limbScores.length;
  const score = Math.round(Math.max(0, (raw - 0.5) / 0.5) ** 1.6 * 100);
  limbScores.sort((a, b) => a.score - b.score);
  return { score, worst: limbScores[0], limbs: limbScores };
}

// ---------- joint angles ----------
// Bone directions say a limb is wrong; joint angles say *how*: "your elbow is
// at 165°, theirs is at 90°" is something a coach can turn into words. Interior
// angles don't change sign under reflection, so they compare cleanly between a
// mirrored reference and a learner. x is scaled by the frame aspect because
// landmarks are normalised separately on each axis.
const JOINTS = {
  'left elbow': [LM.leftShoulder, LM.leftElbow, LM.leftWrist],
  'right elbow': [LM.rightShoulder, LM.rightElbow, LM.rightWrist],
  'left shoulder': [LM.leftHip, LM.leftShoulder, LM.leftElbow],
  'right shoulder': [LM.rightHip, LM.rightShoulder, LM.rightElbow],
  'left hip': [LM.leftShoulder, LM.leftHip, LM.leftKnee],
  'right hip': [LM.rightShoulder, LM.rightHip, LM.rightKnee],
  'left knee': [LM.leftHip, LM.leftKnee, LM.leftAnkle],
  'right knee': [LM.rightHip, LM.rightKnee, LM.rightAnkle],
};
export const JOINT_NAMES = Object.keys(JOINTS);

export function jointAngles(lm, aspect = 1) {
  if (!lm) return null;
  const out = {};
  for (const [name, [a, b, c]] of Object.entries(JOINTS)) {
    if (lm[a][3] < VISIBLE || lm[b][3] < VISIBLE || lm[c][3] < VISIBLE) { out[name] = null; continue; }
    const ux = (lm[a][0] - lm[b][0]) * aspect, uy = lm[a][1] - lm[b][1];
    const vx = (lm[c][0] - lm[b][0]) * aspect, vy = lm[c][1] - lm[b][1];
    const nu = Math.hypot(ux, uy), nv = Math.hypot(vx, vy);
    if (!nu || !nv) { out[name] = null; continue; }
    const cos = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (nu * nv)));
    out[name] = Math.round(Math.acos(cos) * 180 / Math.PI);
  }
  return out;
}

// ---------- per-step report ----------
// A battle judges you roughly twice a second. Bucketing those judgements by the
// routine's own steps turns one overall percentage into "step 3 is the one you
// can't do yet, and it's your left arm" — something you can actually go and fix.
//
// samples: [{ t, score, worst, limbs?, you?, ref? }] — worst is the weakest
// limb's name, limbs maps limb name → 0..1, you/ref map joint name → degrees.
// A step nobody was judged in (you were out of frame, or it was outside the
// region) reports accuracy null rather than a made-up zero.
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function scoreSteps(steps, samples) {
  return steps.map((s) => {
    const inStep = samples.filter((x) => x.t >= s.start && x.t < s.end);
    if (!inStep.length) return { ...s, accuracy: null, worst: null, judged: 0, limbs: {}, joints: {} };
    const accuracy = Math.round(mean(inStep.map((x) => x.score)));
    // The limb that was weakest most often across the step, not in one frame.
    const counts = new Map();
    for (const x of inStep) if (x.worst) counts.set(x.worst, (counts.get(x.worst) || 0) + 1);
    let worst = null, most = 0;
    for (const [name, n] of counts) if (n > most) { worst = name; most = n; }

    const limbs = {};
    const limbNames = new Set(inStep.flatMap((x) => Object.keys(x.limbs || {})));
    for (const n of limbNames) {
      const m = mean(inStep.map((x) => x.limbs?.[n]).filter((v) => v != null));
      if (m != null) limbs[n] = Math.round(m * 100);
    }
    // Joint angles only where both of you were visible in the same sample, so
    // the two averages describe the same moments.
    const joints = {};
    for (const n of JOINT_NAMES) {
      const pairs = inStep.filter((x) => x.you?.[n] != null && x.ref?.[n] != null);
      if (!pairs.length) continue;
      const you = Math.round(mean(pairs.map((x) => x.you[n])));
      const ref = Math.round(mean(pairs.map((x) => x.ref[n])));
      joints[n] = { you, ref, diff: you - ref };
    }
    return { ...s, accuracy, worst, judged: inStep.length, limbs, joints };
  });
}

// The step to drill next: lowest accuracy among steps that were actually judged.
export function weakestStep(report) {
  let pick = null;
  for (const s of report) {
    if (s.accuracy == null) continue;
    if (!pick || s.accuracy < pick.accuracy) pick = s;
  }
  return pick;
}

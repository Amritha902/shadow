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
export function framesBounds(frames) {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0, n = 0;
  for (const f of frames) {
    const b = poseBounds(f.lm);
    if (!b) continue;
    x0 = Math.min(x0, b.x0); x1 = Math.max(x1, b.x1);
    y0 = Math.min(y0, b.y0); y1 = Math.max(y1, b.y1);
    n++;
  }
  return n ? { x0, y0, x1, y1 } : null;
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
    ctx.beginPath();
    ctx.moveTo(X(lm[a]), Y(lm[a]));
    ctx.lineTo(X(lm[b]), Y(lm[b]));
    ctx.stroke();
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

// ---------- pose comparison (practice mode) ----------
const LIMBS = [
  { name: 'left arm', pairs: [[LM.leftShoulder, LM.leftElbow], [LM.leftElbow, LM.leftWrist]] },
  { name: 'right arm', pairs: [[LM.rightShoulder, LM.rightElbow], [LM.rightElbow, LM.rightWrist]] },
  { name: 'left leg', pairs: [[LM.leftHip, LM.leftKnee], [LM.leftKnee, LM.leftAnkle]] },
  { name: 'right leg', pairs: [[LM.rightHip, LM.rightKnee], [LM.rightKnee, LM.rightAnkle]] },
  { name: 'torso', pairs: [[LM.leftShoulder, LM.leftHip], [LM.rightShoulder, LM.rightHip], [LM.leftShoulder, LM.rightShoulder]] },
];

function limbVec(lm, a, b, mirror) {
  const ax = mirror ? 1 - lm[a][0] : lm[a][0];
  const bx = mirror ? 1 - lm[b][0] : lm[b][0];
  const dx = bx - ax, dy = lm[b][1] - lm[a][1];
  const n = Math.hypot(dx, dy) || 1;
  return [dx / n, dy / n];
}

// Compares bone *directions* (scale/position invariant). mirrorUser flips the
// user's pose so facing a webcam feels like dancing in front of a mirror.
export function comparePoses(refLm, userLm, { mirrorUser = true } = {}) {
  if (!refLm || !userLm) return null;
  const limbScores = [];
  for (const limb of LIMBS) {
    let sum = 0, n = 0;
    for (const [a, b] of limb.pairs) {
      if (refLm[a][3] < 0.35 || refLm[b][3] < 0.35 || userLm[a][3] < 0.35 || userLm[b][3] < 0.35) continue;
      const [rx, ry] = limbVec(refLm, a, b, false);
      const [ux, uy] = limbVec(userLm, a, b, mirrorUser);
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

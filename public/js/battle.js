// Battle engine — the reference dancer and you, on the same stage, scored live.
//
// Everything here runs at display refresh: the reference stickman is
// interpolated from cached pose data, your pose comes off the webcam through
// MediaPipe, and the two are compared bone-direction to bone-direction. The
// score you see is the score, computed on your device, no round trips.

import { poseAt, drawStickman, comparePoses, mirrorPose, framesBounds, poseBounds, easeBounds, limbOfBone, scoreSteps, jointAngles } from './stickman.js';
import { createLandmarker } from './pose.js';
import { BurnMeter, intensityLabel } from './fitness.js';
import { h, beep } from './ui.js';

const JUDGEMENTS = [
  { at: 88, label: 'PERFECT', points: 300, cls: 'perfect' },
  { at: 72, label: 'GREAT', points: 200, cls: 'great' },
  { at: 55, label: 'GOOD', points: 100, cls: 'good' },
  { at: 35, label: 'OFF', points: 25, cls: 'off' },
  { at: -1, label: 'MISS', points: 0, cls: 'miss' },
];
// A limb whose bone directions agree less than this (0..1, cosine-based, so 0.5
// is perpendicular) is drawn in OFF_COLOR on your stickman.
const OFF_LIMB = 0.8;
const OFF_COLOR = '#ff2d55';

const judge = (s) => JUDGEMENTS.find((j) => s >= j.at);

// Combo multiplier caps at 4x — high enough to make a clean run feel special,
// low enough that one great streak can't outweigh the whole rest of the song.
const multiplier = (combo) => Math.min(4, 1 + Math.floor(combo / 8) * 0.5);

export class Battle {
  /**
   * @param {object} o
   * @param {HTMLElement} o.mount        container to render the stage into
   * @param {Array}  o.frames            cached reference pose frames
   * @param {string} o.videoUrl          reference video (audio + timing source)
   * @param {[number,number]} [o.region] [start,end] seconds — defaults to whole clip
   * @param {boolean} [o.mirror]         mirror the reference (face-to-face teaching)
   * @param {number} [o.rate]            playback rate
   * @param {Array}  [o.steps]           [{label,start,end}] — scored separately in the result
   */
  constructor(o) {
    this.o = { mirror: true, rate: 1, aspect: 16 / 9, ...o };
    // Each dancer is drawn to fill the same box, so someone standing across the
    // room overlays the reference exactly as well as someone up close. The
    // score already ignores scale; now the picture agrees with it.
    this.refBounds = framesBounds(this.o.frames);
    this.userBounds = null;
    this.score = 0;
    this.combo = 0;
    this.bestCombo = 0;
    this.samples = [];
    this.timeline = [];
    this.tally = { PERFECT: 0, GREAT: 0, GOOD: 0, OFF: 0, MISS: 0 };
    this.running = false;
    this._pops = [];
    this._smooth = 0;
    this._lastJudge = 0;
    this._window = [];
    // The workout side of the score: your own motion, turned into calories live.
    this.burn = new BurnMeter({ weightKg: this.o.weightKg || 65 });
  }

  async mountUI() {
    const o = this.o;
    this.video = h('video', { src: o.videoUrl, playsinline: true, preload: 'auto', class: 'battle-ref-video' });
    this.cam = h('video', { playsinline: true, muted: true, autoplay: true, class: 'battle-cam-video' });
    this.canvas = h('canvas', { class: 'battle-canvas' });
    this.camPip = h('div', { class: 'battle-pip' }, this.cam);

    this.hud = h('div', { class: 'battle-hud' },
      this.elScore = h('div', { class: 'hud-score' }, '0'),
      this.elCombo = h('div', { class: 'hud-combo' }),
      this.elBar = h('div', { class: 'hud-bar' }, this.elBarFill = h('i')),
      this.elBurn = h('div', { class: 'hud-burn' }, h('b', {}, '0'), h('small', {}, 'kcal')),
    );
    this.judgeLayer = h('div', { class: 'battle-judge' });
    this.countIn = h('div', { class: 'battle-countin' });
    this.stage = h('div', { class: 'battle-stage' },
      this.canvas, this.camPip, this.hud, this.judgeLayer, this.countIn,
    );
    o.mount.append(this.stage);

    const ctx = this.canvas.getContext('2d');
    this.ctx = ctx;
    this._resize = () => {
      const r = this.stage.getBoundingClientRect();
      const dpr = Math.min(devicePixelRatio || 1, 2);
      this.canvas.width = r.width * dpr;
      this.canvas.height = r.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.W = r.width; this.H = r.height;
    };
    this._resize();
    addEventListener('resize', this._resize);

    // Camera first: if it's denied there's no game, and we'd rather say so
    // before the model download makes the user wait.
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false,
    });
    this.cam.srcObject = this.stream;
    await this.cam.play();
    this.camAspect = (this.cam.videoWidth / this.cam.videoHeight) || 4 / 3;
    this.landmarker = await createLandmarker();
    await new Promise((res) => {
      if (this.video.readyState >= 2) return res();
      this.video.onloadeddata = res;
    });
  }

  /** @param {number} [startAt] wall-clock ms for a synchronised party start */
  async start(startAt) {
    const [from] = this.o.region || [0];
    this.video.currentTime = from;
    this.video.playbackRate = this.o.rate;

    // Count-in: four beats, drawn big, so nobody is still finding their mark
    // when the first pose lands.
    const beats = 4;
    const gap = startAt ? Math.max(0, startAt - Date.now()) / beats : 700;
    for (let i = beats; i > 0; i--) {
      this.countIn.textContent = i === 1 ? 'GO' : String(i - 1 || 1);
      this.countIn.className = 'battle-countin show';
      beep(i === 1 ? 1320 : 660, 0.09, 0.16, 'triangle');
      await new Promise((r) => setTimeout(r, gap));
      this.countIn.className = 'battle-countin';
    }
    this.countIn.textContent = '';

    this.running = true;
    await this.video.play().catch(() => {});
    this._loop();
    this._detect();
  }

  // Two loops on purpose: drawing must never wait on inference. The renderer
  // runs every frame; detection runs as fast as the model allows and leaves its
  // latest result behind for the renderer to pick up.
  _detect() {
    const tick = () => {
      if (!this.running) return;
      if (this.cam.readyState >= 2) {
        try {
          const res = this.landmarker.detectForVideo(this.cam, performance.now());
          const lm = res.landmarks?.[0];
          this.userPose = lm ? lm.map((p) => [p.x, p.y, p.z, p.visibility ?? 1]) : null;
        } catch { /* transient GPU hiccup; next frame will do */ }
      }
      requestAnimationFrame(tick);
    };
    tick();
  }

  _loop() {
    const o = this.o;
    const [, to] = o.region || [0, Infinity];

    const frame = () => {
      if (!this.running) return;
      const t = this.video.currentTime;
      if (t >= to || this.video.ended) { this.stop(); this.o.onEnd?.(this.result()); return; }

      const ref = poseAt(o.frames, t);
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.W, this.H);

      // The dancer is shown exactly as filmed, and you are shown as a mirror
      // would show you. Copying face-to-face means answering their left arm
      // with your right, and those two land on the same side of the screen —
      // so the figures overlap when you have it right, which is the whole game.
      drawStickman(ctx, ref, {
        W: this.W, H: this.H, fit: this.refBounds, aspect: o.aspect,
        color: '#fdf6e9', alpha: 0.5, lineWidth: Math.max(5, this.W * 0.014),
      });

      let cmp = null;
      if (this.userPose) {
        // Score against the reflection, not the original: reflecting swaps the
        // sides of the body, which flipping x alone does not, and without it
        // every mirrored limb would read as the wrong limb.
        this._ref = o.mirror ? mirrorPose(ref) : ref;
        cmp = comparePoses(this._ref, this.userPose);
        const hot = cmp && cmp.score >= 72;
        this.userBounds = easeBounds(this.userBounds, poseBounds(this.userPose), 0.12);
        // Limbs well off the reference turn red, so you can see which part of
        // you is wrong without reading anything. The comparison runs on your
        // own landmark labels, so a limb name maps straight onto your bones.
        const off = new Set((cmp?.limbs || []).filter((l) => l.score < OFF_LIMB).map((l) => l.name));
        drawStickman(ctx, this.userPose, {
          W: this.W, H: this.H, mirror: o.mirror,
          fit: this.userBounds, aspect: this.camAspect,
          color: hot ? getCSS('--good') : getCSS('--accent'),
          glow: hot ? getCSS('--good') : getCSS('--accent'),
          lineWidth: Math.max(4, this.W * 0.011),
          boneColor: off.size ? (a, b) => (off.has(limbOfBone(a, b)) ? OFF_COLOR : null) : null,
        });
      }

      // Calories accrue from your own motion, timed by the wall clock so the
      // rate is right even when the model drops frames.
      if (this.userPose) this.burn.push(this.userPose, performance.now() / 1000);

      if (cmp) this._accumulate(cmp, t);
      this._drawPops(ctx);
      this._paintHud(cmp);
      requestAnimationFrame(frame);
    };
    frame();
  }

  // Scoring happens on a beat-ish cadence, not per frame: judging 60 times a
  // second would be unreadable and would punish a single blurry frame.
  _accumulate(cmp, t) {
    this._window.push(cmp.score);
    this._smooth = this._smooth * 0.85 + cmp.score * 0.15;
    if (t - this._lastJudge < 0.45) return;
    this._lastJudge = t;

    const avg = this._window.reduce((a, b) => a + b, 0) / this._window.length;
    this._window.length = 0;
    this.samples.push(avg);
    // What the coach gets to read afterwards: per-limb agreement and the actual
    // joint angles, yours against the (mirrored) reference, at this moment.
    this.timeline.push({
      t, score: avg, worst: cmp.worst?.name || null,
      limbs: Object.fromEntries(cmp.limbs.map((l) => [l.name, l.score])),
      you: jointAngles(this.userPose, this.camAspect),
      ref: jointAngles(this._ref, this.o.aspect),
    });

    const j = judge(avg);
    this.tally[j.label]++;
    if (j.points > 25) {
      this.combo++;
      this.bestCombo = Math.max(this.bestCombo, this.combo);
    } else {
      this.combo = 0;
    }
    this.score += Math.round(j.points * multiplier(this.combo));
    this._pop(j, cmp.worst);
    if (j.label === 'PERFECT') beep(1180, 0.05, 0.07, 'triangle');
    else if (j.label === 'MISS') beep(180, 0.09, 0.05, 'sawtooth');
    this.o.onTick?.({ score: this.score, combo: this.combo, judgement: j.label, worst: cmp.worst });
  }

  _pop(j, worst) {
    const el = h('div', { class: `judge ${j.cls}` },
      h('b', {}, j.label),
      j.label === 'MISS' || j.label === 'OFF' ? h('small', {}, worst ? `check your ${worst.name}` : '') : null,
      this.combo > 3 ? h('em', {}, `${this.combo}×`) : null,
    );
    this.judgeLayer.append(el);
    requestAnimationFrame(() => el.classList.add('in'));
    setTimeout(() => el.remove(), 900);
  }

  _drawPops() { /* judgements are DOM; kept as a hook for canvas-side FX */ }

  _paintHud(cmp) {
    this.elScore.textContent = this.score.toLocaleString();
    const m = multiplier(this.combo);
    this.elCombo.textContent = this.combo > 2 ? `${this.combo} combo · ${m}×` : '';
    this.elCombo.className = `hud-combo${this.combo > 7 ? ' hot' : ''}`;
    const pct = Math.max(0, Math.min(100, cmp ? this._smooth : 0));
    this.elBarFill.style.width = `${pct}%`;
    this.elBarFill.style.background = pct > 72 ? getCSS('--good') : pct > 45 ? getCSS('--warn') : getCSS('--accent');
    this.elBurn.firstChild.textContent = this.burn.kcal.toFixed(1);
    this.elBurn.classList.toggle('hot', this.burn.intensity > 0.6);
  }

  result() {
    const acc = this.samples.length
      ? this.samples.reduce((a, b) => a + b, 0) / this.samples.length
      : 0;
    const rank = acc >= 85 ? 'S' : acc >= 75 ? 'A' : acc >= 62 ? 'B' : acc >= 45 ? 'C' : 'D';
    const b = this.burn.summary();
    return {
      score: this.score, accuracy: Math.round(acc), bestCombo: this.bestCombo,
      tally: { ...this.tally }, rank,
      kcal: b.kcal, activeSeconds: b.activeSeconds, intensity: b.peakIntensity,
      intensityLabel: intensityLabel(b.peakIntensity),
      steps: scoreSteps(this.o.steps || [], this.timeline),
    };
  }

  stop() {
    this.running = false;
    try { this.video.pause(); } catch { /* already gone */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.landmarker?.close();
    removeEventListener('resize', this._resize);
  }
}

const cssCache = new Map();
function getCSS(name) {
  if (!cssCache.has(name)) {
    cssCache.set(name, getComputedStyle(document.documentElement).getPropertyValue(name).trim());
  }
  return cssCache.get(name);
}

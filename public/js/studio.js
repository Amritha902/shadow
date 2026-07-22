// Studio — where you actually learn the move.
//
// The video and a clean stickman of the same dancer play in lockstep. The
// stickman is the point: no costume, no camera move, no crowd, just the shape
// your body is supposed to make. Loop the hook, halve the speed, mirror it so
// left stays left, and drill.

import { poseAt, drawStickman, segmentSteps, framesBounds } from './stickman.js';
import { findHook, estimateTempo } from './hook.js';
import { h, clear, fmtTime, store, toast } from './ui.js';

export function Studio({ meta, pose, onBattle, onOpen }) {
  const frames = pose.frames;
  const duration = pose.duration || meta.duration;
  const aspect = pose.aspect || 16 / 9;
  const bounds = framesBounds(frames);

  const { hook, loops } = findHook(frames, duration);
  const bpm = estimateTempo(frames, duration);
  const steps = segmentSteps(frames, duration);

  let mirror = store.get('mirror', true);
  let rate = store.get('rate', 1);
  let region = hook ? [hook.start, hook.end] : [0, duration];
  let looping = true;
  let stickOnly = false;

  const video = h('video', {
    src: `/videos/${meta.id}.mp4`, playsinline: true, preload: 'auto', class: 'studio-video',
  });
  const canvas = h('canvas', { class: 'studio-canvas' });
  const ctx = canvas.getContext('2d');

  const scrub = h('div', { class: 'scrub' },
    h('div', { class: 'scrub-track' },
      ...loops.map((l) => h('i', {
        class: 'scrub-loop',
        style: { left: `${(l.start / duration) * 100}%`, width: `${((l.end - l.start) / duration) * 100}%` },
        title: 'the hook, again',
      })),
      h('i', { class: 'scrub-region' }),
      h('i', { class: 'scrub-head' }),
    ),
  );
  const regionEl = scrub.querySelector('.scrub-region');
  const headEl = scrub.querySelector('.scrub-head');
  const timeEl = h('span', { class: 'studio-time' }, '0:00');

  const setRegion = (a, b, label) => {
    region = [a, b];
    regionEl.style.left = `${(a / duration) * 100}%`;
    regionEl.style.width = `${((b - a) / duration) * 100}%`;
    video.currentTime = a;
    if (label) toast(`Looping ${label}`);
    paintChips();
  };

  // ---------- controls ----------
  const speeds = [0.25, 0.5, 0.75, 1];
  const speedBtns = speeds.map((s) => h('button', {
    class: `pill${s === rate ? ' on' : ''}`,
    onclick: () => {
      rate = s; video.playbackRate = s; store.set('rate', s);
      speedBtns.forEach((b, i) => b.classList.toggle('on', speeds[i] === s));
    },
  }, `${s}×`));

  const mirrorBtn = h('button', {
    class: `pill${mirror ? ' on' : ''}`,
    title: 'Flip the dancer so their left is your left',
    onclick: () => { mirror = !mirror; store.set('mirror', mirror); mirrorBtn.classList.toggle('on', mirror); },
  }, '⇄ Mirror');

  const loopBtn = h('button', {
    class: `pill${looping ? ' on' : ''}`,
    onclick: () => { looping = !looping; loopBtn.classList.toggle('on', looping); },
  }, '↻ Loop');

  const soloBtn = h('button', {
    class: 'pill',
    title: 'Hide the video and learn the shape alone',
    onclick: () => {
      stickOnly = !stickOnly;
      soloBtn.classList.toggle('on', stickOnly);
      stageEl.classList.toggle('stick-only', stickOnly);
    },
  }, '🕺 Stickman only');

  const playBtn = h('button', { class: 'play', onclick: () => (video.paused ? video.play() : video.pause()) }, '▶');
  video.addEventListener('play', () => { playBtn.textContent = '❚❚'; });
  video.addEventListener('pause', () => { playBtn.textContent = '▶'; });

  // ---------- step chips ----------
  const chipRow = h('div', { class: 'chips' });
  function paintChips() {
    clear(chipRow);
    const isOn = (a, b) => Math.abs(region[0] - a) < 0.05 && Math.abs(region[1] - b) < 0.05;
    if (hook) {
      chipRow.append(h('button', {
        class: `chip hook${isOn(hook.start, hook.end) ? ' on' : ''}`,
        onclick: () => setRegion(hook.start, hook.end, 'the hook'),
      }, '★ The hook', h('small', {}, `${(hook.end - hook.start).toFixed(1)}s`)));
    }
    chipRow.append(h('button', {
      class: `chip${isOn(0, duration) ? ' on' : ''}`,
      onclick: () => setRegion(0, duration, 'the full routine'),
    }, 'Full routine'));
    for (const s of steps) {
      chipRow.append(h('button', {
        class: `chip${isOn(s.start, s.end) ? ' on' : ''}`,
        onclick: () => setRegion(s.start, s.end, s.label.toLowerCase()),
      }, s.label, h('small', {}, `${(s.end - s.start).toFixed(1)}s`)));
    }
  }

  scrub.addEventListener('pointerdown', (e) => {
    const r = scrub.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration;
    video.currentTime = t;
    if (t < region[0] || t > region[1]) setRegion(0, duration);
  });

  const stageEl = h('div', { class: 'studio-stage' },
    h('div', { class: 'studio-pane video-pane' }, video, h('span', { class: 'pane-label' }, 'Original')),
    h('div', { class: 'studio-pane stick-pane' }, canvas, h('span', { class: 'pane-label' }, 'The shape')),
  );

  const root = h('div', { class: 'studio' },
    h('header', { class: 'studio-head' },
      h('div', {},
        h('h1', {}, meta.title),
        h('p', { class: 'muted' },
          meta.channel,
          bpm ? ` · ~${bpm} BPM` : '',
          hook ? ` · hook repeats ${hook.reps}×` : '',
        ),
      ),
      h('button', { class: 'btn primary', onclick: () => onBattle(region) }, 'Battle this →'),
    ),
    hook && hook.confidence > 0.25
      ? h('div', { class: 'hook-note' },
          h('b', {}, '★ Found the hookstep.'),
          ` The ${(hook.end - hook.start).toFixed(1)}-second phrase at ${fmtTime(hook.start)} comes back ${hook.reps} times — that's the bit people recognise. It's queued up and looping.`,
        )
      : null,
    stageEl,
    h('div', { class: 'studio-transport' }, playBtn, scrub, timeEl),
    h('div', { class: 'studio-controls' }, ...speedBtns, mirrorBtn, loopBtn, soloBtn),
    chipRow,
    h('section', { class: 'similar' },
      h('h2', {}, 'Learn it from someone else'),
      h('p', { class: 'muted' }, 'Same song, different teacher. Sometimes a slower breakdown is the whole answer.'),
      h('div', { class: 'similar-grid loading' }, h('span', { class: 'muted' }, 'Looking…')),
    ),
  );
  paintChips();
  setRegion(region[0], region[1]);

  // ---------- render loop ----------
  const resize = () => {
    const r = canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = r.width * dpr; canvas.height = r.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    canvas._w = r.width; canvas._h = r.height;
  };
  resize();
  addEventListener('resize', resize);

  let alive = true;
  (function frame() {
    if (!alive) return;
    const t = video.currentTime;
    if (looping && t >= region[1] - 0.03) video.currentTime = region[0];
    ctx.clearRect(0, 0, canvas._w, canvas._h);
    drawStickman(ctx, poseAt(frames, t), {
      W: canvas._w, H: canvas._h, mirror, fit: bounds, aspect,
      color: getComputedStyle(document.documentElement).getPropertyValue('--ink').trim(),
      lineWidth: Math.max(5, canvas._w * 0.016),
    });
    video.style.transform = mirror ? 'scaleX(-1)' : '';
    headEl.style.left = `${(t / duration) * 100}%`;
    timeEl.textContent = `${fmtTime(t)} / ${fmtTime(duration)}`;
    requestAnimationFrame(frame);
  })();

  video.playbackRate = rate;
  video.play().catch(() => { /* autoplay blocked — the play button is right there */ });

  // Related routines load after the studio is usable; never block on search.
  fetch(`/api/videos/${meta.id}/similar`).then((r) => r.json()).then((items) => {
    const grid = root.querySelector('.similar-grid');
    clear(grid).classList.remove('loading');
    if (!items.length) {
      grid.append(h('p', { class: 'muted' }, 'No close matches came back for this one.'));
      return;
    }
    for (const it of items) {
      grid.append(h('button', { class: 'sim-card', onclick: () => onOpen(`https://www.youtube.com/watch?v=${it.id}`) },
        h('img', { src: it.thumbnail, alt: '', loading: 'lazy' }),
        h('span', { class: 'sim-title' }, it.title),
        h('span', { class: 'sim-meta' }, it.channel, it.duration ? ` · ${fmtTime(it.duration)}` : ''),
      ));
    }
  }).catch(() => {});

  return {
    el: root,
    region: () => region,
    destroy() { alive = false; removeEventListener('resize', resize); video.pause(); video.src = ''; },
  };
}

// Small DOM + feedback helpers. No framework: the app has four screens and
// hand-written DOM keeps the frame budget for the canvases.

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(9)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

export function fmtTime(s) {
  if (!Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

let toastHost;
export function toast(message, kind = '') {
  toastHost ||= document.body.appendChild(h('div', { class: 'toasts' }));
  const t = h('div', { class: `toast ${kind}` }, message);
  toastHost.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, 3400);
}

// Confetti, on a canvas we tear down as soon as the last piece falls — no
// permanent overlay eating pointer events.
export function confetti({ count = 90, colors = ['#e8532f', '#f0b429', '#2e7d4f', '#201b16', '#c23e1e'] } = {}) {
  const cv = h('canvas', { class: 'confetti' });
  document.body.append(cv);
  const ctx = cv.getContext('2d');
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const resize = () => {
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  const bits = Array.from({ length: count }, () => ({
    x: innerWidth * (0.2 + Math.random() * 0.6),
    y: -20 - Math.random() * innerHeight * 0.4,
    vx: (Math.random() - 0.5) * 4,
    vy: 2 + Math.random() * 4,
    w: 5 + Math.random() * 7,
    hgt: 8 + Math.random() * 10,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    c: colors[Math.floor(Math.random() * colors.length)],
  }));
  let alive = true;
  (function frame() {
    if (!alive) return;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    let onscreen = 0;
    for (const b of bits) {
      b.x += b.vx; b.y += b.vy; b.vy += 0.12; b.rot += b.vr;
      if (b.y < innerHeight + 40) onscreen++;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rot);
      ctx.fillStyle = b.c;
      ctx.fillRect(-b.w / 2, -b.hgt / 2, b.w, b.hgt);
      ctx.restore();
    }
    if (onscreen === 0) { alive = false; cv.remove(); return; }
    requestAnimationFrame(frame);
  })();
  setTimeout(() => { alive = false; cv.remove(); }, 6000);
}

// Short synthesised cues. Loading an audio file for a 40 ms tick would be silly,
// and WebAudio lets us keep the count-in perfectly in sync with the clock.
let ac;
export function beep(freq = 880, dur = 0.07, gain = 0.12, type = 'sine') {
  try {
    ac ||= new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(gain, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
    osc.connect(g).connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + dur);
  } catch { /* audio is decoration */ }
}

export const store = {
  get(k, fallback) {
    try { const v = localStorage.getItem(`choreo.${k}`); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(k, v) { localStorage.setItem(`choreo.${k}`, JSON.stringify(v)); },
};

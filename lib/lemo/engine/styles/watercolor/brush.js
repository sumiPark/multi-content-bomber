// 수채 붓 엔진 — lemo-opuscar styles/watercolor/demo/engine.js(MIT, Copyright 2026 LemoLab)의 붓 자국 부분을 ES 모듈로 옮겼다.
// 한 획 = 폭이 변하는 리본(옅은 물감) + 몇 가닥 마른 붓 결(비백). 겹치면 진해진다. 벡터 외곽선은 없다.
// 결정적: 난수는 withSeed(시드, fn) 안에서만 쓴다(render(t) 안에서 만든 획은 늘 같은 시드 — STYLE.md §9).
import { clamp, lerp } from '/core/lib.js';

function mulberry(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
let RNG = mulberry(20260924);
export const rnd = (a = 0, b = 1) => a + (b - a) * RNG();
export function withSeed(seed, fn) { const keep = RNG; RNG = mulberry(seed); try { return fn(); } finally { RNG = keep; } }
const hash = n => { n = Math.sin(n * 127.1 + 311.7) * 43758.5453; return n - Math.floor(n); };
export const vnoise = x => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return lerp(hash(i), hash(i + 1), u); };
export const fbm = x => vnoise(x) * 0.55 + vnoise(x * 2.1 + 17) * 0.3 + vnoise(x * 4.3 + 41) * 0.15;

const _rgb = {};
const hex2rgb = h => _rgb[h] || (_rgb[h] = [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
export const mixc = (a, b, t) => { const A = hex2rgb(a), B = hex2rgb(b); return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join(''); };
export const rgba = (h, a) => { const c = hex2rgb(h); return `rgba(${c[0]},${c[1]},${c[2]},${clamp(a).toFixed(3)})`; };

export function qcurve(x0, y0, x1, y1, bend = 0, n = 12) {
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1;
  const cx = mx - dy / L * bend, cy = my + dx / L * bend, out = [];
  for (let i = 0; i <= n; i++) { const t = i / n, u = 1 - t; out.push([u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1]); }
  return out;
}

// 한 획: 중심선 + 폭 윤곽 + 마른 붓 결
export function mk(pts, w, col, o = {}) {
  const n = pts.length, ws = [], nx = [], ny = [];
  const seed = rnd(0, 1000), rough = o.rough ?? 0.22, prof = o.prof || 'brush';
  for (let i = 0; i < n; i++) {
    const s = i / (n - 1); let f;
    if (prof === 'leaf') f = Math.pow(Math.sin(Math.PI * (s * 0.94 + 0.03)), 0.7);
    else if (prof === 'even') f = Math.min(1, s / 0.06 + 0.35) * Math.min(1, (1 - s) / 0.08 + 0.4);
    else if (prof === 'tip') f = Math.pow(1 - s * 0.92, 0.85) * Math.min(1, s / 0.05 + 0.6);
    else if (prof === 'trunk') f = (1 - s * 0.62) * (1 + Math.max(0, 0.06 - s) * 9);
    else f = Math.min(1, s / 0.1 + 0.3) * Math.pow(1 - s * 0.85, 0.6);
    ws.push(Math.max(0.5, w * f * (1 + rough * (vnoise(seed + i * 0.9) * 2 - 1))));
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    nx.push(-dy / L); ny.push(dx / L);
  }
  const nb = o.nb ?? (w >= 6 ? Math.min(9, Math.max(3, Math.round(w / 3.2))) : 0);
  let br = null;
  if (nb > 0) {
    br = [];
    for (let j = 0; j < nb; j++) {
      const dash = []; for (let k = 0; k < 6; k++) dash.push(k % 2 ? rnd(1, w * 0.5 + 3) : rnd(18, 90));
      br.push({ off: rnd(-0.46, 0.46), bw: Math.max(0.7, w / nb * rnd(0.6, 1.3)), a: rnd(0.3, 0.85), end: rnd(0.72, 1), dash });
    }
  }
  return { pts, ws, nx, ny, col, a: o.a ?? 0.92, rib: o.rib ?? (nb ? 0.62 : 0.92), br };
}

// 획을 p(0~1)만큼 칠한다(붓끝이 지나가는 중)
export function drawS(c, s, p = 1, col = null, am = 1) {
  if (p <= 0) return;
  const P = s.pts, n = P.length, m = (n - 1) * clamp(p), k = Math.floor(m), f = m - k, cc = col || s.col;
  const cnt = f > 0.001 && k < n - 1 ? k + 2 : k + 1;
  const X = i => (i <= k ? P[i][0] : lerp(P[k][0], P[k + 1][0], f)), Y = i => (i <= k ? P[i][1] : lerp(P[k][1], P[k + 1][1], f));
  c.beginPath();
  for (let i = 0; i < cnt; i++) { const j = Math.min(i, n - 1), hw = s.ws[j] / 2 * (p < 1 && i === cnt - 1 ? 0.5 : 1); const x = X(i) + s.nx[j] * hw, y = Y(i) + s.ny[j] * hw; if (i) c.lineTo(x, y); else c.moveTo(x, y); }
  for (let i = cnt - 1; i >= 0; i--) { const j = Math.min(i, n - 1), hw = s.ws[j] / 2 * (p < 1 && i === cnt - 1 ? 0.5 : 1); c.lineTo(X(i) - s.nx[j] * hw, Y(i) - s.ny[j] * hw); }
  c.closePath(); c.fillStyle = rgba(cc, s.a * s.rib * am); c.fill();
  if (s.br) {
    c.lineCap = 'round'; c.lineJoin = 'round';
    for (const b of s.br) {
      const e = Math.min(m, (n - 1) * b.end), kk = Math.floor(e); if (kk < 1) continue;
      c.beginPath();
      for (let i = 0; i <= kk; i++) { const hw = s.ws[i] * b.off, x = P[i][0] + s.nx[i] * hw, y = P[i][1] + s.ny[i] * hw; if (i) c.lineTo(x, y); else c.moveTo(x, y); }
      c.setLineDash(b.dash); c.lineWidth = b.bw; c.strokeStyle = rgba(cc, s.a * b.a * am); c.stroke();
    }
    c.setLineDash([]);
  }
}

// 같은 다각형을 세 번 흔들어 옅게 겹쳐 칠한다 — 가장자리가 고여 진해지는 물감(데모 scene.js washPoly)
export function washPoly(c, pts, fill, a, passes = 3, jit = 5) {
  const keep = c.globalAlpha;
  for (let p = 0; p < passes; p++) {
    c.beginPath(); pts.forEach(([x, y], i) => { const xx = x + (i % 3 === 1 ? rnd(-jit, jit) : 0), yy = y + (i % 3 === 0 ? rnd(-jit, jit) : 0); if (i) c.lineTo(xx, yy); else c.moveTo(xx, yy); });
    c.closePath(); c.globalAlpha = keep * (a / passes) * 1.6; c.fillStyle = fill; c.fill();
  }
  c.globalAlpha = keep;
}

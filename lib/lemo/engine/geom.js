// 공용 도형 도구(스타일과 무관, 모든 좌표는 세계 좌표 px).
// ellipse · handCircle · bez · smooth · xf는 lemo-opuscar styles/crayon-book/demo/crayon.js,
// tube · curve는 styles/crayon-book/demo/rig.js에서 복사했다.
// 출처: lemo-opuscar (MIT, Copyright 2026 LemoLab) — 원문 라이선스는 LICENSE-lemo-opuscar
import { clamp, hash } from '/core/lib.js';

export function ellipse(cx, cy, rx, ry, n = 48, a0 = 0, a1 = Math.PI * 2, rot = 0) {
  const out = []; const c = Math.cos(rot), s = Math.sin(rot);
  for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; const x = Math.cos(a) * rx, y = Math.sin(a) * ry; out.push([cx + x * c - y * s, cy + x * s + y * c]); }
  return out;
}
// 손으로 그린 동그라미: 시작과 끝이 조금 어긋나고 살짝 찌그러짐
export function handCircle(cx, cy, r, seed = 1, over = 0.12, n = 56) {
  const out = []; const a0 = hash(seed) * 6.28;
  for (let i = 0; i <= n; i++) { const u = i / n; const a = a0 + u * Math.PI * 2 * (1 + over); const rr = r * (1 + 0.035 * Math.sin(a * 2 + seed) + (u > 1 - over ? 0.04 * (u - (1 - over)) / over : 0)); out.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]); }
  return out;
}
// 3차 베지어 사슬: [p0, c1, c2, p1, c3, c4, p2, ...]
export function bez(c, n = 16) {
  const out = [c[0]];
  for (let i = 0; i + 3 < c.length; i += 3) {
    const [a, b, d, e] = [c[i], c[i + 1], c[i + 2], c[i + 3]];
    for (let k = 1; k <= n; k++) { const t = k / n, u = 1 - t; out.push([u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * d[0] + t * t * t * e[0], u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * d[1] + t * t * t * e[1]]); }
  }
  return out;
}
// 부드러운 닫힌 곡선(Catmull-Rom)
export function smooth(pts, n = 8, closed = true) {
  const out = []; const m = pts.length; const N = closed ? m : m - 1;
  for (let i = 0; i < N; i++) {
    const p0 = pts[(i - 1 + m) % m], p1 = pts[i], p2 = pts[(i + 1) % m], p3 = pts[(i + 2) % m];
    const P0 = closed || i > 0 ? p0 : p1, P3 = closed || i + 2 < m ? p3 : p2;
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      out.push([0.5 * ((2 * p1[0]) + (-P0[0] + p2[0]) * t + (2 * P0[0] - 5 * p1[0] + 4 * p2[0] - P3[0]) * t2 + (-P0[0] + 3 * p1[0] - 3 * p2[0] + P3[0]) * t3),
        0.5 * ((2 * p1[1]) + (-P0[1] + p2[1]) * t + (2 * P0[1] - 5 * p1[1] + 4 * p2[1] - P3[1]) * t2 + (-P0[1] + 3 * p1[1] - 3 * p2[1] + P3[1]) * t3)]);
    }
  }
  if (!closed) out.push(pts[m - 1]); else out.push(out[0]);
  return out;
}
// 이동 · 회전 · 확대
export function xf(pts, { x = 0, y = 0, r = 0, s = 1, sx: kx = 1, sy: ky = 1, ox = 0, oy = 0 } = {}) {
  const c = Math.cos(r), sn = Math.sin(r);
  return pts.map(([px, py]) => { const X = (px - ox) * s * kx, Y = (py - oy) * s * ky; return [x + ox + X * c - Y * sn, y + oy + X * sn + Y * c]; });
}
// 팔다리 관: 꺾은선 양쪽 오프셋 + 둥근 끝, 닫힌 다각형을 돌려준다
export function tube(pts, w0, w1 = w0) {
  const n = pts.length; const L = [], R = [];
  const dirs = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1]; const d = Math.hypot(dx, dy) || 1; dx /= d; dy /= d; dirs.push([dx, dy]);
    const w = (w0 + (w1 - w0) * i / (n - 1)) / 2;
    L.push([pts[i][0] - dy * w, pts[i][1] + dx * w]); R.push([pts[i][0] + dy * w, pts[i][1] - dx * w]);
  }
  const cap = (c, d, w, from) => { const out = []; const a0 = Math.atan2(d[1], d[0]); for (let k = 1; k < 8; k++) { const a = a0 + from + Math.PI * k / 8; out.push([c[0] + Math.cos(a) * w, c[1] + Math.sin(a) * w]); } return out; };
  return [...L, ...cap(pts[n - 1], dirs[n - 1], w1 / 2, Math.PI / 2), ...R.reverse(), ...cap(pts[0], dirs[0], w0 / 2, -Math.PI / 2)];
}
// 꺾은선을 부드럽게(두 번 나누기)
export function curve(pts, n = 6) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = mid(pts[i - 1], pts[i]), b = mid(pts[i], pts[i + 1]);
    for (let k = 0; k <= n; k++) { const t = k / n, u = 1 - t; out.push([u * u * a[0] + 2 * u * t * pts[i][0] + t * t * b[0], u * u * a[1] + 2 * u * t * pts[i][1] + t * t * b[1]]); }
  }
  out.push(pts[pts.length - 1]); return out;
}
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

// ——— 아래부터는 이 엔진에서 새로 쓴 것 ———

// 지역 좌표(단위 R, 원점 = 발 아래 가운데, 위가 음수) → 세계 좌표.
// o: x, y(발 위치), sq(세로 눌림: 가로는 그만큼 넓어짐), r(발 기준 회전, 라디안), flip(왼쪽 보기), lift(세계 px, 위로 뜬 높이)
export function TR(o, R) {
  const sq = o.sq ?? 1, wq = 1 / Math.sqrt(sq), c = Math.cos(o.r || 0), s = Math.sin(o.r || 0), fl = o.flip ? -1 : 1, ly = o.lift || 0;
  return pts => pts.map(([u, v]) => { const X = u * R * wq * fl, Y = v * R * sq; return [o.x + X * c - Y * s, o.y - ly + X * s + Y * c]; });
}
// TR의 역변환: 세계 좌표 → 지역 좌표(단위 R)
export function toLocal(o, R, [X, Y]) {
  const sq = o.sq ?? 1, wq = 1 / Math.sqrt(sq), c = Math.cos(o.r || 0), s = Math.sin(o.r || 0), fl = o.flip ? -1 : 1;
  const dx = X - o.x, dyw = Y - (o.y - (o.lift || 0)); const lx = dx * c + dyw * s, ly = -dx * s + dyw * c;
  return [lx / (R * wq * fl), ly / (R * sq)];
}
export const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
// 두 마디 팔: 어깨 → 손 목표, 팔 길이 L(위팔 = 아래팔 = L/2). 팔꿈치는 bend 쪽(+1 / -1)으로 굽힌다
export function elbow(sh, hand, L, bend = 1) {
  const d = dist(sh, hand), a = L / 2;
  const m = lerp2(sh, hand, 0.5);
  if (d >= L) return m;
  const h = Math.sqrt(Math.max(0, a * a - (d / 2) * (d / 2)));
  const nx = -(hand[1] - sh[1]) / (d || 1), ny = (hand[0] - sh[0]) / (d || 1);
  return [m[0] + nx * h * bend, m[1] + ny * h * bend];
}
// 손 목표가 팔 길이를 넘으면 어깨 쪽으로 당긴다
export function reach(sh, hand, L) {
  const d = dist(sh, hand); if (d <= L) return hand;
  return lerp2(sh, hand, L / d);
}
// '#rrggbb' → [r,g,b] (0~1)
export function hexRgb(hex, fallback = [1, 1, 1]) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim()); if (!m) return fallback;
  const n = parseInt(m[1], 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}
// 색을 어둡게(k<1) / 밝게(k>1)
export function shade(hex, k) {
  const [r, g, b] = hexRgb(hex, [0.5, 0.5, 0.5]);
  const f = v => Math.round(clamp(k >= 1 ? v + (1 - v) * (k - 1) : v * k) * 255).toString(16).padStart(2, '0');
  return '#' + f(r) + f(g) + f(b);
}
// 'name' 또는 'name@1.5' 형식의 상태 문자열을 읽는다(시각은 장면 시작 기준 초)
export function parseState(state) {
  if (!state) return { name: null, at: null };
  const i = String(state).lastIndexOf('@');
  if (i < 0) return { name: String(state), at: null };
  const at = parseFloat(String(state).slice(i + 1));
  return Number.isFinite(at) ? { name: String(state).slice(0, i), at } : { name: String(state), at: null };
}
// 문자열 → 정수 시드
export function seedOf(str) { let h = 2166136261; for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) % 100000; }

// 공용 소품: 스타일 펜으로 그리므로 어느 스타일에서나 같은 모양. 좌표는 세계 px.
// 상태(state)는 'name' 또는 'name@초'(장면 시작 기준)로 쓴다. 예: cloud 'grow@1.6', bucket 'tip@0.2', word '히알루론산@0.5'
// 구름 · 해 · 양동이 그리는 법은 퍼스트겔 크레용 시험본(chars.js — lemo-opuscar crayon-book 데모 기법 기반)을 펜 인터페이스로 옮긴 것.
import { clamp, lerp, ss, eio } from '/core/lib.js';
import { handCircle, ellipse, TR } from './geom.js';

const backOut = g => { g = clamp(g); const s = 1.6, t = g - 1; return 1 + t * t * ((s + 1) * t + s); };
export function cloudPoly(x, y, Rc, lumps) {
  const L = lumps.filter(l => (l[3] ?? 1) > 0.01).map(([dx, dy, r, g]) => [dx * Rc, dy * Rc, r * Rc * backOut(g ?? 1)]);
  const out = [], base = y + Rc * 0.55;
  for (let i = 0; i < 120; i++) {
    const a = i / 120 * Math.PI * 2, dx = Math.cos(a), dy = Math.sin(a); let best = 0;
    for (const [cx, cy, r] of L) { const b = dx * cx + dy * cy, d = b * b - (cx * cx + cy * cy) + r * r; if (d >= 0) best = Math.max(best, b + Math.sqrt(d)); }
    out.push([x + dx * best, Math.min(base, y + dy * best)]);
  }
  return out;
}
const L5 = [[0, 0, 1], [-0.9, 0.15, 0.7], [0.9, 0.12, 0.75], [-0.4, -0.45, 0.7], [0.45, -0.4, 0.65]];
const WIDE = [[0, 0, 1], [-0.95, 0.15, 0.72], [0.95, 0.12, 0.78], [-0.42, -0.42, 0.74], [0.48, -0.38, 0.7], [-1.6, 0.18, 0.55], [1.62, 0.16, 0.56], [0.05, -0.7, 0.6]];
// 구름 모양(소품 밖에서도 씀: 구름 위에 앉은 캐릭터 배치)
export function cloudShape(pr) {
  const Rc = 72 * pr.scale, st = pr.name || 'small', age = pr.age ?? 99;
  if (st === 'wide') return { poly: cloudPoly(pr.x, pr.y, Rc, WIDE), Rc };
  let lumps = L5.slice(), R = Rc;
  const grow = st === 'grow' ? clamp(age / 0.4) : (st === 'medium' || st === 'big' || st === 'puff') ? 1 : 0;
  lumps.push([1.55, 0.12, 0.6, grow]);
  const puff = st === 'puff' ? ss(age / 0.4) : st === 'big' ? 1 : 0;
  if (puff > 0) { R = Rc * (1 + 0.28 * puff); lumps.push([-1.6, 0.14, 0.62, clamp(age / 0.35 + (st === 'big' ? 1 : 0))], [0.1, -0.8, 0.66, clamp((age - 0.05) / 0.35 + (st === 'big' ? 1 : 0))], [2.15, 0.15, 0.48, clamp((age - 0.1) / 0.35 + (st === 'big' ? 1 : 0))]); }
  return { poly: cloudPoly(pr.x, pr.y, R, lumps), Rc: R };
}

export const PROPS = {
  sun: {
    layer: 'bg', states: { '(없음)': '해(노란 동그라미 + 짧은 햇살 9개)' },
    draw(pen, pr) {
      const r = 51 * pr.scale, sd = pr.seed;
      pen.hatch(handCircle(pr.x, pr.y, r, sd), { col: pen.c.yellow, p: 0.9, gap: 9, w: 12, ang: 0.5, seed: sd, boil: 0, cross: true, crossP: 0.5 });
      pen.line(handCircle(pr.x, pr.y, r, sd + 1), { w: 7, col: pen.c.ochre, p: 0.95, seed: sd + 2, boil: 0.6 });
      for (let i = 0; i < 9; i++) { const a = i / 9 * Math.PI * 2 + 0.2; pen.line([[pr.x + Math.cos(a) * r * 1.25, pr.y + Math.sin(a) * r * 1.25], [pr.x + Math.cos(a) * r * 1.6, pr.y + Math.sin(a) * r * 1.6]], { w: 7, col: pen.c.yellow, p: 1, seed: sd + 10 + i, boil: 0.6 }); }
    },
  },
  cloud: {
    layer: 'bg', states: { small: '작은 구름(덩이 5)', medium: '덩이 하나 더', big: '크게 부푼 구름', wide: '넓은 구름(덩이 8)', 'grow@초': '그 시각에 덩이 하나가 자람(small → medium)', 'puff@초': '그 시각에 크게 부풂(medium → big)' },
    draw(pen, pr) {
      const { poly, Rc } = cloudShape(pr), sd = pr.seed;
      pen.hatch(poly, { col: pen.c.white, p: 0.95, gap: 9, w: 12, ang: 0.3, seed: sd, boil: 0, over: 2 });
      const lowY = pr.y + Rc * 0.1;
      pen.hatch(poly.map(([px, py]) => [px, Math.max(py, lowY)]), { col: pen.c.sky, p: 0.38, gap: 11, w: 10, ang: -0.2, seed: sd + 1, boil: 0, over: 1 });
      pen.line([...poly, poly[0], poly[1]], { w: 7, seed: sd + 2, boil: 0.6 });
    },
  },
  bucket: {
    layer: 'obj', states: { upright: '바로 선 양동이', 'tip@초': '그 시각부터 기울어져 물줄기를 쏟음(약 2초)', tipped: '기울어진 채(물줄기 없음)' },
    draw(pen, pr, ctx) {
      const s = 138 * pr.scale, sd = pr.seed, st = pr.name || 'upright', age = pr.age ?? 99;
      const tilt = st === 'tip' ? eio(clamp(age / 0.5)) : st === 'tipped' ? 1 : 0;
      const o = { x: pr.x, y: pr.y, r: -1.2 * tilt }, P = TR(o, s);
      pen.part(P([[-0.55, -1], [0.55, -1], [0.44, 0], [-0.44, 0]]), { col: pen.c.brown, p: 0.82, gap: 9, w: 11, ang: 1.45, seed: sd, over: 3 }, { w: 7.5, seed: sd + 1 });
      [-0.25, 0.02, 0.28].forEach((u, i) => pen.line(P([[u * 1.18, -0.98], [u, -0.02]]), { w: 4, p: 0.6, seed: sd + 2 + i }));
      [-0.78, -0.22].forEach((v, i) => { const hw = 0.55 - (v + 1) * 0.11; pen.part(P([[-hw - 0.02, v - 0.06], [hw + 0.02, v - 0.06], [hw + 0.01, v + 0.06], [-hw - 0.01, v + 0.06]]), { col: pen.c.ochre, p: 0.95, gap: 5, w: 7, seed: sd + 6 + i }, { w: 5, seed: sd + 8 + i }); });
      pen.line(P(ellipse(0, -1.0, 0.5, 0.42, 20, Math.PI, Math.PI * 2)), { w: 6, seed: sd + 10 });
      pen.part(P(ellipse(0, -1, 0.53, 0.1, 24)), { col: pen.c.sky, p: 0.85, gap: 4, w: 6, seed: sd + 11 }, { w: 6, seed: sd + 12 }, { occ: false, kn: false });
      if (st !== 'tip') return;
      // 물줄기: 입구 → 바닥(이차 곡선), 머리는 0.4초부터 · 꼬리는 1.9초부터
      const [lx, ly] = P([[-0.56, -1.0]])[0];
      const head = clamp((age - 0.4) / 0.35), tail = clamp((age - 1.9) / 0.35);
      if (head <= 0 || tail >= 1) return;
      const ex = lx - 90 * pr.scale, ey = ctx.ground ? ctx.ground(ex) : pr.y + 400;
      const Pq = u => { const a = 1 - u; return [a * a * lx + 2 * a * u * (lx - 72 * pr.scale) + u * u * ex, a * a * ly + 2 * a * u * (ly + 252 * pr.scale) + u * u * ey]; };
      const Ls = [], Rs = [];
      for (let i = 0; i <= 20; i++) { const u = lerp(tail, head, i / 20), [x, y] = Pq(u), [x2, y2] = Pq(Math.min(1, u + 0.01)); const dx = x2 - x, dy = y2 - y, d = Math.hypot(dx, dy) || 1, w = (20 + 18 * u) * pr.scale; Ls.push([x - dy / d * w, y + dx / d * w]); Rs.push([x + dy / d * w, y - dx / d * w]); }
      pen.part([...Ls, ...Rs.reverse()], { col: pen.c.sky, p: 0.8, gap: 7, w: 9, ang: 1.2, seed: sd + 20 }, { w: 6, seed: sd + 21 }, { occ: false });
      for (let j = 0; j < 3; j++) { const pts = []; for (let i = 0; i <= 10; i++) { const [x, y] = Pq(lerp(tail, head, i / 10)); pts.push([x + (j - 1) * 10 * pr.scale, y]); } pen.line(pts, { w: 5, col: pen.c.white, p: 1, seed: sd + 30 + j, streak: 0 }); }
    },
  },
  star: {
    layer: 'fx', states: { twinkle: '반짝이는 별(크기가 조금씩 변함)', 'twinkle@초': '그 시각에 나타나 반짝임' },
    draw(pen, pr) {
      if ((pr.age ?? 99) < 0) return;
      const r = 15.6 * pr.scale * (1 + 0.25 * Math.sin(pr.q * 9)), x = pr.x, y = pr.y;
      const pts = []; for (let k = 0; k <= 10; k++) { const a = -Math.PI / 2 + k * Math.PI / 5; const rr = k % 2 ? r * 0.45 : r; pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr]); }
      pen.hatch(pts, { col: pen.c.yellow, p: 1, gap: 3.5, w: 5, over: 1, seed: pr.seed });
      pen.line([...pts, pts[1]], { w: 4, col: pen.c.ochre, seed: pr.seed + 1 });
    },
  },
  word: {
    layer: 'bg', states: { '글자': '화면 속 손글씨(이미 써 있음)', '글자@초': '그 시각부터 한 글자씩 써짐' },
    draw(pen, pr) {
      const txt = pr.name || ''; if (!txt) return;
      const age = pr.age ?? 99; if (age < 0) return;
      const reveal = clamp(age / (0.1 + 0.09 * [...txt].length));
      pen.text(txt, pr.x, pr.y, { size: 57.6 * pr.scale, col: pen.c.ink, reveal, seed: pr.seed, weight: 700, stroke: 2 });
    },
  },
};

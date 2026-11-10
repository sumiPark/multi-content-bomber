// 방울이(물방울) — @joongdi 「퍼스트겔 방울이 이야기」 시리즈 전용 module 리그.
// 모양 · 팔 자세 · 얼굴 비율은 퍼스트겔 크레용 시험본(D:/ai/lemo-firstgel-test/firstgel-story-crayon/chars.js의 drop())을 옮긴 것이고,
// 그리기는 스타일 펜으로만 해서 어느 스타일에서도 같은 외형이 나온다. 동작 풀이 · 얼굴은 엔진 parametric.js를 같이 쓴다.
// 이 리그는 작은 방울이 무리 소품(drop-swarm)도 함께 내보낸다(이 계정 · 시리즈의 소품).
import { clamp, lerp, hash, ei } from '/core/lib.js';
import { ellipse, handCircle, smooth, tube, curve, TR } from '../../geom.js';
import { solveAction, resolveHands, drawFace, cheekAmount, armPreset } from '../../parametric.js';
import { cloudShape } from '../../props.js';

const DROP = [[0, -2.75], [0.2, -2.42], [0.45, -2.02], [0.72, -1.58], [0.93, -1.12], [1.0, -0.72], [0.9, -0.42], [0.58, -0.27], [0, -0.24], [-0.58, -0.27], [-0.9, -0.42], [-1.0, -0.72], [-0.93, -1.12], [-0.72, -1.58], [-0.45, -2.02], [-0.2, -2.42]];
const DROPS = smooth(DROP, 6);
const UNITS = 2.8;
const SH = [[-0.86, -0.95], [0.86, -0.95]];
// 시험본의 팔 끝 위치(지역 좌표). 없는 자세는 공용 armPreset으로
const ARMS = {
  down: [[-1.18, -0.62], [1.18, -0.62]], wave: [[-1.18, -0.62], [1.32, -1.95]], wave2: [[-1.18, -0.62], [1.62, -1.62]],
  up: [[-1.3, -2.05], [1.3, -2.05]], up2: [[-1.45, -1.85], [1.45, -1.85]], hug: [[0.55, -0.95], [-0.55, -0.9]],
  hold: [[-1.55, -0.95], [1.55, -0.95]], rest: [[-1.08, -0.42], [1.08, -0.42]],
};
const ANAT = { sh: SH, top: -2.75, hopH: 1.9, jumpH: 2.4, hwK: 0.36, al: 1 };
const arms = name => ARMS[name] || armPreset(name, SH, -2.75, 1);
export function halfWidth() { return 0.36; }

// 물방울 하나 그리기. o: x, y(발), R, sq, r, flip, lift, expr, look, hands(지역 [L,R]), legs, mini, cheeks, seed, spread, view, at, colors
export function drawDrop(pen, o) {
  const R = o.R, sd = o.seed || 100, lw = pen.lw(R), mini = !!o.mini, C = o.colors;
  const legs = o.legs ?? !mini, dy = legs ? 0 : 0.24;
  const P0 = TR(o, R), P = pts => P0(pts.map(([u, v]) => [u, v + dy]));
  const bodyF = { col: C.body, p: 0.82, gap: mini ? 6 : 10, w: mini ? 7 : 12, ang: 0.6, seed: sd + 1, over: mini ? 2 : 4, cross: !mini, crossP: 0.45 };
  const L = { w: lw, seed: sd + 2, col: C.line };
  if (legs) {
    const sp = o.spread || 0;
    [[-0.32, -1], [0.32, 1]].forEach(([x, k], i) => {
      const lf = (o.liftF && o.liftF[i]) || 0;
      const leg = [[x, -0.36], [x + k * sp, -0.18 - lf * 0.5], [x + k * (0.02 + sp), -0.06 - lf]];
      pen.part(P(tube(curve(leg, 4), 0.24)), bodyF, { ...L, seed: sd + 20 + i });
      pen.part(P(ellipse(x + k * (0.06 + sp), -0.05 - lf, 0.2, 0.1, 16)), bodyF, { ...L, seed: sd + 22 + i });
    });
  }
  pen.part(P(DROPS), bodyF, L);
  pen.line(P([[-0.42, -2.0], [-0.6, -1.66], [-0.7, -1.3]]), { w: lw * (mini ? 1.2 : 1.7), col: pen.c.white, p: 1, seed: sd + 3, taper: 0.4, streak: 0 });
  if (!mini) { const d = P([[-0.52, -1.05]])[0]; pen.dab(d[0], d[1], R * 0.05, { col: pen.c.white, p: 1, seed: sd + 4 }); }
  if (o.hands) {
    o.hands.forEach((hl, i) => {
      const s = SH[i], m = [(s[0] + hl[0]) / 2 + (i ? 0.05 : -0.05), (s[1] + hl[1]) / 2 - 0.05];
      pen.part(P(tube(curve([s, m, hl], 4), mini ? 0.32 : 0.24)), bodyF, { w: lw * 0.9, seed: sd + 30 + i, col: C.line });
      pen.part(P(handCircle(hl[0], hl[1], mini ? 0.2 : 0.16, sd + 32 + i, 0, 16)), bodyF, { w: lw * 0.85, seed: sd + 34 + i, col: C.line });
    });
  }
  if (mini) {   // 작은 방울이: 점 눈 · 단순한 입
    const ex = o.expr || 'neutral', lk = o.look || [0, 0];
    [-0.33, 0.33].forEach((x, i) => {
      if (ex === 'happy' || ex === 'calm') pen.line(P([[x - 0.14, -0.86], [x, -0.98], [x + 0.14, -0.86]]), { w: 4, seed: sd + 40 + i, taper: 0.2, col: C.line });
      else { const d = P([[x + lk[0] * 0.06, -0.92 + lk[1] * 0.06]])[0]; pen.dab(d[0], d[1], Math.max(1.9, R * 0.13), { col: C.line, p: 1, seed: sd + 40 + i }); }
    });
    if (ex === 'surprised') { const d = P([[0, -0.6]])[0]; pen.dab(d[0], d[1], Math.max(1.8, R * 0.11), { col: pen.c.mouth, p: 1, seed: sd + 44 }); }
    else pen.line(P([[-0.18, -0.66], [0, -0.55], [0.18, -0.66]]), { w: 3.5, seed: sd + 45, taper: 0.2, col: C.line });
    return;
  }
  drawFace(pen, P, { R, seed: sd + 50, F: [-1.12, -0.8, -0.9, 0.34, 0.6], fs: 1, view: o.view || 'front', look: o.look, expr: o.expr, at: o.at, colors: C, cheeks: o.cheeks ?? 0 });
}

export function draw(pen, pose, spec) {
  const C = spec.body.colors, R0 = pose.height / UNITS;
  const b = solveAction(pose, ANAT), R = R0 * b.scaleK;
  const o = { x: pose.x + b.dx * R * (pose.flip ? -1 : 1), y: pose.y, sq: b.sq, r: b.rot * (pose.flip ? -1 : 1), flip: pose.flip, lift: b.dy * R };
  const hands = resolveHands(pose, arms(b.arms), o, R, ANAT);
  const expr = b.expr || pose.expr;
  drawDrop(pen, {
    ...o, R, hands, expr, view: pose.view, at: pose.at, colors: C, seed: 100 + (pose.seed % 5) * 0,
    look: pose.look ? [pose.look[0] * (pose.flip ? -1 : 1), pose.look[1]] : null,
    cheeks: cheekAmount({ ...pose, expr }, C), spread: b.spread, liftF: b.lift,
  });
}

// ——— 작은 방울이 무리(소품 drop-swarm) ———
// 상태: pour@초(at 위치 = 쏟아지는 입구에서 언덕으로 떨어져 기다림), wait(언덕 위에서 기다림),
//       fly@초(언덕에서 at 위치 = 구름 쪽으로 날아올라 사라짐), perch(at = 넓은 구름 가운데, 구름 위에 앉아 내려다봄),
//       rain@초(구름 위에서 차례로 뛰어내려 언덕에 내려앉음), slip@초(link 하는 배우들 사이 틈으로 쏙쏙), sit-gaps(틈에 들어가 있음)
const N1 = 26;
const M1 = [...Array(N1)].map((_, i) => ({ fx: (380 + ((i * 487) % 1240) + (hash(i) - 0.5) * 30) / 1800, R: (24 + hash(i + 9) * 9) * 0.6, land: 0.786 + i * 0.058, off: ((i * 7) % 26) * 0.045, dx: (hash(i + 3) - 0.5) * 192, seed: 3000 + i * 13 }));
const RAIN = [-1.32, -0.88, -0.44, 0, 0.44, 0.88, 1.3].map((u, i) => ({ u, jt: [3, 0, 5, 2, 6, 1, 4][i] * 0.5, lx: [560, 760, 1230, 1450, 1650, 1130, 1340][i] / 1800, ly: [150, 240, 130, 250, 130, 330, 360][i] * 0.6, seed: 4000 + i * 17 }));
const miniArms = (q, a, b) => (Math.floor(q * 6) % 2 ? a : b);
function gaps(ctx) {
  const L = (ctx.actors || []).filter(p => p.action === 'link').sort((a, b) => a.x - b.x);
  const hw = p => p.height * (p.rig && p.rig.halfWidth ? p.rig.halfWidth(p.spec) : 0.4);
  const out = []; for (let i = 0; i + 1 < L.length; i++) out.push(((L[i].x + hw(L[i])) + (L[i + 1].x - hw(L[i + 1]))) / 2);
  return out;
}
export const PROPS = {
  'drop-swarm': {
    layer: 'char',
    states: { 'pour@초': '입구(at)에서 작은 방울이 26개가 쏟아져 언덕에 앉음', wait: '언덕 위에서 기다림', 'fly@초': '언덕에서 at(구름) 쪽으로 다 같이 날아올라 사라짐', perch: 'at의 넓은 구름 위에 7개가 앉아 내려다봄', 'rain@초': '구름 위 7개가 차례로 뛰어내려 언덕에 앉음', 'slip@초': 'link 하는 배우들 사이 틈으로 작은 방울이가 쏙쏙', 'sit-gaps': '틈에 들어가 있음' },
    draw(pen, pr, ctx) {
      const C = { body: pen.c.sky, line: pen.c.ink, accent: pen.c.sky, cheek: null };
      const W = ctx.W, gr = ctx.ground, q = ctx.lq, st = pr.name, t0 = pr.at ?? 0, k = pr.scale;
      const dd = o => drawDrop(pen, { mini: true, colors: C, ...o });
      if (st === 'pour' || st === 'wait' || st === 'fly') {
        for (const m of M1) {
          const x = m.fx * W, gy = gr(x), R = m.R * k;
          if (st === 'pour') {
            const tl = t0 + m.land, ts = tl - 0.55;
            if (q < ts) continue;
            if (q < tl) { const u = clamp((q - ts) / 0.55); dd({ x: lerp(pr.x, x, u), y: lerp(pr.y, gy, u * u) - 72 * Math.sin(u * Math.PI) * 0.4, R, expr: 'surprised', seed: m.seed }); continue; }
            dd({ x, y: gy, R, sq: q < tl + 0.09 ? 0.7 : 1, expr: q > t0 + 2.7 ? 'happy' : 'neutral', seed: m.seed });
          } else if (st === 'wait') dd({ x, y: gy, R, expr: 'happy', seed: m.seed });
          else {
            const tf = t0 + m.off, u = clamp((q - tf) / 1.15);
            if (q < tf) { dd({ x, y: gy, R, expr: 'happy', seed: m.seed }); continue; }
            if (u >= 1) continue;   // 구름에 닿으면 구름이 된다
            const e = ei(u) * 0.75 + u * 0.25;
            dd({ x: lerp(x, pr.x + m.dx * k, e) + 13 * Math.sin(q * 8 + m.seed), y: lerp(gy, pr.y, e), R: R * (1 - 0.4 * clamp((u - 0.8) / 0.2)), expr: 'happy', seed: m.seed, hands: miniArms(q, [[-1.35, -1.75], [1.35, -1.75]], [[-1.55, -1.45], [1.55, -1.45]]) });
          }
        }
        return;
      }
      if (st === 'perch' || st === 'rain') {
        const { poly, Rc } = cloudShape({ x: pr.x, y: pr.y, scale: k, name: 'wide' });
        const topOf = x => { let best = Infinity; for (const [px, py] of poly) if (Math.abs(px - x) < 17) best = Math.min(best, py); return best; };
        for (const r of RAIN) {
          const x = pr.x + r.u * Rc, y = topOf(x) + 4, R = 20.4;
          const jt = st === 'rain' ? t0 + r.jt : Infinity;
          if (q < jt) { dd({ x, y, R, expr: q > 0.8 ? 'neutral' : 'calm', look: [0, 1], seed: r.seed }); continue; }
          const lx = r.lx * W, ly = gr(lx) + r.ly, u = clamp((q - jt) / 1.0);
          if (u < 1) {
            const xx = lerp(x, lx, u), yy = lerp(y - 36 * Math.sin(Math.min(u * 3, 1) * Math.PI), ly, u * u);
            dd({ x: xx, y: yy, R, expr: 'happy', seed: r.seed, hands: [[-1.4, -1.7], [1.4, -1.7]] });
            if (u > 0.25) for (let j = 0; j < 3; j++) pen.line([[xx - 10 + j * 10, yy - 2.6 * R - 18 - j * 6], [xx - 10 + j * 10, yy - 2.6 * R - 66 - j * 6]], { w: 4.5, col: pen.c.sky, p: 0.9, seed: r.seed + 50 + j });
            continue;
          }
          dd({ x: lx, y: ly, R: R + 2.4, sq: q < jt + 1.09 ? 0.7 : 1, expr: 'happy', seed: r.seed, hands: Math.floor(q * 3 + r.seed) % 2 ? [[-1.3, -1.6], [1.25, -0.6]] : [[-1.5, -1.3], [1.25, -0.6]] });
        }
        return;
      }
      if (st === 'slip' || st === 'sit-gaps') {
        gaps(ctx).forEach((x, j) => {
          const ts = st === 'slip' ? t0 + 0.22 * j : -9; if (q < ts) return;
          const gy = gr(x) + 20.4, u = clamp((q - ts) / 0.16), y = u < 1 ? lerp(gy - 228, gy, u * u) : gy;
          dd({ x, y, R: 18 * k, sq: q < ts + 0.24 && u >= 1 ? 0.72 : 1, expr: st === 'sit-gaps' ? 'calm' : 'happy', seed: 3600 + j * 11 });
        });
      }
    },
  },
};

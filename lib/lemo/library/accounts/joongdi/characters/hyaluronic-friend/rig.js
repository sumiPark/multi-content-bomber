// 히알루론산 친구(연보라 동글이) — @joongdi 「퍼스트겔 방울이 이야기」 시리즈 전용 module 리그.
// 모양은 퍼스트겔 크레용 시험본 chars.js의 friend()를 옮긴 것: 살짝 찌그러진 동그라미 몸, 머리 위 곱슬(배우마다 모양이 조금 다름),
// 흰 크레용 하이라이트, 관 팔 + 벙어리장갑 손. 크기 다른 친구 8종은 같은 캐릭터를 scale만 바꿔 쓴다.
import { ellipse, handCircle, tube, curve, TR } from '../../geom.js';
import { solveAction, resolveHands, drawFace, cheekAmount, armPreset } from '../../parametric.js';

const UNITS = 2.05;
const SH = [[-0.92, -1.0], [0.92, -1.0]];
const ANAT = { sh: SH, top: -1.95, hopH: 1.4, jumpH: 1.9, hwK: 0.5, al: 1 };
const ARMS = { down: [[-1.25, -0.55], [1.25, -0.55]], hold: [[-1.55, -0.85], [1.55, -0.85]], up: [[-1.3, -2.05], [1.3, -2.05]], up2: [[-1.45, -1.85], [1.45, -1.85]], rest: [[-1.08, -0.42], [1.08, -0.42]], wave: [[-1.25, -0.55], [1.32, -1.95]], wave2: [[-1.25, -0.55], [1.62, -1.62]] };
const arms = name => ARMS[name] || armPreset(name, SH, -1.95, 1);
export function halfWidth() { return 0.5; }

export function draw(pen, pose, spec) {
  const C = spec.body.colors, R0 = pose.height / UNITS;
  const b = solveAction(pose, ANAT), R = R0 * b.scaleK;
  const o = { x: pose.x + b.dx * R * (pose.flip ? -1 : 1), y: pose.y, sq: b.sq, r: b.rot * (pose.flip ? -1 : 1), flip: pose.flip, lift: b.dy * R };
  const P = TR(o, R), lw = pen.lw(R), sd = 300 + (pose.seed % 9) * 23;
  const small = R * (5 / 3) < 60;
  const bodyF = { col: C.body, p: 0.85, gap: small ? 7 : 10, w: small ? 9 : 12, ang: -0.5, seed: sd + 1, over: 4, cross: true, crossP: 0.4 };
  const L = { w: lw, seed: sd + 2, col: C.line };
  // 발(걷기 · 뛰기에서 번갈아 들림)
  [-0.38, 0.38].forEach((x, i) => { const k = x < 0 ? -1 : 1; pen.part(P(ellipse(x + k * b.spread, -0.1 - b.lift[i], 0.26, 0.13, 16)), bodyF, { ...L, seed: sd + 20 + i }); });
  // 몸
  const body = []; for (let i = 0; i <= 48; i++) { const a = i / 48 * Math.PI * 2; const rr = 1 + 0.04 * Math.sin(a * 3 + sd) + 0.03 * Math.sin(a * 5 + sd * 0.7); body.push([Math.cos(a) * rr, -1.0 + Math.sin(a) * rr * 0.92]); }
  pen.part(P(body), bodyF, L);
  // 머리 위 곱슬(크기 구분용)
  const kk = sd % 3;
  pen.line(P(curve([[0, -1.9], [0.04 + 0.05 * kk, -2.12], [0.2 + 0.04 * kk, -2.16], [0.2, -2.02], [0.1, -2.06]], 4)), { w: lw, seed: sd + 3, col: C.line });
  pen.line(P([[-0.62, -1.42], [-0.72, -1.15]]), { w: lw * 1.5, col: pen.c.white, p: 1, seed: sd + 4, taper: 0.4, streak: 0 });
  // 팔
  const hands = resolveHands(pose, arms(b.arms), o, R, ANAT);
  hands.forEach((hl, i) => {
    const s = SH[i], m = [(s[0] + hl[0]) / 2, (s[1] + hl[1]) / 2 - 0.06];
    pen.part(P(tube(curve([s, m, hl], 4), 0.24)), bodyF, { w: lw * 0.9, seed: sd + 30 + i, col: C.line });
    pen.part(P(handCircle(hl[0], hl[1], 0.17, sd + 32 + i, 0, 16)), bodyF, { w: lw * 0.85, seed: sd + 34 + i, col: C.line });
  });
  const expr = b.expr || pose.expr;
  drawFace(pen, P, { R, seed: sd + 50, F: [-1.08, -0.78, -0.86, 0.34, 0.62], fs: 1, view: pose.view, look: pose.look ? [pose.look[0] * (pose.flip ? -1 : 1), pose.look[1]] : null, expr, at: pose.at, colors: C, cheeks: cheekAmount({ ...pose, expr }, C) });
}

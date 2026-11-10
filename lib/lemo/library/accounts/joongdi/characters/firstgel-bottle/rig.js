// 퍼스트겔 병 — @joongdi 「퍼스트겔 방울이 이야기」 시리즈 전용 module 리그(얼굴 없는 소품형 캐릭터).
// 모양은 퍼스트겔 크레용 시험본 chars.js의 bottle() · gelBlob()을 옮긴 것: 둥근 어깨 연보라 병, 흰 뚜껑(열림),
// 손글씨 라벨(features.label), 하이라이트. 상표 글자 재현은 목표가 아니다(비슷한 결로 그림, 2026-11-09 사용자 결정).
// 동작: idle(닫힘) · open(0.13초에 뚜껑이 열림) · stand-open(열린 채) · pour(거꾸로 들어 젤을 통통한 덩어리로 내놓고 다시 섬) · stand-gel(옆에 젤 덩어리)
import { clamp, ss } from '/core/lib.js';
import { smooth, TR } from '../../geom.js';

export const ACTIONS = {
  idle: { loop: true, desc: '뚜껑 닫힌 채 서 있음' },
  open: { dur: 0.3, desc: '0.13초에 뚜껑이 딸깍 열림(이후 열린 채)' },
  'stand-open': { loop: true, desc: '뚜껑 열린 채 서 있음' },
  pour: { dur: 3.0, desc: '병이 폴짝 뒤집혀 입구에서 젤이 나와 흐르지 않고 덩어리로 멈춤(0.36~1.9초), 2.7초에 다시 섬' },
  'stand-gel': { loop: true, desc: '열린 채 서 있고 옆에 젤 덩어리' },
};
export function halfWidth() { return 0.3; }
export function keyTimes(a) { return a === 'pour' ? [0.1, 1.0, 2.2, 2.8] : a === 'open' ? [0, 0.3] : [0]; }

function bottle(pen, o, C, label) {
  const h = o.h, sd = o.seed || 800, oy = o.anchor === 'center' ? 0.5 : 0;
  const P0 = TR({ x: o.x, y: o.y, r: o.r || 0 }, h), P = pts => P0(pts.map(([u, v]) => [u, v + oy]));
  const bodyF = { col: C.body, p: 0.78, gap: 10, w: 12, ang: 0.45, seed: sd + 1, over: 3, cross: true, crossP: 0.35 };
  const L = (s, w = 7) => ({ w, seed: sd + s, col: C.line });
  const body = smooth([[-0.3, -0.02], [-0.32, -0.3], [-0.32, -0.62], [-0.29, -0.76], [-0.2, -0.83], [0.2, -0.83], [0.29, -0.76], [0.32, -0.62], [0.32, -0.3], [0.3, -0.02], [0, 0.01]], 5);
  pen.part(P(body), bodyF, L(2));
  pen.part(P([[-0.21, -0.86], [0.21, -0.86], [0.21, -0.82], [-0.21, -0.82]]), { col: C.body, p: 0.95, gap: 4, w: 6, seed: sd + 3 }, L(4, 6));
  pen.part(P([[-0.2, -0.95], [0.2, -0.95], [0.2, -0.86], [-0.2, -0.86]]), { col: C.accent, p: 1, gap: 5, w: 7, seed: sd + 5 }, L(6, 6));
  const op = clamp(o.cap || 0), hx = 0.2, hy = -0.95, a = -2.1 * op;
  const lid = [[-0.2, -0.95], [-0.19, -1.02], [0.19, -1.02], [0.2, -0.95]].map(([u, v]) => { const du = u - hx, dv = v - hy; return [hx + du * Math.cos(a) - dv * Math.sin(a), hy + du * Math.sin(a) + dv * Math.cos(a)]; });
  pen.part(P(lid), { col: C.accent, p: 1, gap: 5, w: 7, seed: sd + 7 }, L(8, 6));
  if (op > 0.3) { const d = P([[0, -0.955]])[0]; pen.dab(d[0], d[1], h * 0.03, { col: pen.c.sky, p: 0.9, seed: sd + 9 }); }   // 열린 입구
  pen.line(P([[-0.22, -0.66], [-0.24, -0.2]]), { w: 9, col: pen.c.white, p: 1, seed: sd + 10, taper: 0.3, streak: 0 });
  if (label) { const [lx, ly] = P([[0.03, -0.42]])[0]; pen.text(label, lx, ly, { size: h * 0.135, col: C.line, seed: sd + 11, p: 1, stroke: 1.2, rot: o.r || 0 }); }
  pen.line(P([[-0.16, -0.31], [0.2, -0.31]]), { w: 3.5, p: 0.6, seed: sd + 12, col: C.line });
  return { nozzle: P([[0, -1.0]])[0] };
}
function gelBlob(pen, x, y, w, h, sd, wob, C) {
  const pts = []; for (let i = 0; i <= 32; i++) { const a = Math.PI + i / 32 * Math.PI; const rr = 1 + 0.05 * Math.sin(a * 4 + wob); pts.push([x + Math.cos(a) * w * rr, y + Math.sin(a) * h * rr]); }
  pts.push([x + w * 1.05, y + h * 0.06], [x - w * 1.05, y + h * 0.06]);
  pen.part(pts, { col: C.gel, p: 0.6, gap: 8, w: 10, ang: 0.3, seed: sd, over: 3 }, { w: 6, seed: sd + 1, col: C.line });
  pen.line([[x - w * 0.55, y - h * 0.5], [x - w * 0.25, y - h * 0.78]], { w: 10, col: pen.c.white, p: 1, seed: sd + 2, taper: 0.3, streak: 0 });
  pen.dab(x + w * 0.15, y - h * 0.72, Math.max(2.4, w * 0.06), { col: pen.c.white, p: 1, seed: sd + 3 });
}

export function draw(pen, pose, spec) {
  const f = spec.body.features || {}, Cs = spec.body.colors;
  const C = { body: Cs.body, line: Cs.line, accent: Cs.accent, gel: typeof f.gel === 'string' ? f.gel : pen.c.sky };
  const h = pose.height / 1.02, at = Math.max(0, pose.at), x = pose.x, gy = pose.y, k = h / 228;
  const label = typeof f.label === 'string' ? f.label : null;
  let cap = 0, o = { x, y: gy, h, seed: 800 };
  if (pose.action === 'open') cap = clamp((at - 0.13) / 0.15);
  else if (pose.action !== 'idle') cap = 1;
  if (pose.action === 'pour') {
    if (at < 0.17) o = { ...o, anchor: 'center', x: x + 18 * k, y: gy - 216 * k, r: -0.5 };
    else if (at < 2.66) o = { ...o, anchor: 'center', x: x + 9 * k, y: gy - 252 * k, r: 2.35 };   // 거꾸로: 입구가 아래로
    else if (at < 2.91) o = { ...o, anchor: 'center', x: x + 24 * k, y: gy - 198 * k, r: 0.6 };
  }
  const r = bottle(pen, { ...o, cap }, C, label);
  // 젤 덩어리: 병 오른쪽 아래(언덕 앞면)
  if (pose.action === 'pour' || pose.action === 'stand-gel') {
    const ground = pose.ground || (() => gy), bx = x + 69 * k, by = ground(bx) + 75 * k;
    const g = pose.action === 'stand-gel' ? 1 : ss((at - 0.36) / 1.3), set = pose.action === 'stand-gel' ? 1 : clamp((at - 1.66) / 0.6);
    const w = 75 * k * g, hh = 60 * k * g * (set > 0 && set < 1 ? 1 + 0.12 * Math.sin(set * 18) * (1 - set) : 1);
    if (pose.action === 'pour' && at < 1.86 && at >= 0.17) {   // 입구에서 이어지는 젤 기둥(흐르지 않고 뚝 끊김)
      const [nx, ny] = r.nozzle, cw = 20 * k * (1 - clamp((at - 1.61) / 0.25));
      if (cw > 1.2) pen.part([[nx - cw, ny], [nx + cw, ny], [bx + cw * 1.1, by - hh * 0.8], [bx - cw * 1.1, by - hh * 0.8]], { col: C.gel, p: 0.6, gap: 7, w: 9, ang: 1.4, seed: 905 }, { w: 5.5, seed: 906, col: C.line });
    }
    if (w > 2.4) gelBlob(pen, bx, by, w, hh, 900, pose.q * 3, C);
  }
}

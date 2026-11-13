// 캐릭터 시트 모드(index.html?sheet=<character_id>): 시점(front · q · side) · 표정 전부 · 동작 키포즈를 한 장에 그린다.
// 실제 영상과 같은 리그 · 같은 스타일 펜으로 그리므로, 시트가 곧 그 스타일에서의 외형 검수본이다.
// 쪽은 렌더 시각으로 고른다(정지 화면 도구는 한 번 띄운 페이지에서 시각만 바꿔 여러 장을 찍는다):
//   t < 1  → 전체 시트(시점 · 표정 · 동작)
//   t >= 1 → 표정 확대(표정만 크게). 전체 시트의 표정 칸은 키 160px 안팎이라 눈썹 · 입이 몇 픽셀뿐이다 — 표정 구분 검수는 이 쪽으로 한다
// 시트는 칸에 맞춰 줄여 그린다. 캐릭터 크기(px)는 영상 속 크기(spec.body.height × scale)가 아니다.
import { clamp } from '/core/lib.js';
import { ACTIONS } from './timeline.js';
import { keyTimes } from './parametric.js';

/** 시트 쪽 수. main.js가 시트 모드의 DUR로 쓴다(쪽 n은 n <= t < n + 1) */
export const SHEET_PAGES = 2;
// 표정 칸을 그리는 동작 시각(초). talk는 1/6초마다 입을 열었다 닫는데(parametric.js drawFace) 닫힌 순간(0~1/6초)의 입은
// neutral과 거의 같은 선이다 — 예전 값 0.1은 닫힌 순간이라 talk 칸이 neutral과 똑같이 찍혔다. 입이 열린 순간(1/6~2/6초)을 그린다.
// 표정끼리 몸 자세(idle 숨쉬기)가 같아야 견주기 쉬우므로 모든 표정에 같은 시각을 쓴다
const EXPR_AT = 0.25;

export function drawSheet(S, spec, rig, t, prod) {
  const W = prod.size.w, H = prod.size.h, kw = W / 1080;
  S.begin({ cam: { x: 0.5, y: 0.5, zoom: 1, rot: 0 }, t, q: t });
  const bgDef = S.backgrounds[S.sheetBackground] || Object.values(S.backgrounds)[0];
  bgDef.draw(S, S.sheetBackground === 'plane' ? { floor: 2, horizon: false } : {}, { t, q: t, local: t, lq: t, W, H });
  const tx = S.pen('fx'), bgp = S.pen('bg'), pen = S.pen('char');
  const label = (s, x, y, size = 30) => tx.text(s, x, y, { size: size * kw, seed: 7 + x * 0.01 + y * 0.001, p: 0.9, stroke: 1 });
  const ground = (x, y, w) => bgp.line([[x - w / 2, y], [x + w / 2, y]], { w: 4, col: bgp.c.sky, p: 0.6, seed: x + y });
  const info = a => (rig.ACTIONS && rig.ACTIONS[a]) || ACTIONS[a] || ACTIONS.idle;
  const base = (x, y, h, o = {}) => ({
    id: 'sheet', role: 'sheet', character: spec.id, spec, rig, actor: { expr_to: null }, x, y, scale: 1, height: h, facing: 'right', flip: false, view: 'front',
    expr: spec.expressions[0] || 'neutral', exprAge: 9, action: 'idle', at: 0, info: info('idle'), moveU: null, moving: false, rank: 0, seed: 101, q: t, local: 0, sceneDur: 3,
    look: null, lookAt: null, partners: { target: null, left: null, right: null }, ground: () => y, ...o,
  });
  // 폭이 넓은 캐릭터는 칸에 맞게 줄인다(halfWidth = 반폭 : 키)
  const hwK = typeof rig.halfWidth === 'function' ? rig.halfWidth(spec) : 0.4, fit = (cellW, h) => Math.min(h, cellW * 0.82 / (2 * hwK + 0.5));
  if (t >= 1) {
    // 표정 확대 쪽: 두 칸씩, 칸이 허락하는 만큼 크게. 다만 영상 기본 크기(scale 1)보다 크게 그리지는 않는다 — 실제 영상보다 표정이 잘 읽히는 것처럼 보이면 안 된다
    label(`${spec.id}  ·  expressions`, W / 2, 70 * kw, 40);
    const ex = spec.expressions, cols = ex.length > 1 ? 2 : 1, rows = Math.ceil(ex.length / cols);
    const top = 130 * kw, rowH = Math.floor(Math.min(700 * kw, (H - top - 20 * kw) / rows));
    const eh = Math.min(fit(W / cols, rowH - 110 * kw), spec.body.height * kw);
    ex.forEach((e, i) => {
      const x = W * ((i % cols) + 0.5) / cols, y = top + (Math.floor(i / cols) + 1) * rowH - 64 * kw;
      ground(x, y, 300 * kw);
      rig.draw(pen, base(x, y, eh, { expr: e, at: EXPR_AT }), spec);
      label(e, x, y + 44 * kw, 30);
    });
    S.end();
    return;
  }
  label(`${spec.name}  ·  ${spec.id}  ·  ${spec.rig}/${spec.body.shape}`, W / 2, 70 * kw, 46);
  label(`${prod.style.slug}  ·  account ${spec.account_key}${spec.series ? '  ·  ' + spec.series : ''}`, W / 2, 118 * kw, 26);
  // 1) 시점
  const views = spec.views && spec.views.length ? spec.views : ['front'];
  const vh = fit(W / views.length, 300 * kw), vy = 530 * kw;
  views.forEach((v, i) => {
    const x = W * (i + 0.5) / views.length;
    ground(x, vy, 240 * kw);
    rig.draw(pen, base(x, vy, vh, { view: v, facing: v === 'front' ? 'front' : 'right' }), spec);
    label(v, x, vy + 48 * kw, 28);
  });
  // 2) 표정
  const ex = spec.expressions, cols = 4, eh = fit(W / 4, 160 * kw), rowH = 220 * kw, ey0 = 800 * kw;
  ex.forEach((e, i) => {
    const x = W * ((i % cols) + 0.5) / cols, y = ey0 + Math.floor(i / cols) * rowH;
    rig.draw(pen, base(x, y, eh, { expr: e, at: EXPR_AT }), spec);
    label(e, x, y + 42 * kw, 26);
  });
  // 3) 동작 키포즈(동작마다 2~3장)
  const acts = spec.actions.includes('idle') ? spec.actions : ['idle', ...spec.actions];
  const cells = [];
  for (const a of acts) {
    const ks = (rig.keyTimes && rig.keyTimes(a)) || keyTimes(a, info(a));
    ks.forEach((k, j) => cells.push({ a, k, first: j === 0 }));
  }
  const y0 = ey0 + (Math.ceil(ex.length / cols) - 1) * rowH + 70 * kw;
  const acols = cells.length > 40 ? 9 : 8, rows = Math.ceil(cells.length / acols);
  const aRow = Math.min(240 * kw, (H - y0 - 20 * kw) / rows), ah = fit(W / acols, aRow * 0.6);
  cells.forEach((c, i) => {
    const x = W * ((i % acols) + 0.5) / acols, y = y0 + Math.floor(i / acols) * aRow + aRow * 0.78;
    const inf = info(c.a), mv = Array.isArray(inf.move) ? inf.move : null;
    const moveU = mv ? clamp((c.k - mv[0]) / (mv[1] - mv[0])) : null;
    const partner = { id: 'p', x: x + ah * 0.7, y, height: ah * 0.9, hw: ah * 0.32, action: 'idle', at: 0, moveU: null };
    const pose = base(x, y, ah, {
      action: c.a, at: c.k, info: inf, moveU, facing: 'right', view: 'q', expr: c.a === 'shrink' ? pick(spec, 'worried') : c.a === 'cheer' || c.a === 'jump' ? pick(spec, 'happy') : spec.expressions[0],
      lookAt: [x + ah, y - ah * 0.9], look: [0.7, -0.7],
      partners: { target: partner, left: c.a === 'link' ? { ...partner, x: x - ah * 0.75 } : null, right: c.a === 'link' ? partner : null },
    });
    ground(x, y, 110 * kw);
    rig.draw(pen, pose, spec);
    if (c.first) label(c.a, x, y - aRow * 0.78 + 14 * kw, 22);
  });
  S.end();
}
const pick = (spec, e) => (spec.expressions.includes(e) ? e : spec.expressions[0]);

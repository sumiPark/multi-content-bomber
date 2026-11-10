// lemo 렌더 페이지 진입점. 같은 폴더의 production.json · characters.json을 읽고 lemo 렌더 계약을 지킨다:
//   window.READY(불러오기 끝), window.DUR(초), window.render(t)(결정적), window.EV(효과음 신호 {t, type})
// 나레이션 자막은 그리지 않는다(기존 모션 자막 스킬이 나중에 얹는다). 화면 크기는 innerWidth × innerHeight(렌더 도구의 --size).
import { makeTimeline, TRANS_DUR } from './timeline.js';
import { PROPS } from './props.js';
import { FX } from './fx.js';
import { TRANSITIONS } from './transitions.js';
import * as PARAM from './parametric.js';
import { parseState, seedOf } from './geom.js';
import { drawSheet } from './sheet.js';

const Q = new URLSearchParams(location.search);
const [prod, charList] = await Promise.all([
  fetch('production.json').then(r => { if (!r.ok) throw new Error('production.json 없음'); return r.json(); }),
  fetch('characters.json').then(r => (r.ok ? r.json() : [])),
]);
const canvas = document.getElementById('c');
canvas.width = innerWidth; canvas.height = innerHeight;
await document.fonts.load('700 40px Gaegu', '가나다히알루론산퍼스트겔0123456789');
const styleMod = await import(`./styles/${prod.style.slug}/style.js`);
const S = styleMod.create(canvas, prod);
const specs = new Map(), rigs = new Map(), ACCOUNT_PROPS = {};
for (const c of charList) {
  specs.set(c.id, c);
  const rig = c.rig === 'module' ? await import(`./characters/${c.id}/rig.js`) : PARAM;
  rigs.set(c.id, rig);
  if (rig.PROPS) Object.assign(ACCOUNT_PROPS, rig.PROPS);
}
const TL = makeTimeline(prod, rigs, specs);
const W = TL.W, H = TL.H;
const bgById = new Map(prod.backgrounds.map(b => [b.id, b]));
const mk = () => { const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height; return { c, g: c.getContext('2d') }; };
const SNAP_A = mk(), SNAP_B = mk(), OUT = mk();

function propList(s, lq) {
  return s.props.map((p, j) => {
    const st = parseState(p.state);
    return { kind: p.kind, x: p.at.x * W, y: p.at.y * H, scale: p.scale * TL.kw, state: p.state, name: st.name, at: st.at, age: st.at != null ? lq - st.at : 99, q: lq, seed: 600 + seedOf(p.kind + j) % 300, index: j };
  });
}
function renderScene(i, t) {
  const s = TL.scenes[i], fps = S.drawFps || 12;
  const q = Math.floor(t * fps + 1e-6) / fps, local = t - s.start, lq = q - s.start;
  S.begin({ cam: TL.camAt(i, t), t, q });
  const bg = bgById.get(s.background) || { kind: S.defaultBackground, params: {} };
  const bgDef = S.backgrounds[bg.kind] || S.backgrounds[S.defaultBackground];
  const ctx = { t, q, local, lq, scene: s, W, H, ground: null, actors: [] };
  const env = bgDef.draw(S, bg.params || {}, ctx) || {};
  ctx.ground = env.ground || (() => H * 0.8);
  const poses = TL.poses(s, q);
  for (const p of poses) p.ground = ctx.ground;
  ctx.actors = poses;
  const count = {};
  const fxs = s.fx.map((f, j) => ({ kind: f.kind, t: f.t, x: f.at ? f.at.x * W : W / 2, y: f.at ? f.at.y * H : H / 2, fx: f.at ? f.at.x : 0.5, fy: f.at ? f.at.y : 0.5, age: local - f.t, q: lq - f.t, seed: 900 + j * 37, index: (count[f.kind] = (count[f.kind] ?? -1) + 1) }));
  const drawFx = layer => fxs.forEach(f => {
    const own = S.fx && S.fx[f.kind], def = own || FX[f.kind];
    if (!def || (def.layer || 'over') !== layer) return;
    if (own) def.draw(S, f, ctx); else def.draw(S.pen('fx'), f, ctx);
  });
  const props = propList(s, lq);
  const drawProps = layer => props.forEach(p => { const def = PROPS[p.kind] || ACCOUNT_PROPS[p.kind]; if (def && (def.layer || 'obj') === layer) def.draw(S.pen(layer), p, ctx); });
  drawFx('under');
  drawProps('bg'); drawProps('obj'); drawProps('char');
  for (const p of poses) p.rig.draw(S.pen('char'), p, p.spec);
  drawProps('fx');
  drawFx('over');
  S.end();
}
function frame(t) {
  const i = TL.sceneIndex(t), s = TL.scenes[i], local = t - s.start;
  let tr = s.transition_in;
  if (!S.transitions.includes(tr)) tr = 'cut';   // 이 스타일이 쓰지 않는 전환은 컷으로
  const d = TRANS_DUR[tr] || 0;
  if (i > 0 && d > 0 && tr !== 'match' && local < d) {
    const p = TL.scenes[i - 1];
    renderScene(i - 1, p.end - 1e-3); S.snapshot(SNAP_A);   // 나가는 장면은 마지막 그림에 멈춘다
    renderScene(i, t); S.snapshot(SNAP_B);
    const fn = (S.transitionFns && S.transitionFns[tr]) || TRANSITIONS[tr];
    fn(OUT.g, SNAP_A.c, SNAP_B.c, local / d, canvas.width, canvas.height);
    S.present(OUT);
    return;
  }
  renderScene(i, t);
}

const sheetId = Q.get('sheet');
if (sheetId) {
  const spec = specs.get(sheetId);
  if (!spec) throw new Error(`시트로 그릴 캐릭터 ${sheetId}가 characters.json에 없어요`);
  window.DUR = 1; window.EV = [];
  window.render = t => drawSheet(S, spec, rigs.get(sheetId), t, prod);
} else {
  window.DUR = prod.duration;
  window.EV = prod.sfx.map(x => ({ t: x.t, type: x.name })).sort((a, b) => a.t - b.t);
  window.render = t => frame(Math.min(Math.max(0, t), prod.duration - 1e-4));
}
window.READY = true;

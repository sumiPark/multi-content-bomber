// 크레용 그림책 스타일 모듈(WebGL2). 종이 결 위 왁스 접착 · 빗금 칠 · 끓는 선 · 수채(왁스가 밀어냄) · 페이지 넘김.
// 그리기 엔진은 lemo-opuscar styles/crayon-book/demo의 crayon.js · gl.js · rig.js 복사본(이 폴더, MIT, Copyright 2026 LemoLab).
// 언덕 · 수채 붓질 · 흰 왁스 물방울은 퍼스트겔 크레용 시험본 film.js(같은 데모 기법 기반)를 배경 · 효과 모듈로 일반화한 것.
//
// 내부 좌표: 계약 세계 px × U(=5/3). 데모 · 시험본이 한 쪽을 1800×3200으로 두고 확대 0.6일 때 전체 쪽을 보던 것과 같은 축척이라
// 선 굵기 · 빗금 간격 · 종이 결이 시험본과 같은 크기로 나온다.
import { setSize, layer, clear, line, fill, dab, text, CAM, BOIL, sx, sy } from './crayon.js';
import { group, clearGroup, part } from './rig.js';
import { makeComp } from './gl.js';
import { clamp, lerp, hash, ss, mulberry } from '/core/lib.js';
import { smooth, hexRgb } from '../../geom.js';

const U = 5 / 3;
// 기본 크레용 한 상자(12색). production.style.params의 c_<이름>으로 바꿀 수 있다. 외곽선은 brand.ink(검정 금지)
const BOX = { ink: '#2d3263', sky: '#79acd9', lav: '#a88fd8', pink: '#ee8ea4', peach: '#f4c7a4', coral: '#e5967c', yellow: '#f5c63c', brown: '#7a4b31', ochre: '#e7b867', peri: '#a9b8e8', red: '#d4483c', white: '#fbfaf4' };
const DROP = [[0, -2.75], [0.2, -2.42], [0.45, -2.02], [0.72, -1.58], [0.93, -1.12], [1.0, -0.72], [0.9, -0.42], [0.58, -0.27], [0, -0.24], [-0.58, -0.27], [-0.9, -0.42], [-1.0, -0.72], [-0.93, -1.12], [-0.72, -1.58], [-0.45, -2.02], [-0.2, -2.42]];

export const META = {
  render_mode: '2d', webgl: true,
  transitions: ['cut', 'wipe', 'page-turn', 'match'],   // 디졸브(fade)는 이 스타일 규칙상 쓰지 않는다 → cut으로 바뀐다
};

export function create(canvas, prod) {
  const Wc = canvas.width, Hc = canvas.height; setSize(Wc, Hc);
  const comp = makeComp(canvas, Wc, Hc);
  const PW = prod.size.w, PH = prod.size.h, k = Wc / PW, PWi = PW * U, PHi = PH * U;
  const params = prod.style.params || {};
  const box = { ...BOX };
  for (const [key, v] of Object.entries(params)) if (key.startsWith('c_') && typeof v === 'string') box[key.slice(2)] = v;
  if (prod.brand && prod.brand.ink) box.ink = prod.brand.ink;
  const paper = hexRgb(params.paper || (prod.brand && prod.brand.paper), [0.957, 0.937, 0.890]);
  const washCol = hexRgb(params.wash || '#8fc7f2', [0.56, 0.78, 0.95]);
  const baseBoil = typeof params.boil === 'number' ? params.boil : 1;
  const Lr = { bg: { f: layer(), l: layer() }, wax: { f: layer(), l: layer() }, obj: group(), char: group(), fx: layer() };
  const WASHA = layer(), WSKY = layer(), WHILL = layer();
  const st = { poff: 0, wash: false, wax: false, mask: null, vig: typeof params.vignette === 'number' ? params.vignette : 0.28 };
  const X = pts => pts.map(([x, y]) => [x * U, y * U]);
  const c = { ink: box.ink, white: box.white, mouth: box.red, blush: box.pink, sky: box.sky, yellow: box.yellow, ochre: box.ochre, brown: box.brown, accent2: box.lav, paper: params.paper || (prod.brand && prod.brand.paper) || '#f4efe3', box };
  const lineO = o => ({ ...o, col: o.col || c.ink });

  function mkPen(name) {
    const T = Lr[name] || Lr.fx, isGroup = !!T.k;
    const FL = T.f || T, LL = T.l || T;
    if (name === 'wax') st.wax = true;
    return {
      style: 'crayon-book', c,
      lw: R => clamp(3.6 + R * U * 0.034, 4, 7.5),
      part(poly, fo, lo, opt = {}) {
        const P = X(poly);
        if (isGroup) part(T, P, fo || null, lo ? lineO(lo) : null, opt);
        else { if (fo) fill(FL, P, fo); if (lo) line(LL, [...P, P[1] || P[0]], lineO(lo)); }
      },
      line(pts, o = {}) { line(LL, X(pts), lineO(o)); },
      hatch(poly, o = {}) { fill(FL, X(poly), o); },
      dab(x, y, r, o = {}) { dab(LL, x * U, y * U, r * U, { col: o.col || c.ink, p: o.p ?? 1, seed: o.seed ?? 1, gap: 2, w: 3 }); },
      text(str, x, y, o = {}) {
        const g = LL.g; g.save(); g.translate(sx(x * U), sy(y * U)); if (o.rot) g.rotate(o.rot);
        text(LL, str, 0, 0, { size: (o.size || 40) * U * CAM.s, font: 'Gaegu', weight: o.weight ?? 700, col: o.col || c.ink, reveal: o.reveal ?? 1, seed: o.seed ?? 7, p: o.p ?? 0.95, stroke: o.stroke ?? 1.2, align: o.align });
        g.restore();
      },
    };
  }
  const pens = {};
  const S = {
    slug: 'crayon-book', canvas, drawFps: 12, W: Wc, H: Hc, k, U, c,
    transitions: META.transitions, defaultBackground: 'paper', sheetBackground: 'paper',
    pen(name) { return pens[name] || (pens[name] = mkPen(name)); },
    begin({ cam, t }) {
      CAM.x = cam.x * PWi; CAM.y = cam.y * PHi; CAM.s = cam.zoom * k / U;
      BOIL.step = Math.floor(t * 12 + 1e-6); BOIL.amp = baseBoil;
      [Lr.bg.f, Lr.bg.l, Lr.wax.f, Lr.wax.l, Lr.fx, WASHA, WSKY, WHILL].forEach(clear); clearGroup(Lr.obj); clearGroup(Lr.char);
      st.wash = false; st.wax = false; st.mask = null; st.poff = 0;
    },
    setBoil(m) { BOIL.amp = baseBoil * m; },
    setPage(n) { st.poff = (n || 0) * 4000; },
    setMask(fn) { st.mask = fn; },
    // 수채 붓질 한 띠: center(0~1 쪽 높이), u(0~1 진행), moving(앞 가장자리가 젖어 진함)
    washBand(center, u, moving, seed) {
      st.wash = true;
      const y0 = (center - 0.12) * PHi, y1 = (center + 0.125) * PHi, BX0 = -PWi / 6, BX1 = PWi * 7 / 6;
      const g = WASHA.g; g.save();
      g.setTransform(CAM.s, 0, 0, CAM.s, Wc / 2 - CAM.x * CAM.s, Hc / 2 - CAM.y * CAM.s);
      const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2, f = lerp(BX0, BX1, 0.15 * u + 0.85 * e);
      const top = [], bot = [];
      for (let x = BX0; x <= BX1; x += 40) {
        top.push([x, y0 + 10 * (Math.sin(x * 0.006 + seed) + 0.5 * Math.sin(x * 0.017 + seed * 3)) + 8 * hash(x * 0.37 + seed)]);
        bot.push([x, y1 + 12 * (Math.sin(x * 0.005 + seed * 2) + 0.5 * Math.sin(x * 0.019 + seed)) + 10 * hash(x * 0.71 + seed)]);
      }
      const frontX = y => f + 70 * Math.sin(clamp((y - y0) / (y1 - y0)) * Math.PI) + 10 * Math.sin(y * 0.05);
      g.beginPath(); g.moveTo(BX0 - 50, y0 - 200);
      for (let y = y0 - 200; y <= y1 + 200; y += 20) g.lineTo(frontX(y), y);
      g.lineTo(BX0 - 50, y1 + 200); g.closePath(); g.clip();
      const shape = new Path2D(); top.forEach(([x, y], i) => i ? shape.lineTo(x, y) : shape.moveTo(x, y)); for (let i = bot.length - 1; i >= 0; i--) shape.lineTo(bot[i][0], bot[i][1]); shape.closePath();
      g.fillStyle = '#000'; g.globalAlpha = 0.72; g.fill(shape);
      g.save(); g.clip(shape);
      const Rr = mulberry(seed * 97);
      for (let i = 0; i < 22; i++) {   // 붓결: 붓 방향으로 가늘고 옅은 결
        const yy = lerp(y0, y1, Rr()), wd = 5 + Rr() * 14, dark = Rr() < 0.55;
        g.beginPath(); for (let x = BX0; x <= BX1; x += 60) { const y = yy + 5 * Math.sin(x * 0.01 + i * 2); x === BX0 ? g.moveTo(x, y) : g.lineTo(x, y); }
        g.lineWidth = wd; g.globalCompositeOperation = dark ? 'source-over' : 'destination-out'; g.globalAlpha = dark ? 0.08 + Rr() * 0.06 : 0.04 + Rr() * 0.05; g.strokeStyle = '#000'; g.stroke();
      }
      g.globalCompositeOperation = 'source-over';
      g.beginPath(); for (let y = y0 - 80; y <= y1 + 80; y += 16) { const x = frontX(y) - 14; y === y0 - 80 ? g.moveTo(x, y) : g.lineTo(x, y); }
      g.lineWidth = moving ? 32 : 20; g.globalAlpha = moving ? 0.28 : 0.12; g.stroke();
      g.restore(); g.restore();
    },
    end() {
      if (st.wash) {
        if (st.mask) {   // 하늘 쪽은 왁스가 물감을 강하게 밀어내고, 언덕 쪽은 살갗 위에 얇은 막
          const gs = WSKY.g; gs.save(); gs.drawImage(WASHA.c, 0, 0); gs.globalCompositeOperation = 'destination-out'; st.mask(gs); gs.fill(); gs.restore();
          const gh = WHILL.g; gh.save(); gh.drawImage(WASHA.c, 0, 0); gh.globalCompositeOperation = 'destination-in'; st.mask(gh); gh.fill(); gh.restore();
        } else { const gs = WSKY.g; gs.drawImage(WASHA.c, 0, 0); }
      }
      comp.paperCam(CAM.x * 0.6 + st.poff, CAM.y * 0.6, CAM.s / 0.6);
      comp.begin(paper);
      if (st.wax) { comp.crayon(Lr.wax.f.c); comp.crayon(Lr.wax.l.c); }
      comp.crayon(Lr.bg.f.c); comp.crayon(Lr.bg.l.c);
      if (st.wash) { comp.wash(WSKY.c, { color: washCol, resist: 0.93 }); if (st.mask) comp.wash(WHILL.c, { color: washCol, resist: 0.9, edge: 1.0 }); }
      const go = [hash(BOIL.step) * 300, hash(BOIL.step + 7) * 300];
      comp.group(Lr.obj, { goff: go }); comp.group(Lr.char, { goff: go });   // 인물은 수채 뒤에 합성(물감에 묻히지 않게)
      comp.crayon(Lr.fx.c, { goff: go });
      comp.finish({ vig: st.vig });
    },
    snapshot(dst) { dst.g.setTransform(1, 0, 0, 1, 0, 0); dst.g.clearRect(0, 0, Wc, Hc); dst.g.drawImage(canvas, 0, 0); },
    present(src) { comp.paperCam(0, 0, 1); comp.begin(paper); comp.image(src.c); comp.finish({ vig: 0, emb: 0, lift: 0 }); },
    // 이 스타일의 와이프: 크레용으로 칠해 덮듯 들쭉날쭉한 경계(전환 함수는 엔진 transitions.js 사용)
    transitionFns: {},
    backgrounds: {
      paper: {
        params: { page: '종이 결 위치(쪽 번호, 0부터). 쪽이 바뀌면 다른 번호', boil: '선 끓음 배율(1 기본, 0.5 조용한 장면)' },
        draw(S2, p) { S.setPage(p.page); if (typeof p.boil === 'number') S.setBoil(p.boil); return {}; },
      },
      hill: {
        params: {
          y: '언덕 꼭대기 높이(0~1, 기본 0.734)', amp: '물결 크기 배율(기본 1)', color: '언덕 색(#hex 또는 상자 색 이름, 기본 peach)', mark: '결 무늬 색(기본 coral)',
          page: '종이 결 위치(쪽 번호)', boil: '선 끓음 배율(0.5 = 조용한 장면)', draw_in: 'true면 장면 시작에 선 · 색이 그려지는 중(약 2.3초)',
          dry: '0~1 마름(색이 듬성해지고 선이 팽팽해짐)', dry_from: '마르기 시작(장면 기준 초)', dry_in: '마르는 데 걸리는 초(0이면 이미 마름)',
          wax: 'true면 하늘에 흰 크레용 물방울 무늬를 숨겨 둠(수채가 지나가면 드러남)', washed: '이미 칠해진 수채 띠 가운데 높이들(쉼표, 예 "0.53,0.74")',
        },
        draw(S2, p, ctx) {
          S.setPage(p.page); if (typeof p.boil === 'number') S.setBoil(p.boil);
          const HY = (typeof p.y === 'number' ? p.y : 0.734) * PHi, amp = typeof p.amp === 'number' ? p.amp : 1, sd = 10 + (p.page || 0) * 10;
          const dryIn = typeof p.dry_in === 'number' ? p.dry_in : 0, dry = (p.dry || 0) * (dryIn > 0 ? ss((ctx.local - (p.dry_from || 0)) / dryIn) : 1);
          const kk = amp * (1 - 0.78 * dry), pp = lerp(0.92, 0.4, dry);
          const gY = x => HY + kk * (46 * Math.sin(x * 0.0021 + 0.6) + 18 * Math.sin(x * 0.0063 + 1.7));
          const x0 = -PWi * 0.18, x1 = PWi * 1.18, yb = PHi * 1.2;
          const lineDraw = p.draw_in ? clamp((ctx.local + 0.3) / 1.3) : 1, fillDraw = p.draw_in ? clamp((ctx.local - 0.45) / 1.85) : 1;
          const top = []; for (let x = x0; x <= x1; x += 60) top.push([x, gY(x)]);
          const col = (typeof p.color === 'string' && (box[p.color] || p.color)) || box.peach, mark = (typeof p.mark === 'string' && (box[p.mark] || p.mark)) || box.coral;
          fill(Lr.bg.f, [...top, [x1, yb], [x0, yb]], { col, p: pp, gap: 12, w: 13, ang: 0.25, seed: sd, boil: 0, draw: fillDraw, over: 8, cross: pp > 0.6, crossP: 0.45 });
          if (fillDraw > 0.7) for (let i = 0; i < 16; i++) { const x = 120 + i * 105 + hash(i + sd) * 50, y = gY(x) + 120 + hash(i * 3 + sd) * 620; line(Lr.bg.l, [[x - 22, y], [x, y - 7 * kk - 2], [x + 22, y]], { w: 4.5, col: mark, p: 0.7 * pp / 0.9, seed: sd + 40 + i, boil: 0.6, taper: 0.3 }); }
          line(Lr.bg.l, top, { w: 8, seed: sd + 1, draw: lineDraw, boil: 0.6, col: c.ink });
          if (p.wax) {   // 흰 크레용 물방울(처음부터 그려져 있지만 수채가 지나가기 전엔 거의 안 보임)
            st.wax = true;
            const R = mulberry(77); let n = 0; const got = [];
            for (; got.length < 64 && n < 4000; n++) {
              const x = 50 + R() * (PWi - 100), y = HY - 990 + R() * 900, r = 10 + R() * 18;
              if (y > gY(x) - 70) continue;
              if (got.some(d => Math.hypot(d[0] - x, d[1] - y) < 92)) continue;
              got.push([x, y]);
              const pts = smooth(DROP.map(([u, v]) => [x + u * r, y + (v + 1.3) * r]), 4);
              fill(Lr.wax.f, pts, { col: box.white, p: 0.78, gap: 3.5, w: 5, over: 1, seed: 2000 + n, boil: 0.25 });
              line(Lr.wax.l, pts, { w: 4, col: box.white, p: 0.7, seed: 2001 + n, boil: 0.25, streak: 0 });
            }
          }
          if (typeof p.washed === 'string' && p.washed.trim()) p.washed.split(',').map(Number).filter(Number.isFinite).forEach((cy, i) => S.washBand(cy, 1, false, i + 1));
          S.setMask(g => { g.beginPath(); let first = true; for (let x = x0; x <= x1; x += 60) { const X = sx(x), Y = sy(gY(x)); first ? g.moveTo(X, Y) : g.lineTo(X, Y); first = false; } g.lineTo(sx(x1), sy(yb)); g.lineTo(sx(x0), sy(yb)); g.closePath(); });
          return { ground: x => gY(x * U) / U };
        },
      },
    },
    fx: {
      wash: {
        layer: 'under', desc: '수채 붓질: at.y 높이(쪽의 약 1/4 두께)를 왼쪽 → 오른쪽으로 1.8초에 칠함. 흰 왁스 무늬가 드러나고 인물은 물감 위에 남음',
        draw(S2, f) { S.washBand(f.fy, clamp(f.age / 1.8), f.age < 1.8, (f.index || 0) + 1); },
      },
    },
  };
  return S;
}

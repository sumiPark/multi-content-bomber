// 수채 붓 스타일 모듈(Canvas 2D, WebGL 없음) — 캐릭터 없이 그림 · 도형 · 글자로 설명하는 방식.
// 문법은 lemo-opuscar styles/watercolor(STYLE.md)를 따른다: 따뜻한 수채 종이 한 장, 모든 것이 옅은 붓 자국으로 스스로 칠해지고
// (구조 → 세부 순서), 옆에 손글씨 메모가 써진다. 벡터 외곽선 · 순백 없음(빛은 칠하지 않은 종이). 얼굴 · 표정 없음.
// 붓 엔진은 같은 폴더 brush.js(데모 engine.js에서 옮김, MIT, Copyright 2026 LemoLab), 종이는 데모 paper.py의 방법을 브라우저에서 시드 고정으로 만든다.
// 아이콘 · 상품 · 화살표 모양은 ../../explain.js(픽토그램과 함께 쓰는 모양 사전)에서 오고, 여기서는 물감 번짐 + 진한 가장자리 획으로 칠한다.
// 화면 글자는 장면표가 정한 글자(word 소품)만 손글씨로 쓴다.
import { clamp, lerp, ss, eo } from '/core/lib.js';
import { seedOf } from '../../geom.js';
import { ICONS, UNIT, productPrims, arrowPrims, placePrims } from '../../explain.js';
import { wipe as wipeT, pageTurn } from '../../transitions.js';
import { withSeed, rnd, mk, drawS, washPoly, qcurve, mixc, rgba, fbm } from './brush.js';

export const META = {
  render_mode: '2d', webgl: false,
  transitions: ['cut', 'wipe', 'page-turn', 'fade', 'match'],   // 붓 자국 경계 와이프 · 책장 넘김 · 안개(종이로 지웠다 다시 칠함). 다른 그림끼리 디졸브 없음
};

const INK = '#2b2520';
// 자연색 힌트(explain.js ICONS[].hue) → 물감
const HUE = { water: '#6f9fc4', leaf: '#7fa35a', sun: '#e0a93a', warm: '#d9732e', red: '#c8442a', neutral: '#8a7b6a' };
const ACCENT = '#c8442a';   // 되풀이되는 강조 하나(주홍)
const isHex = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

export function create(canvas, prod) {
  const Wc = canvas.width, Hc = canvas.height, g = canvas.getContext('2d');
  const PW = prod.size.w, PH = prod.size.h, k = Wc / PW;
  const params = prod.style.params || {};
  const brand = prod.brand || {};
  // 종이: 밝은 브랜드 종이색이면 그것, 아니면 데모 종이색
  const PAPER = isHex(params.paper) ? params.paper : isHex(brand.paper) && luminance(brand.paper) > 0.75 ? brand.paper : '#f1e9da';
  const paper = makePaper(Wc, Hc, PAPER);

  // ── 칠하기 도구 ──
  const circle = (x, y, r, n = 36) => Array.from({ length: n }, (_, i) => [x + Math.cos(i / n * Math.PI * 2) * r, y + Math.sin(i / n * Math.PI * 2) * r]);
  const ringPts = (x, y, r, n = 40) => Array.from({ length: n + 1 }, (_, i) => [x + Math.cos(i / n * Math.PI * 2) * r, y + Math.sin(i / n * Math.PI * 2) * r]);
  // 도형 목록을 물감으로: 다각형 · 원은 번짐 + 진한 가장자리 획, 막대는 붓 한 획. p(0~1) = 칠해진 정도(앞 도형부터)
  function paintPrims(prims, col, p, seed, o = {}) {
    if (p <= 0) return;
    const N = prims.length, dur = Math.min(0.5, Math.max(0.12, 4 / N));
    // 도형마다 따로 시드를 준다 — 앞 도형이 칠해진 정도에 따라 뒤 도형 모양이 바뀌지 않게
    prims.forEach((pr, j) => withSeed(seed * 97 + j * 31, () => {
      const c = col(pr.c); if (!c) return;
      const t0 = (j / N) * (1 - dur), u = p >= 1 ? 1 : clamp((p - t0) / dur);
      const edge = mixc(c, INK, 0.35), a = o.a ?? 0.85, size = o.size ?? 300;
      if (pr.t === 'seg') {
        const len = Math.hypot(pr.b[0] - pr.a[0], pr.b[1] - pr.a[1]);
        // 짧은 막대(햇살 등)는 붓끝으로 콕 찍은 획, 긴 막대는 고른 붓 한 획
        const s = mk(qcurve(pr.a[0], pr.a[1], pr.b[0], pr.b[1], rnd(-2, 2), 10), pr.w * 1.15, c, len < pr.w * 3 ? { prof: 'tip', nb: 0, a: 0.85, rough: 0.2 } : { prof: 'even', nb: pr.w > 14 ? 3 : 0, a: 0.9, rough: 0.25 });
        drawS(g, s, u);
        return;
      }
      if (pr.t === 'ring') { drawS(g, mk(ringPts(pr.x, pr.y, pr.r), pr.w * 1.1, c, { prof: 'even', nb: 0, a: 0.85 }), u); return; }
      const pts = pr.t === 'disc' ? circle(pr.x, pr.y, pr.r) : pr.pts;
      if (u <= 0) return;
      // 1) 옅은 물감 번짐(세 번 흔들어 겹침 — 가장자리가 고인다)
      washPoly(g, pts, c, a * 0.8 * ss(u), 3, Math.max(1.5, (o.jit ?? 0.022) * size));
      // 2) 그 안을 지나간 붓 자국(비백) — 모양 안에서만, 왼쪽부터 칠해진다. 밝은 면 · 뚫린 자리 · 작은 점에는 넣지 않는다
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      const big = Math.max(x1 - x0, y1 - y0) > size * 0.22, solid = pr.c !== 'light' && pr.c !== 'cut';
      if (big && solid) {
        const w = Math.max(6, size * 0.075), n = Math.min(9, Math.max(2, Math.round((y1 - y0) / (w * 1.25))));
        g.save(); g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.clip();
        for (let i = 0; i < n; i++) {
          const yy = lerp(y0 + w * 0.5, y1 - w * 0.5, n > 1 ? i / (n - 1) : 0.5) + rnd(-w * 0.2, w * 0.2), tilt = rnd(-0.08, 0.08) * (x1 - x0);
          drawS(g, mk(qcurve(x0 - w, yy - tilt, x1 + w, yy + tilt, rnd(-w, w), 14), w, mixc(c, INK, 0.08), { prof: 'brush', nb: 4, a: 0.32, rough: 0.3 }), clamp(u * 1.3 - i * 0.04));
        }
        g.restore();
      }
      // 3) 가장자리: 진한 물감이 고인 선(형태를 따라 붓끝이 지나간다). 밝은 면 · 작은 점은 번짐만
      const ring = [...pts, pts[0]];
      if (ring.length > 3 && (o.edge ?? true) && solid && (big || pr.t !== 'disc')) drawS(g, mk(ring, Math.max(2.2, size * 0.012), edge, { prof: 'even', nb: 0, a: 0.5, rough: 0.35 }), u);
    }));
  }
  const ageOf = pr => (pr.at != null ? pr.age : 99);

  const productLook = () => ({
    shape: params.product_shape || 'bottle', fruit: params.product_fruit || 'apple',
    body: isHex(params.product_body) ? params.product_body : (brand.palette && brand.palette[0]) || '#79acd9',
    cap: isHex(params.product_cap) ? params.product_cap : '#7f8f6a', band: isHex(params.product_band) ? params.product_band : null,
  });

  const props = {
    product: {
      layer: 'obj', desc: '소개하는 상품(용기 · 원물 모양, 글자 · 로고 없음). state "in@초"면 그때부터 약 1.6초에 칠해짐',
      draw(pen, pr) {
        const age = ageOf(pr); if (age < 0) return;
        const s = UNIT * pr.scale, L = productLook();
        const col = c => ({ body: L.body, cap: L.cap, band: L.band || mixc(L.body, PAPER, 0.6), shade: mixc(L.body, INK, 0.16), light: mixc(PAPER, L.body, 0.12) })[c] || L.body;
        paintPrims(placePrims(productPrims(L.shape, L.fruit), pr.x, pr.y, s), col, eo(clamp(age / 1.6)), 700 + pr.index, { size: s, a: 0.9 });
      },
    },
    icon: {
      layer: 'obj', desc: '그림 아이콘(물감으로 칠해짐). state "이름" 또는 "이름@초"',
      draw(pen, pr) {
        const def = ICONS[pr.name]; if (!def) return;
        const age = ageOf(pr); if (age < 0) return;
        const s = UNIT * pr.scale, h = HUE[def.hue] || HUE.neutral;
        const col = c => ({ main: h, dark: mixc(h, INK, 0.42), accent: def.hue === 'red' ? HUE.sun : ACCENT, light: mixc(PAPER, h, 0.15), cut: PAPER })[c] || h;
        // 다 칠한 뒤에는 아주 작게 흔들린다(STYLE §5 sway — 칠해지는 중에는 흔들리지 않음)
        const sway = age > 1.3 ? (Math.sin(1.15 * pr.q + pr.seed) + 0.4 * Math.sin(2.7 * pr.q + 2 * pr.seed)) * s * 0.02 * clamp((age - 1.3) / 0.6) : 0;
        paintPrims(placePrims(def.prims(def.spin ? 0.15 : 0), pr.x + sway, pr.y, s), col, eo(clamp(age / 1.2)), 800 + seedOf(pr.name) + pr.index, { size: s });
      },
    },
    arrow: {
      layer: 'obj', desc: '펜으로 그은 화살표(가운데 기준, scale 1 = 길이 150px). state "right|left|up|down" 또는 "방향@초"(그때부터 그어짐)',
      draw(pen, pr) {
        const age = ageOf(pr); if (age < 0) return;
        const s = UNIT * pr.scale, d = eo(clamp(age / 0.6));
        const prims = placePrims(arrowPrims(pr.name || 'right', 1), pr.x, pr.y, s);
        withSeed(900 + pr.index, () => prims.forEach((p, j) => drawS(g, mk(qcurve(p.a[0], p.a[1], p.b[0], p.b[1], j ? 0 : rnd(-6, 6) * pr.scale, 12), Math.max(3, p.w * 0.45), INK, { prof: j ? 'tip' : 'even', nb: 0, a: 0.85, rough: 0.3 }), j ? clamp((d - 0.8) / 0.2) : clamp(d / 0.8))));
      },
    },
    bullet: {
      layer: 'obj', desc: '목록 점(주홍 물감 한 방울, scale 1 = 지름 약 48px). state "on@초"면 그때 찍힘',
      draw(pen, pr) {
        const age = ageOf(pr); if (age < 0) return;
        const r = UNIT * pr.scale * 0.16 * (0.7 + 0.3 * eo(clamp(age / 0.25)));
        withSeed(950 + pr.index, () => washPoly(g, circle(pr.x, pr.y, r, 24), ACCENT, 0.9 * eo(clamp(age / 0.25)), 3, r * 0.08));
      },
    },
    word: {
      layer: 'bg', desc: '손글씨 메모(장면표가 정한 글자만). 왼쪽부터 써짐. state "글자" 또는 "글자@초"',
      draw(pen, pr) {
        const txt = pr.name || ''; if (!txt) return;
        const age = ageOf(pr); if (age < 0) return;
        const p = eo(clamp(age / (0.25 + 0.09 * [...txt].length)));
        let size = 57.6 * pr.scale * 1.05;
        g.save(); g.font = `700 ${size}px Gaegu`;
        let w = g.measureText(txt).width;
        if (w > PW * 0.9) { size *= (PW * 0.9) / w; g.font = `700 ${size}px Gaegu`; w = g.measureText(txt).width; }
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.beginPath(); g.rect(pr.x - w / 2 - 8, pr.y - size, (w + 16) * p, size * 2); g.clip();
        g.shadowColor = rgba(PAPER, 0.95); g.shadowBlur = 12 * k;
        g.fillStyle = rgba(INK, 0.9); g.fillText(txt, pr.x, pr.y); g.fillText(txt, pr.x, pr.y);
        g.restore();
      },
    },
  };

  // 공용 소품 · 효과를 혹시 쓰면 그릴 수 있게 둔 단순한 펜(잉크 선 · 옅은 물감). 이 스타일의 장면 계획은 위 소품만 쓴다
  const pen = {
    style: 'watercolor',
    c: { ink: INK, white: PAPER, yellow: HUE.sun, ochre: mixc(HUE.sun, INK, 0.3), sky: HUE.water, brown: HUE.neutral, accent2: HUE.leaf, paper: PAPER },
    lw: () => 4,
    part(poly, fo) { if (fo) withSeed(31, () => washPoly(g, poly, fo.col || HUE.neutral, 0.8)); },
    line(pts, o = {}) { if ((o.draw ?? 1) <= 0 || pts.length < 2) return; withSeed(o.seed || 37, () => drawS(g, mk(pts, (o.w ?? 6) * 0.7, o.col || INK, { prof: 'even', nb: 0, a: 0.85 }), o.draw ?? 1)); },
    hatch(poly, o = {}) { withSeed(o.seed || 41, () => washPoly(g, poly, o.col || HUE.neutral, 0.7 * (o.p ?? 1))); },
    dab(x, y, r, o = {}) { withSeed(43, () => washPoly(g, circle(x, y, r, 20), o.col || INK, o.p ?? 1)); },
    text(str, x, y, o = {}) { g.save(); g.font = `700 ${o.size || 40}px Gaegu`; g.textAlign = o.align || 'center'; g.fillStyle = o.col || INK; g.fillText(str, x, y); g.restore(); },
  };

  // 물결치는 띠(세로 y0 ~ y1, 가장자리 흔들림) — 하늘 · 땅 · 바탕 물감
  // 물감 띠 가장자리는 시간에 따라 아주 천천히 일렁인다(젖은 물감이 번지는 느낌 — 다 칠한 장면도 멈춰 보이지 않게)
  let tNow = 0;
  function bandPts(y0, y1, seed, amp = 14) {
    const top = [], bot = [], ph = tNow * 0.35;
    for (let x = -PW * 0.6; x <= PW * 1.6; x += 24) {
      top.push([x, y0 + (fbm(x / 260 + seed + ph) - 0.5) * amp * 2]);
      bot.push([x, y1 + (fbm(x / 220 + seed + 9 - ph) - 0.5) * amp * 2]);
    }
    return [...top, ...bot.reverse()];
  }
  // 붓 자국 경계로 왼쪽부터 드러내기(장면 시작 draw_in일 때). u 0~1
  function brushReveal(u, fn) {
    if (u >= 1) { fn(); return; }
    if (u <= 0) return;
    const X = y => lerp(-PW * 0.6, PW * 1.6, u) + 30 * Math.sin(y * 0.012) + 18 * Math.sin(y * 0.041);
    g.save(); g.beginPath(); g.moveTo(-PW, -PH);
    for (let y = -PH; y <= PH * 2; y += 40) g.lineTo(X(y), y);
    g.lineTo(-PW, PH * 2); g.closePath(); g.clip(); fn(); g.restore();
  }
  const drawIn = (p, ctx) => (p.draw_in ? ss(clamp((ctx.local ?? 9) / 1.4)) : 1);

  const S = {
    slug: 'watercolor', canvas, drawFps: 30, W: Wc, H: Hc, k, c: pen.c,
    transitions: META.transitions, defaultBackground: 'page', sheetBackground: 'page',
    props,
    pen() { return pen; },
    begin({ cam, t }) {
      tNow = t || 0;
      g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
      g.drawImage(paper, 0, 0);
      const s = cam.zoom * k;
      g.translate(Wc / 2, Hc / 2); if (cam.rot) g.rotate(cam.rot * Math.PI / 180); g.scale(s, s); g.translate(-cam.x * PW, -cam.y * PH);
    },
    setBoil() {}, setPage() {},
    end() {},
    snapshot(dst) { dst.g.setTransform(1, 0, 0, 1, 0, 0); dst.g.clearRect(0, 0, Wc, Hc); dst.g.drawImage(canvas, 0, 0); },
    present(src) { g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.drawImage(src.c, 0, 0); },
    transitionFns: {
      // 붓 자국 경계 와이프(색 띠 없음)
      wipe: (gg, A, B, u, W, H) => wipeT(gg, A, B, u, W, H),
      'page-turn': pageTurn,
      // 안개: 앞 그림이 종이로 씻겨 나간 뒤 다음 그림이 드러난다(다른 그림끼리 섞지 않는다)
      fade(gg, A, B, u, W, H) {
        gg.setTransform(1, 0, 0, 1, 0, 0); gg.globalAlpha = 1;
        if (u < 0.5) { gg.drawImage(A, 0, 0, W, H); gg.globalAlpha = ss(u * 2); gg.drawImage(paper, 0, 0, W, H); }
        else { gg.drawImage(paper, 0, 0, W, H); gg.globalAlpha = ss((u - 0.5) * 2); gg.drawImage(B, 0, 0, W, H); }
        gg.globalAlpha = 1;
      },
    },
    backgrounds: {
      page: {
        params: { wash: '아래쪽 땅 · 바탕 물감 색(#hex, 없으면 빈 종이)', wash_y: '물감 띠 윗선 높이(0~1, 기본 0.8)', draw_in: 'true면 장면 시작에 붓이 왼쪽부터 칠함(약 1.4초)' },
        draw(S2, p, ctx) {
          if (isHex(p.wash)) {
            const y0 = (typeof p.wash_y === 'number' ? p.wash_y : 0.8) * PH;
            brushReveal(drawIn(p, ctx), () => withSeed(seedOf('page' + p.wash), () => washPoly(g, bandPts(y0, PH * 1.6, 3), p.wash, 0.55, 3, 4)));
          }
          return { ground: () => (isHex(p.wash) ? (typeof p.wash_y === 'number' ? p.wash_y : 0.8) * PH : PH * 0.8) };
        },
      },
      wash: {
        params: { color: '물감 색(#hex, 기본 하늘빛 #9fb4c4)', from: '띠 위(0~1, 기본 0)', to: '띠 아래(0~1, 기본 0.32)', ground: '아래쪽 땅 물감 색(#hex, 없으면 없음)', draw_in: 'true면 장면 시작에 붓이 왼쪽부터 칠함(약 1.4초)' },
        draw(S2, p, ctx) {
          const col = isHex(p.color) ? p.color : '#9fb4c4';
          const y0 = (typeof p.from === 'number' ? p.from : 0) * PH, y1 = (typeof p.to === 'number' ? p.to : 0.32) * PH;
          brushReveal(drawIn(p, ctx), () => withSeed(seedOf('wash' + col), () => {
            washPoly(g, bandPts(y0 <= 0 ? -PH : y0, y1, 5, 18), col, 0.5, 3, 5);
            // 위로 갈수록 한 번 더 겹쳐 진하게(투명 물감은 겹칠수록 진해진다)
            washPoly(g, bandPts(y0 <= 0 ? -PH : y0, lerp(y0, y1, 0.55), 8, 12), col, 0.25, 2, 4);
            if (isHex(p.ground)) washPoly(g, bandPts(PH * 0.8, PH * 1.6, 13), p.ground, 0.5, 3, 4);
          }));
          return { ground: () => PH * 0.8 };
        },
      },
      split: {
        params: { left: '왼쪽 물감 색(#hex, 기본 #e8c4a8)', right: '오른쪽 물감 색(#hex, 기본 #b9cfc0)', at: '나누는 x(0~1, 기본 0.5)' },
        draw(S2, p, ctx) {
          const L = isHex(p.left) ? p.left : '#e8c4a8', R = isHex(p.right) ? p.right : '#b9cfc0', mx = (typeof p.at === 'number' ? p.at : 0.5) * PW;
          const edge = (side) => { const pts = []; for (let y = -PH * 0.5; y <= PH * 1.5; y += 30) pts.push([mx + side * 14 + (fbm(y / 240 + side * 7 + tNow * 0.3) - 0.5) * 40, y]); return pts; };
          const u = ss(clamp((ctx.local ?? 9) / 0.9));
          withSeed(seedOf('split' + L + R), () => {
            g.save(); g.beginPath(); g.rect(-PW, PH * 0.5 - PH * u, PW * 3, PH * 2 * u); g.clip();
            washPoly(g, [[-PW, -PH * 0.5], ...edge(-1), [-PW, PH * 1.5]], L, 0.6, 3, 6);
            washPoly(g, [[PW * 2, -PH * 0.5], ...edge(1), [PW * 2, PH * 1.5]], R, 0.6, 3, 6);
            g.restore();
          });
          return { ground: () => PH * 0.8 };
        },
      },
    },
    fx: {
      bloom: {
        layer: 'under', desc: '물감 번짐: at 자리에 물감이 둥글게 퍼져 그 장면 끝까지 남음(1.2초) — 강조할 것 뒤',
        draw(S2, f) {
          if (f.age < 0) return;
          const u = eo(clamp(f.age / 1.2)), R = 190 * (0.35 + 0.65 * u);
          withSeed(1200 + f.index, () => { for (let i = 0; i < 3; i++) washPoly(g, circle(f.x + rnd(-10, 10), f.y + rnd(-10, 10), R * (1 - i * 0.22), 40), i ? HUE.sun : mixc(HUE.sun, PAPER, 0.3), 0.22 * u, 3, R * 0.06); });
        },
      },
      mist: {
        layer: 'over', desc: '안개: 종이색 띠가 아래에서 위로 지나감(1.4초) — 시간이 흐르거나 생각이 바뀌는 순간',
        draw(S2, f) {
          if (f.age < 0 || f.age > 1.4) return;
          const y = lerp(PH * 1.3, -PH * 0.3, ss(f.age / 1.4)), h = PH * 0.35;
          g.save(); g.setTransform(k, 0, 0, k, 0, 0);
          const gr = g.createLinearGradient(0, y - h, 0, y + h);
          gr.addColorStop(0, rgba(PAPER, 0)); gr.addColorStop(0.5, rgba(PAPER, 0.85)); gr.addColorStop(1, rgba(PAPER, 0));
          g.fillStyle = gr; g.fillRect(0, y - h, PW, h * 2); g.restore();
        },
      },
    },
  };
  return S;
}

function luminance(h) { const n = parseInt(h.slice(1), 16); return ((n >> 16 & 255) * 0.2126 + (n >> 8 & 255) * 0.7152 + (n & 255) * 0.0722) / 255; }

// 수채 종이(데모 paper.py와 같은 방법): 따뜻한 바탕 + 부드러운 얼룩 세 겹 ±3.5% + 짧은 섬유 + 고운 결 + 옅은 비네트. 시드 고정
function makePaper(W, H, base) {
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  const n = parseInt(base.slice(1), 16), br = n >> 16 & 255, bg = n >> 8 & 255, bb = n & 255;
  // 얼룩: 격자 난수를 겹선형으로 보간한 2D 값 잡음 세 겹(저해상도 캔버스에 칠해 늘린다 — 빠르고 결정적)
  const lw = Math.ceil(W / 6), lh = Math.ceil(H / 6), low = document.createElement('canvas'); low.width = lw; low.height = lh;
  const lc = low.getContext('2d'), img = lc.createImageData(lw, lh);
  const hash2 = (i, j, s) => { const v = Math.sin(i * 127.1 + j * 311.7 + s * 74.7) * 43758.5453; return v - Math.floor(v); };
  const noise2 = (x, y, s) => { const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy); return lerp(lerp(hash2(i, j, s), hash2(i + 1, j, s), u), lerp(hash2(i, j + 1, s), hash2(i + 1, j + 1, s), u), v) - 0.5; };
  for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
    const X = x * 6, Y = y * 6;
    const m = noise2(X / 240, Y / 240, 1) * 0.9 + noise2(X / 90, Y / 90, 2) * 0.5 + noise2(X / 25, Y / 25, 3) * 0.25;
    const vx = (X - W / 2) / (W * 0.62), vy = (Y - H / 2) / (H * 0.62), vig = 1 - 0.05 * Math.min(1.5, vx * vx + vy * vy);
    const f = (1 + m * 0.07) * vig, o = (y * lw + x) * 4;
    img.data[o] = br * f; img.data[o + 1] = bg * f; img.data[o + 2] = bb * f; img.data[o + 3] = 255;
  }
  lc.putImageData(img, 0, 0);
  c.imageSmoothingEnabled = true; c.drawImage(low, 0, 0, W, H);
  // 섬유
  withSeed(3, () => {
    c.lineWidth = 1; c.lineCap = 'round';
    const count = Math.round(2600 * (W * H) / (1920 * 1080));
    for (let i = 0; i < count; i++) {
      let x = rnd(0, W), y = rnd(0, H), a = rnd(0, Math.PI); const L = rnd(8, 40);
      c.strokeStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.10)' : 'rgba(120,100,70,0.07)';
      c.beginPath(); c.moveTo(x, y);
      for (let s = 0; s < 4; s++) { a += (rnd() - 0.5) * 0.7; x += Math.cos(a) * L / 4; y += Math.sin(a) * L / 4; c.lineTo(x, y); }
      c.stroke();
    }
  });
  // 고운 결(작은 점)
  withSeed(5, () => { for (let i = 0; i < W * H / 260; i++) { c.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(90,70,50,0.05)'; c.fillRect(rnd(0, W), rnd(0, H), 1.2, 1.2); } });
  return cv;
}

// 픽토그램 모션 스타일 모듈(Canvas 2D, WebGL 없음) — 캐릭터 없이 그림 · 도형 · 글자로 설명하는 방식.
// 문법은 lemo-opuscar styles/pictogram-motion(STYLE.md)을 따른다: 한 색상의 다섯 톤 격자 무늬(행이 옆으로 밀림),
// 둥근 막대 · 원 · 반원으로 된 기하 픽토그램, 아래에서 밀려 올라오는 굵은 글자, 진행 눈금 HUD. 얼굴 · 표정 · 외곽선 없음.
// 팔레트 · 격자 무늬 · 무늬 조각 · 마스크 글자 · 쉬운 함수는 그 데모 engine.js(MIT, Copyright 2026 LemoLab)를 옮겼다.
// 아이콘 · 상품 · 화살표 모양은 ../../explain.js(수채와 함께 쓰는 모양 사전)에서 오고, 여기서는 평면 색면으로 칠한다.
// 화면 글자는 장면표가 정한 글자(word 소품)만 그린다. HUD는 숫자 없이 눈금만 — 장면표 밖 글자를 화면에 넣지 않기 위해서다.
import { clamp, lerp } from '/core/lib.js';
import { seedOf } from '../../geom.js';
import { ICONS, UNIT, productPrims, arrowPrims, placePrims } from '../../explain.js';

export const META = {
  render_mode: '2d', webgl: false,
  transitions: ['cut', 'wipe', 'match'],   // 격자 행이 엇갈려 밀려 들어오는 전환(wipe). 디졸브 없음
};

// ── 쉬운 함수 · 색 (pictogram-motion demo engine.js) ──────────────────────────
const E = {
  oExp: t => (t = clamp(t), t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  ioExp: t => (t = clamp(t), t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2),
  oBack: (t, s = 1.7) => (t = clamp(t) - 1, t * t * ((s + 1) * t + s) + 1),
};
const rng = seed => { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const toHex = c => '#' + c.map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => { const A = hex(a), B = hex(b); return toHex(A.map((v, i) => lerp(v, B[i], t))); };
const rgba = (h, a) => { const c = hex(h); return `rgba(${c[0]},${c[1]},${c[2]},${a})`; };
const lum = h => { const [r, g, b] = hex(h).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const isHex = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

const CREAM = '#fbf6ec', INK = '#111521';
// 화면 글자 글꼴: 장면표가 고른 스킬 강조어 글꼴('MCB Scene', lib/lemo/run.ts가 렌더 폴더 fonts.css에 넣는다)을 먼저 쓰고,
// 못 받았으면 엔진의 Pretendard로 나온다(대체 글꼴 — run.ts가 경고를 남긴다)
const FONT = `'MCB Scene', Pretendard`;
const FONT_SAMPLE = '가나다라마바사아자차카타파하0123456789%';
// 다섯 색상 + 어두운 중립색, 색마다 다섯 톤(어두움 → 밝음). 이름은 데모의 것(실제 행사 색 이름이 아니다)
export const HUES = {
  navy: ['#13254a', '#1a3263', '#24457d', '#3b5e95', '#5d7cad'],
  teal: ['#00544c', '#00685d', '#0b7f70', '#2e9686', '#5fae9f'],
  sky: ['#4b95c4', '#61a5d0', '#7ab6da', '#97c7e3', '#b8daeb'],
  coral: ['#a93726', '#c04731', '#d75d43', '#e2785c', '#ea957a'],
  yellow: ['#d39400', '#e4a608', '#f2ba1d', '#f6c94a', '#f9d87e'],
  ink: ['#0c1018', '#131924', '#1b2230', '#272f41', '#374055'],
};
// 색상 하나 → 다섯 톤 · 글자색 · 먼 쪽 색 · 강조색. hue는 HUES 이름 또는 #hex(브랜드 색)
function palette(hue) {
  const key = HUES[hue] ? hue : null;
  const base = key ? HUES[key][2] : isHex(hue) ? hue : HUES.teal[2];
  const t = key ? HUES[key] : [mix(base, '#0c1018', 0.42), mix(base, '#0c1018', 0.2), base, mix(base, '#ffffff', 0.2), mix(base, '#ffffff', 0.4)];
  const light = lum(base) > 0.36;
  const fg = light ? INK : CREAM;
  // 밝은 색은 어두운 글자 · 밝은 무대 원, 어두운 중립색은 따뜻한 강조색 하나(STYLE §3)
  const accent = key === 'yellow' || (!key && lum(base) > 0.45 && hex(base)[0] > hex(base)[2]) ? HUES.coral[2] : HUES.yellow[2];
  return { key: key || base, t, base: t[2], fg, far: mix(fg, t[2], 0.42), accent, disc: light ? t[4] : t[3], light };
}

export function create(canvas, prod) {
  const Wc = canvas.width, Hc = canvas.height, g = canvas.getContext('2d');
  const PW = prod.size.w, PH = prod.size.h, k = Wc / PW;
  const params = prod.style.params || {};
  const CELL = Math.round(PW / 6);   // 정사각 격자 한 칸(세로 영상은 폭의 1/6)
  const sceneIndex = s => Math.max(0, prod.scenes.findIndex(x => x.id === s.id));

  // ── 격자 무늬(행 단위로 밀림) ──
  const patCache = new Map();
  const MOTIFS = [0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 13, 19, 20];
  function disc(c, x, y, r, col) { if (r <= 0) return; c.fillStyle = col; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); }
  function seg(c, a, b, w, col) { c.strokeStyle = col; c.lineWidth = w; c.lineCap = 'round'; c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); }
  function motif(c, kind, x, y, s, [a, b, cc], r) {
    c.save(); c.beginPath(); c.rect(x, y, s, s); c.clip();
    c.fillStyle = a; c.fillRect(x, y, s, s);
    const rot = Math.floor(r() * 4);
    c.translate(x + s / 2, y + s / 2); c.rotate(rot * Math.PI / 2); c.translate(-s / 2, -s / 2);
    switch (kind) {
      case 0: disc(c, 0, 0, s, b); break;
      case 1: disc(c, s / 2, s, s / 2, b); break;
      case 2: disc(c, s / 2, s / 2, s / 2, b); disc(c, s * 0.62, s * 0.42, s * 0.13, cc); break;
      case 3: { c.save(); c.beginPath(); c.arc(s / 2, s, s / 2, Math.PI, 0); c.clip(); for (let i = 0; i < 7; i++) { c.fillStyle = i % 2 ? b : cc; c.fillRect(0, s / 2 + i * s / 14, s, s / 14); } c.restore(); break; }
      case 4: { const q = s / 4; for (let row = 0; row < 5; row++) for (let i = -1; i < 5; i++) { const cx = i * q + (row % 2 ? q / 2 : 0), cy = row * q * 0.5 + q * 0.5; disc(c, cx, cy, q * 0.5, row % 2 ? b : cc); disc(c, cx, cy, q * 0.3, a); } break; }
      case 5: { disc(c, s / 2, s / 2, s / 2, b); c.save(); c.beginPath(); c.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2); c.clip(); const q = s / 6; for (let j = 0; j < 7; j++) for (let i = 0; i < 7; i++) disc(c, i * q + (j % 2 ? q / 2 : 0), j * q, q * 0.36, cc); c.restore(); break; }
      case 7: for (let i = 5; i >= 1; i--) disc(c, 0, s, (s * i) / 5, i % 2 ? b : a); break;
      case 8: { const R = s * 0.3; c.fillStyle = b; c.beginPath(); for (let i = 0; i < 16; i++) { const t0 = (i / 16) * Math.PI * 2; c.moveTo(s / 2, s / 2); c.arc(s / 2, s / 2, R * 1.35, t0, t0 + Math.PI / 32); } c.fill(); disc(c, s / 2, s / 2, R, b); disc(c, s / 2, s / 2, R * 0.55, cc); break; }
      case 9: { disc(c, s, s, s * 0.9, b); const q = s / 7; for (let j = 0; j < 7; j++) for (let i = 0; i < 7; i++) if ((i + j) % 2 === 0) { c.fillStyle = cc; c.fillRect(i * q + q * 0.2, j * q + q * 0.2, q * 0.6, q * 0.6); } break; }
      case 10: disc(c, s / 2, s / 2, s * 0.46, b); disc(c, s * 0.66, s * 0.38, s * 0.4, a); break;
      case 11: disc(c, 0, s / 2, s / 2, b); disc(c, s, s / 2, s / 2, cc); break;
      case 13: for (let i = 0; i < 9; i++) { c.globalAlpha = 1 - i / 10; c.fillStyle = b; c.fillRect(0, s * 0.1 + i * s * 0.09, s * (1 - i * 0.06), s * 0.045); } c.globalAlpha = 1; break;
      case 19: disc(c, s / 2, s / 2, s * 0.4, b); disc(c, s / 2, s / 2, s * 0.24, a); disc(c, s / 2, s / 2, s * 0.08, cc); break;
      case 20: { c.lineJoin = 'round'; c.strokeStyle = b; c.lineWidth = s * 0.1; c.lineCap = 'round'; for (let i = 0; i < 2; i++) { c.beginPath(); c.moveTo(s * (0.28 + i * 0.24), s * 0.25); c.lineTo(s * (0.48 + i * 0.24), s * 0.5); c.lineTo(s * (0.28 + i * 0.24), s * 0.75); c.stroke(); } break; }
    }
    c.restore();
  }
  // 무늬 캔버스(세계 px). spread: 톤 대비(1 = 원래 대비, 작을수록 바탕 톤에 가까움). 크기 제한 있는 캐시(STYLE §9)
  function pattern(P, seed, spread, density) {
    const key = [P.key, seed, spread, density].join('|');
    if (patCache.has(key)) { const v = patCache.get(key); patCache.delete(key); patCache.set(key, v); return v; }
    if (patCache.size > 6) patCache.delete(patCache.keys().next().value);
    const S = CELL, T = P.t.map(c => mix(P.base, c, spread));
    const cols = Math.ceil(PW / S) + 3, rows = Math.ceil(PH / S) + 2;
    const cv = document.createElement('canvas'); cv.width = cols * S; cv.height = rows * S;
    const c = cv.getContext('2d'), r = rng(seed * 7919 + 13);
    c.fillStyle = T[1]; c.fillRect(0, 0, cv.width, cv.height);
    for (let j = -1; j < rows; j++) for (let i = -1; i < cols; i++) {
      const q = r(), cx = i * S, cy = j * S;
      if (q < 0.34) disc(c, cx + S, cy + S, S, T[Math.floor(r() * 4)]);
      else if (q < 0.5) { disc(c, cx + S, cy + S, S, T[3]); disc(c, cx + S, cy + S, S * 0.5, T[0]); }
    }
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      if (r() > density) continue;
      const pick = () => T[Math.floor(r() * 5)];
      let a = pick(), b = pick(); while (b === a) b = pick();
      let cc = pick(); while (cc === b) cc = pick();
      motif(c, MOTIFS[Math.floor(r() * MOTIFS.length)], i * S, j * S, S, [a, b, cc], r);
    }
    patCache.set(key, cv);
    return cv;
  }
  // 무늬를 행마다 옆으로 밀어 그린다(행 j는 offs(j) px). y0 ~ y1 행만
  function drawPattern(pat, offs, y0 = -CELL, y1 = PH + CELL) {
    const S = CELL;
    for (let j = Math.floor(y0 / S); j * S < y1; j++) {
      let dx = offs(j); dx = ((dx % S) + S) % S - S;
      const row = ((j % (pat.height / S)) + pat.height / S) % (pat.height / S);
      g.drawImage(pat, 0, row * S, pat.width, S, dx - S, j * S, pat.width, S + 0.5);
    }
  }
  const drift = (p, t) => j => (j % 2 ? 1 : -1) * (typeof p.drift === 'number' ? p.drift : 14) * t + j * 37;

  // ── 장면 색(배경이 정하고 소품이 읽는다) ──
  let cur = { at: () => palette('teal'), bgAt: () => HUES.teal[2] };
  const colorsAt = x => cur.at(x);

  function hud(scene) {
    // 진행 눈금(장면 수만큼): 지금 칸은 길게, 지난 칸은 흐리게, 남은 칸은 더 흐리게. 숫자는 쓰지 않는다
    const N = prod.scenes.length; if (N < 2) return;
    const i = sceneIndex(scene), P = colorsAt(PW / 2), gap = 26, w = 6;
    const x0 = PW / 2 - ((N - 1) * gap) / 2, y = PH * 0.05;
    g.save(); g.setTransform(k, 0, 0, k, 0, 0);
    for (let n = 0; n < N; n++) {
      const h = n === i ? 30 : 13;
      g.fillStyle = rgba(P.fg, n === i ? 0.95 : n < i ? 0.5 : 0.22);
      g.beginPath(); g.roundRect(x0 + n * gap - w / 2, y - h / 2, w, h, w / 2); g.fill();
    }
    g.restore();
  }

  // ── 평면 도형 칠하기 ──
  function paint(prims, col) {
    for (const p of prims) {
      const c = col(p.c); if (!c) continue;
      if (p.t === 'disc') disc(g, p.x, p.y, p.r, c);
      else if (p.t === 'ring') { g.strokeStyle = c; g.lineWidth = p.w; g.beginPath(); g.arc(p.x, p.y, p.r, 0, Math.PI * 2); g.stroke(); }
      else if (p.t === 'seg') seg(g, p.a, p.b, p.w, c);
      else { g.fillStyle = c; g.beginPath(); p.pts.forEach((q, i) => (i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]))); g.closePath(); g.fill(); }
    }
  }
  // 등장: 가로 띠 다섯 개가 번갈아 양옆에서 밀려와 맞춰진다(STYLE §5 pictogram assembly). age<0이면 아직 없음
  function assemble(age, x, y, s, draw) {
    if (age < 0) return;
    const dur = 0.42;
    if (age >= dur + 0.2) { draw(); return; }
    const top = y - s * 0.6, h = s * 1.2, bands = 5;
    for (let b = 0; b < bands; b++) {
      const e = E.oExp(clamp((age - b * 0.04) / dur));
      if (e <= 0) continue;
      g.save(); g.beginPath(); g.rect(x - s, top + (b * h) / bands - 0.5, s * 2, h / bands + 1); g.clip();
      g.translate((1 - e) * s * 1.6 * (b % 2 ? 1 : -1), 0); g.globalAlpha = Math.min(1, e * 1.5);
      draw(); g.restore();
    }
  }
  const stateAge = pr => (pr.at != null ? pr.age : 99);

  const productLook = () => ({
    shape: params.product_shape || 'bottle', fruit: params.product_fruit || 'apple',
    body: isHex(params.product_body) ? params.product_body : null, cap: isHex(params.product_cap) ? params.product_cap : null, band: isHex(params.product_band) ? params.product_band : null,
  });

  const props = {
    product: {
      layer: 'obj', desc: '소개하는 상품(용기 · 원물 모양, 글자 · 로고 없음). state "in@초"면 그때 띠가 맞춰지며 나타남',
      draw(pen, pr) {
        const s = UNIT * pr.scale, P = colorsAt(pr.x), L = productLook();
        const body = L.body || P.accent, cap = L.cap || P.fg, band = L.band || mix(body, CREAM, 0.55);
        const col = c => ({ body, cap, band, shade: mix(body, '#000000', 0.2), light: mix(body, '#ffffff', 0.5) })[c] || body;
        assemble(stateAge(pr), pr.x, pr.y, s, () => paint(placePrims(productPrims(L.shape, L.fruit), pr.x, pr.y, s), col));
      },
    },
    icon: {
      layer: 'obj', desc: '픽토그램 아이콘. state "이름" 또는 "이름@초"',
      draw(pen, pr) {
        const def = ICONS[pr.name]; if (!def) return;
        const s = UNIT * pr.scale, P = colorsAt(pr.x), cut = cur.bgAt(pr.x, pr.y);
        const col = c => ({ main: P.fg, dark: P.far, accent: P.accent, light: P.t[4], cut })[c] || P.fg;
        const prims = def.prims(def.spin ? pr.q * 0.35 : 0);
        assemble(stateAge(pr), pr.x, pr.y, s, () => paint(placePrims(prims, pr.x, pr.y, s), col));
      },
    },
    arrow: {
      layer: 'obj', desc: '화살표(가운데 기준, scale 1 = 길이 150px). state "right|left|up|down" 또는 "방향@초"(그때부터 자라남)',
      draw(pen, pr) {
        const age = stateAge(pr); if (age < 0) return;
        const s = UNIT * pr.scale, P = colorsAt(pr.x), d = E.oExp(clamp(age / 0.45));
        paint(placePrims(arrowPrims(pr.name || 'right', d), pr.x, pr.y, s), () => P.fg);
      },
    },
    bullet: {
      layer: 'obj', desc: '목록 점(강조색 원, scale 1 = 지름 약 54px). state "on@초"면 그때 튀어나옴',
      draw(pen, pr) {
        const age = stateAge(pr); if (age < 0) return;
        const P = colorsAt(pr.x), r = UNIT * pr.scale * 0.18 * E.oBack(clamp(age / 0.3));
        disc(g, pr.x, pr.y, r, P.accent);
      },
    },
    word: {
      layer: 'bg', desc: '화면 글자(장면표가 정한 글자만). 굵은 글자가 아래에서 밀려 올라옴. state "글자" 또는 "글자@초"',
      draw(pen, pr) {
        const txt = pr.name || ''; if (!txt) return;
        const age = stateAge(pr); if (age < 0) return;
        const P = colorsAt(pr.x);
        let size = 57.6 * pr.scale * 1.1;
        g.save(); g.font = `800 ${size}px ${FONT}`;
        let w = g.measureText(txt).width;
        if (w > PW * 0.9) { size *= (PW * 0.9) / w; g.font = `800 ${size}px ${FONT}`; w = g.measureText(txt).width; }
        g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.letterSpacing = `${-size * 0.02}px`;
        const m = g.measureText(txt), asc = m.actualBoundingBoxAscent || size * 0.8, desc = m.actualBoundingBoxDescent || size * 0.2;
        const base = pr.y + (asc - desc) / 2;   // at = 글자 가운데
        g.beginPath(); g.rect(pr.x - w / 2 - 20, base - asc - 8, w + 40, asc + desc + 16); g.clip();
        const dy = (1 - E.oExp(clamp(age / 0.55))) * (asc + desc + 20);
        g.fillStyle = P.fg; g.fillText(txt, pr.x, base + dy);
        g.restore();
      },
    },
  };

  // 공용 소품 · 효과(해 · 구름 등)를 혹시 쓰면 그릴 수 있게 둔 단순한 펜. 이 스타일의 장면 계획은 위 소품만 쓴다
  const pen = {
    style: 'pictogram-motion',
    get c() { const P = colorsAt(PW / 2); return { ink: P.fg, white: CREAM, yellow: HUES.yellow[2], ochre: HUES.yellow[0], sky: HUES.sky[2], brown: HUES.coral[0], accent2: HUES.teal[2], paper: P.base }; },
    lw: () => 6,
    part(poly, fo) { if (!fo) return; g.fillStyle = fo.col || colorsAt(PW / 2).fg; g.beginPath(); poly.forEach((q, i) => (i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]))); g.closePath(); g.fill(); },
    line(pts, o = {}) { if ((o.draw ?? 1) <= 0 || pts.length < 2) return; g.strokeStyle = o.col || colorsAt(PW / 2).fg; g.lineWidth = (o.w ?? 6) * 0.8; g.lineCap = 'round'; g.lineJoin = 'round'; g.beginPath(); pts.forEach((q, i) => (i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]))); g.stroke(); },
    hatch(poly, o = {}) { this.part(poly, { col: o.col }); },
    dab(x, y, r, o = {}) { disc(g, x, y, r, o.col || colorsAt(x).fg); },
    text(str, x, y, o = {}) { g.save(); g.font = `800 ${o.size || 40}px ${FONT}`; g.textAlign = o.align || 'center'; g.fillStyle = o.col || colorsAt(x).fg; g.fillText(str, x, y); g.restore(); },
  };

  const S = {
    slug: 'pictogram-motion', canvas, drawFps: 24, W: Wc, H: Hc, k,
    get c() { return pen.c; },
    transitions: META.transitions, defaultBackground: 'grid', sheetBackground: 'grid',
    // main.js가 기다린다: 굵은 글자 글꼴
    // 고른 글꼴이 등록되지 않았으면 그 load는 빈 목록으로 끝나 Pretendard만 기다린다
    ready: Promise.all([document.fonts.load(`800 60px 'MCB Scene'`, FONT_SAMPLE), document.fonts.load('800 60px Pretendard', FONT_SAMPLE)]),
    props,
    pen() { return pen; },
    begin({ cam }) {
      g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
      g.fillStyle = HUES.ink[1]; g.fillRect(0, 0, Wc, Hc);
      const s = cam.zoom * k;
      g.translate(Wc / 2, Hc / 2); if (cam.rot) g.rotate(cam.rot * Math.PI / 180); g.scale(s, s); g.translate(-cam.x * PW, -cam.y * PH);
    },
    setBoil() {}, setPage() {},
    end() {},
    snapshot(dst) { dst.g.setTransform(1, 0, 0, 1, 0, 0); dst.g.clearRect(0, 0, Wc, Hc); dst.g.drawImage(canvas, 0, 0); },
    present(src) { g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.drawImage(src.c, 0, 0); },
    transitionFns: {
      // 격자 행 전환: 한 칸 높이의 행들이 번갈아 왼쪽 · 오른쪽에서 밀려 들어와 다음 장면이 된다
      wipe(gg, A, B, u, W, H) {
        gg.setTransform(1, 0, 0, 1, 0, 0); gg.globalAlpha = 1; gg.drawImage(A, 0, 0, W, H);
        const S = CELL * k, rows = Math.ceil(H / S), lag = 0.4 / rows;
        for (let j = 0; j < rows; j++) {
          const e = E.ioExp(clamp((u - j * lag) / 0.6));
          if (e <= 0) continue;
          const dx = (1 - e) * W * (j % 2 ? 1 : -1);
          gg.drawImage(B, 0, j * S, W, S, dx, j * S, W, S);
        }
      },
    },
    backgrounds: {
      grid: {
        params: { hue: '색상(navy · teal · sky · coral · yellow · ink 또는 #hex 브랜드 색, 기본 teal)', contrast: 'low(기본 — 글자 · 픽토그램 아래) | full(장 시작 카드처럼 무늬가 주인공)', drift: '행이 옆으로 흐르는 속도(px/초, 기본 14, 0이면 멈춤)' },
        draw(S2, p, ctx) {
          const P = palette(p.hue || 'teal'), full = p.contrast === 'full';
          cur = { at: () => P, bgAt: () => P.base };
          g.fillStyle = P.t[1]; g.fillRect(-PW, -PH, PW * 3, PH * 3);
          drawPattern(pattern(P, seedOf(String(ctx.scene ? ctx.scene.background : 'grid')), full ? 1 : 0.32, full ? 0.55 : 0.42), drift(p, ctx.t));
          if (ctx.scene) hud(ctx.scene);
          return { ground: () => PH * 0.8 };
        },
      },
      stage: {
        params: { hue: '색상(위와 같음, 기본 navy)', disc_x: '무대 원 가운데 x(0~1, 기본 0.5)', disc_y: '무대 원 가운데 y(0~1, 기본 0.45)', disc_r: '무대 원 반지름(화면 폭 비율, 기본 0.36)', band: 'top | bottom | none — 옅은 무늬 띠 한 줄(기본 bottom)' },
        draw(S2, p, ctx) {
          const P = palette(p.hue || 'navy');
          const dx = (typeof p.disc_x === 'number' ? p.disc_x : 0.5) * PW, dy = (typeof p.disc_y === 'number' ? p.disc_y : 0.45) * PH, R = (typeof p.disc_r === 'number' ? p.disc_r : 0.36) * PW;
          cur = { at: () => P, bgAt: (x, y) => (Math.hypot(x - dx, y - dy) < R ? P.disc : P.base) };
          g.fillStyle = P.base; g.fillRect(-PW, -PH, PW * 3, PH * 3);
          const band = p.band || 'bottom';
          if (band !== 'none') {
            const pat = pattern(P, seedOf(String(ctx.scene ? ctx.scene.background : 'stage')), 0.3, 0.45);
            const y0 = band === 'top' ? 0 : Math.floor(PH / CELL) * CELL - CELL * 0.4;
            drawPattern(pat, drift(p, ctx.t), y0, y0 + CELL);
          }
          // 무대 원: 장면 시작 0.4초 동안 커지며 들어온다. 옅은 빛 한 줄기가 천천히 지나간다(유일한 그러데이션)
          const e = E.oExp(clamp((ctx.local ?? 1) / 0.4));
          disc(g, dx, dy, R * (0.6 + 0.4 * e), P.disc);
          g.save(); g.beginPath(); g.arc(dx, dy, R * (0.6 + 0.4 * e), 0, Math.PI * 2); g.clip();
          const sx = dx - R * 2 + ((ctx.t * 90) % (R * 4)), gr = g.createLinearGradient(sx - R * 0.4, 0, sx + R * 0.4, 0);
          gr.addColorStop(0, rgba('#ffffff', 0)); gr.addColorStop(0.5, rgba('#ffffff', 0.09)); gr.addColorStop(1, rgba('#ffffff', 0));
          g.fillStyle = gr; g.fillRect(dx - R, dy - R, R * 2, R * 2); g.restore();
          if (ctx.scene) hud(ctx.scene);
          return { ground: () => dy + R };
        },
      },
      split: {
        params: { left: '왼쪽 색상(기본 coral)', right: '오른쪽 색상(기본 teal)', at: '나누는 x(0~1, 기본 0.5)' },
        draw(S2, p, ctx) {
          const A = palette(p.left || 'coral'), B = palette(p.right || 'teal'), mx = (typeof p.at === 'number' ? p.at : 0.5) * PW;
          cur = { at: x => (x < mx ? A : B), bgAt: x => (x < mx ? A.base : B.base) };
          // 나누는 선이 장면 시작에 위아래로 그어지며 두 쪽이 갈라진다
          const e = E.ioExp(clamp((ctx.local ?? 1) / 0.5));
          g.fillStyle = A.base; g.fillRect(-PW, -PH, mx + PW, PH * 3);
          g.fillStyle = B.base; g.fillRect(mx, -PH, PW * 2, PH * 3);
          const pa = pattern(A, 11, 0.3, 0.45), pb = pattern(B, 23, 0.3, 0.45), y0 = Math.floor(PH / CELL) * CELL - CELL * 0.4;
          g.save(); g.beginPath(); g.rect(-PW, -PH, mx + PW, PH * 3); g.clip(); drawPattern(pa, drift(p, ctx.t), y0, y0 + CELL); g.restore();
          g.save(); g.beginPath(); g.rect(mx, -PH, PW * 2, PH * 3); g.clip(); drawPattern(pb, drift(p, ctx.t), y0, y0 + CELL); g.restore();
          g.fillStyle = INK; g.fillRect(mx - 3, PH * 0.5 - PH * 0.6 * e, 6, PH * 1.2 * e);
          if (ctx.scene) hud(ctx.scene);
          return { ground: () => PH * 0.8 };
        },
      },
    },
    fx: {
      pop: {
        layer: 'over', desc: '고리 세 개가 퍼짐(0.6초) — 픽토그램이 들어오거나 답이 나오는 순간',
        draw(S2, f) {
          if (f.age < 0 || f.age > 0.6) return;
          const P = colorsAt(f.x);
          for (let i = 0; i < 3; i++) { const u = clamp((f.age - i * 0.08) / 0.45); if (u <= 0 || u >= 1) continue; g.strokeStyle = rgba(P.accent, 1 - u); g.lineWidth = 10 * (1 - u) + 2; g.beginPath(); g.arc(f.x, f.y, 60 + 160 * E.oExp(u), 0, Math.PI * 2); g.stroke(); }
        },
      },
      sweep: {
        layer: 'over', desc: '빛 한 줄기가 화면을 비스듬히 지나감(0.9초) — 장면을 넘기는 박자',
        draw(S2, f) {
          if (f.age < 0 || f.age > 0.9) return;
          const u = E.ioExp(f.age / 0.9), x = lerp(-PW * 0.6, PW * 1.6, u);
          g.save(); g.setTransform(k, 0, 0, k, 0, 0); g.translate(x, PH / 2); g.rotate(-0.35);
          const gr = g.createLinearGradient(-PW * 0.2, 0, PW * 0.2, 0);
          gr.addColorStop(0, rgba('#ffffff', 0)); gr.addColorStop(0.5, rgba('#ffffff', 0.16)); gr.addColorStop(1, rgba('#ffffff', 0));
          g.fillStyle = gr; g.fillRect(-PW * 0.2, -PH, PW * 0.4, PH * 2); g.restore();
        },
      },
    },
  };
  return S;
}

// 캐릭터 없이 설명하는 스타일(픽토그램 모션 · 수채 붓)이 함께 쓰는 모양 사전.
// 아이콘 · 상품 · 화살표를 "기본 도형 목록"(원 · 둥근 막대 · 다각형 · 고리)으로만 적고, 그리는 법은 스타일이 정한다
// (픽토그램은 평면 색면, 수채는 붓 자국 · 물감 번짐). 얼굴 · 표정은 없다.
// 좌표: 가운데 (0,0), 세로 1 = 소품 scale 1의 높이(1080 폭 기준 150px). 위가 음수.
// 색 역할(c): main 주색 · dark 먼 쪽(어두운 면) · accent 강조 · light 밝은 면 · cut 배경색(뚫린 자리)
//   상품만: body 몸 · cap 뚜껑 · 꼭지 · band 띠(글자 없는 라벨 자리) · shade 몸 그늘
// 상품은 실제 사진을 쓰지 않는다. 장면 데이터(style.params의 product_*)에 적힌 용기 · 생김새 · 색으로 비슷한 결로 그린다(글자 · 로고 없음).
// 일부 모양(물방울 · 구름 · 해 · 둥근 막대 원칙)은 lemo-opuscar styles/pictogram-motion/demo/engine.js(MIT, Copyright 2026 LemoLab)에서 옮겼다.

export const UNIT = 150;   // scale 1 = 150px(1080 폭 기준)

const TAU = Math.PI * 2;
const circlePts = (x, y, rx, ry = rx, n = 40, a0 = 0, a1 = TAU) => { const o = []; for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; o.push([x + Math.cos(a) * rx, y + Math.sin(a) * ry]); } return o; };
const quad = (p0, c, p1, n = 10) => { const o = []; for (let i = 0; i <= n; i++) { const t = i / n, u = 1 - t; o.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]]); } return o; };
// 모서리가 둥근 사각형(가운데 x,y, 폭 w, 높이 h, 반지름 r)
export function rrectPts(x, y, w, h, r, n = 6) {
  r = Math.min(r, w / 2, h / 2);
  const x0 = x - w / 2, x1 = x + w / 2, y0 = y - h / 2, y1 = y + h / 2;
  return [
    ...circlePts(x1 - r, y0 + r, r, r, n, -Math.PI / 2, 0), ...circlePts(x1 - r, y1 - r, r, r, n, 0, Math.PI / 2),
    ...circlePts(x0 + r, y1 - r, r, r, n, Math.PI / 2, Math.PI), ...circlePts(x0 + r, y0 + r, r, r, n, Math.PI, Math.PI * 1.5),
  ];
}
// 물방울(원 + 뾰족한 위) — pictogram-motion G.drop의 곡선을 점으로
function dropPts(x, y, r) {
  return [...quad([x, y - r * 2.5], [x + r * 0.95, y - r * 0.9], [x + r, y]), ...circlePts(x, y, r, r, 20, 0, Math.PI).slice(1), ...quad([x - r, y], [x - r * 0.95, y - r * 0.9], [x, y - r * 2.5]).slice(1)];
}
// 잎(렌즈 모양): a → b 사이, 폭 w
function leafPts(a, b, w) {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, nx = -dy / L * w, ny = dx / L * w;
  return [...quad(a, [mx + nx, my + ny], b, 12), ...quad(b, [mx - nx, my - ny], a, 12).slice(1)];
}
// 먼 쪽 그늘(초승달): 몸 타원 (cx, cy, rx, ry)의 오른쪽 가장자리와, 가운데 쪽으로 k만큼 당긴 안쪽 곡선 사이
function farSide(cx, cy, rx, ry, k = 0.32, a1 = 1.15) {
  const outer = circlePts(cx, cy, rx, ry, 18, -a1, a1), c1 = Math.cos(a1);
  const inner = outer.slice().reverse().map(([x, y]) => { const a = Math.atan2((y - cy) / ry, (x - cx) / rx), f = 1 - k * clamp01((Math.cos(a) - c1) / (1 - c1)); return [cx + (x - cx) * f, y]; });
  return [...outer, ...inner];
}
const clamp01 = v => Math.max(0, Math.min(1, v));
function starPts(x, y, R, r, n = 5, rot = -Math.PI / 2) { const o = []; for (let i = 0; i < n * 2; i++) { const a = rot + i * Math.PI / n, rr = i % 2 ? r : R; o.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr]); } return o; }
function heartPts(x, y, s) {
  const o = []; for (let i = 0; i <= 48; i++) { const t = i / 48 * TAU; const hx = 16 * Math.pow(Math.sin(t), 3), hy = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t); o.push([x + hx * s / 17, y - hy * s / 17]); }
  return o;
}

// ── 아이콘 ────────────────────────────────────────────────────────────────────
// hue: 수채가 고르는 자연색 힌트(water · leaf · sun · warm · red · neutral). 픽토그램은 장면 색을 쓴다
export const ICONS = {
  drop: { hue: 'water', desc: '물방울 · 수분', prims: () => [{ t: 'poly', pts: dropPts(0, 0.2, 0.27), c: 'main' }, { t: 'disc', x: -0.09, y: 0.2, r: 0.07, c: 'light' }] },
  leaf: { hue: 'leaf', desc: '잎 · 식물 원료', prims: () => [{ t: 'poly', pts: leafPts([-0.3, 0.38], [0.32, -0.4], 0.34), c: 'main' }, { t: 'seg', a: [-0.36, 0.45], b: [0.2, -0.24], w: 0.05, c: 'dark' }] },
  sprout: { hue: 'leaf', desc: '새싹 · 자라남', prims: () => [{ t: 'seg', a: [0, 0.46], b: [0, -0.05], w: 0.07, c: 'dark' }, { t: 'poly', pts: leafPts([0, -0.05], [-0.38, -0.32], 0.16), c: 'main' }, { t: 'poly', pts: leafPts([0, -0.02], [0.4, -0.4], 0.18), c: 'main' }] },
  flower: { hue: 'warm', desc: '꽃 · 향', prims: () => [{ t: 'seg', a: [0, 0.48], b: [0, 0.05], w: 0.06, c: 'dark' }, ...[0, 1, 2, 3, 4].map(i => { const a = -Math.PI / 2 + i * TAU / 5; return { t: 'disc', x: Math.cos(a) * 0.17, y: -0.12 + Math.sin(a) * 0.17, r: 0.13, c: 'main' }; }), { t: 'disc', x: 0, y: -0.12, r: 0.09, c: 'accent' }] },
  sun: { hue: 'sun', desc: '해 · 햇빛 · 낮', spin: true, prims: (spin = 0) => [{ t: 'disc', x: 0, y: 0, r: 0.22, c: 'main' }, ...Array.from({ length: 12 }, (_, i) => { const a = spin + i / 12 * TAU; return { t: 'seg', a: [Math.cos(a) * 0.3, Math.sin(a) * 0.3], b: [Math.cos(a) * 0.38, Math.sin(a) * 0.38], w: 0.045, c: 'main' }; })] },
  cloud: { hue: 'water', desc: '구름 · 날씨', prims: () => [{ t: 'disc', x: -0.18, y: 0.02, r: 0.17, c: 'main' }, { t: 'disc', x: 0.02, y: -0.07, r: 0.23, c: 'main' }, { t: 'disc', x: 0.24, y: 0.04, r: 0.15, c: 'main' }, { t: 'poly', pts: rrectPts(0.02, 0.12, 0.72, 0.18, 0.09), c: 'main' }] },
  snow: { hue: 'water', desc: '눈 · 차가움 · 냉장', prims: () => [0, 1, 2].flatMap(i => { const a = i * Math.PI / 3, c = Math.cos(a), s = Math.sin(a); return [{ t: 'seg', a: [-c * 0.4, -s * 0.4], b: [c * 0.4, s * 0.4], w: 0.06, c: 'main' }, ...[1, -1].flatMap(k => [{ t: 'seg', a: [k * c * 0.26, k * s * 0.26], b: [k * c * 0.26 + Math.cos(a + 0.7) * 0.1 * k, k * s * 0.26 + Math.sin(a + 0.7) * 0.1 * k], w: 0.045, c: 'main' }, { t: 'seg', a: [k * c * 0.26, k * s * 0.26], b: [k * c * 0.26 + Math.cos(a - 0.7) * 0.1 * k, k * s * 0.26 + Math.sin(a - 0.7) * 0.1 * k], w: 0.045, c: 'main' }])]; }) },
  fire: { hue: 'warm', desc: '불 · 열 · 따뜻함', prims: () => [{ t: 'poly', pts: dropPts(0, 0.2, 0.26), c: 'main' }, { t: 'poly', pts: dropPts(0, 0.28, 0.12), c: 'accent' }] },
  heart: { hue: 'red', desc: '좋아함 · 마음', prims: () => [{ t: 'poly', pts: heartPts(0, 0.02, 0.42), c: 'main' }] },
  star: { hue: 'sun', desc: '별 · 눈에 띔', prims: () => [{ t: 'poly', pts: starPts(0, 0.03, 0.44, 0.19), c: 'main' }] },
  check: { hue: 'leaf', desc: '맞음 · 확인', prims: () => [{ t: 'disc', x: 0, y: 0, r: 0.42, c: 'main' }, { t: 'seg', a: [-0.2, 0.02], b: [-0.05, 0.17], w: 0.09, c: 'cut' }, { t: 'seg', a: [-0.05, 0.17], b: [0.22, -0.15], w: 0.09, c: 'cut' }] },
  cross: { hue: 'red', desc: '아님 · 피할 것', prims: () => [{ t: 'disc', x: 0, y: 0, r: 0.42, c: 'main' }, { t: 'seg', a: [-0.16, -0.16], b: [0.16, 0.16], w: 0.09, c: 'cut' }, { t: 'seg', a: [0.16, -0.16], b: [-0.16, 0.16], w: 0.09, c: 'cut' }] },
  clock: { hue: 'neutral', desc: '시간 · 때 · 기다림', prims: () => [{ t: 'disc', x: 0, y: 0, r: 0.42, c: 'main' }, { t: 'disc', x: 0, y: 0, r: 0.33, c: 'cut' }, { t: 'seg', a: [0, 0], b: [0, -0.22], w: 0.06, c: 'main' }, { t: 'seg', a: [0, 0], b: [0.15, 0.06], w: 0.06, c: 'main' }] },
  cup: { hue: 'warm', desc: '컵 · 마시기 · 차', prims: () => [{ t: 'poly', pts: [[-0.27, -0.12], [0.27, -0.12], [0.22, 0.34], [-0.22, 0.34]], c: 'main' }, { t: 'ring', x: 0.3, y: 0.08, r: 0.1, w: 0.06, c: 'main' }, { t: 'seg', a: [-0.08, -0.22], b: [-0.08, -0.4], w: 0.045, c: 'dark' }, { t: 'seg', a: [0.08, -0.25], b: [0.08, -0.43], w: 0.045, c: 'dark' }] },
  box: { hue: 'neutral', desc: '상자 · 포장 · 택배', prims: () => [{ t: 'poly', pts: [[-0.4, -0.22], [0.4, -0.22], [0.4, 0.38], [-0.4, 0.38]], c: 'main' }, { t: 'poly', pts: [[-0.4, -0.22], [0.4, -0.22], [0.3, -0.38], [-0.3, -0.38]], c: 'dark' }, { t: 'seg', a: [0, -0.3], b: [0, 0.1], w: 0.08, c: 'accent' }] },
  truck: { hue: 'neutral', desc: '배송 · 이동', prims: () => [{ t: 'poly', pts: rrectPts(-0.1, -0.02, 0.56, 0.4, 0.04), c: 'main' }, { t: 'poly', pts: [[0.2, -0.1], [0.36, -0.1], [0.46, 0.04], [0.46, 0.18], [0.2, 0.18]], c: 'main' }, { t: 'poly', pts: [[0.24, -0.06], [0.34, -0.06], [0.4, 0.03], [0.24, 0.03]], c: 'cut' }, { t: 'disc', x: -0.22, y: 0.22, r: 0.09, c: 'dark' }, { t: 'disc', x: 0.3, y: 0.22, r: 0.09, c: 'dark' }] },
};
export const ICON_NAMES = Object.keys(ICONS);

// ── 상품 ──────────────────────────────────────────────────────────────────────
// 용기 · 원물 모양. style.params: product_shape(bottle · tube · jar · box · pouch · fruit · blob), product_fruit(fruit일 때 종류),
// product_body · product_cap · product_band(#hex). 글자 · 로고는 그리지 않는다
export const PRODUCT_SHAPES = ['bottle', 'tube', 'jar', 'box', 'pouch', 'fruit', 'blob'];
export const FRUIT_KINDS = ['apple', 'citrus', 'persimmon', 'pear', 'berry', 'grape'];

export function productPrims(shape, fruit) {
  switch (shape) {
    case 'tube': return [
      { t: 'poly', pts: [[-0.24, 0.3], [0.24, 0.3], [0.27, -0.42], [-0.27, -0.42]], c: 'body' },
      { t: 'poly', pts: [[0.08, 0.3], [0.24, 0.3], [0.27, -0.42], [0.12, -0.42]], c: 'shade' },
      { t: 'poly', pts: [[-0.29, -0.42], [0.29, -0.42], [0.29, -0.5], [-0.29, -0.5]], c: 'band' },
      { t: 'poly', pts: [[-0.24, -0.05], [0.25, -0.05], [0.25, 0.1], [-0.235, 0.1]], c: 'band' },
      { t: 'poly', pts: rrectPts(0, 0.39, 0.3, 0.2, 0.04), c: 'cap' },
    ];
    case 'jar': return [
      { t: 'poly', pts: rrectPts(0, 0.12, 0.8, 0.62, 0.12), c: 'body' },
      { t: 'poly', pts: rrectPts(0.24, 0.12, 0.32, 0.62, 0.12), c: 'shade' },
      { t: 'poly', pts: [[-0.4, 0.02], [0.4, 0.02], [0.4, 0.24], [-0.4, 0.24]], c: 'band' },
      { t: 'poly', pts: rrectPts(0, -0.28, 0.86, 0.2, 0.06), c: 'cap' },
    ];
    case 'box': return [
      { t: 'poly', pts: [[-0.3, -0.42], [0.3, -0.42], [0.3, 0.46], [-0.3, 0.46]], c: 'body' },
      { t: 'poly', pts: [[0.12, -0.42], [0.3, -0.42], [0.3, 0.46], [0.12, 0.46]], c: 'shade' },
      { t: 'poly', pts: [[-0.3, -0.42], [0.3, -0.42], [0.24, -0.5], [-0.24, -0.5]], c: 'cap' },
      { t: 'poly', pts: [[-0.3, 0.02], [0.3, 0.02], [0.3, 0.2], [-0.3, 0.2]], c: 'band' },
    ];
    case 'pouch': return [
      { t: 'poly', pts: [[-0.3, -0.36], [0.3, -0.36], [0.34, 0.36], ...circlePts(0, 0.36, 0.34, 0.1, 12, 0, Math.PI).slice(1)], c: 'body' },
      { t: 'poly', pts: [[0.12, -0.36], [0.3, -0.36], [0.34, 0.36], [0.16, 0.44]], c: 'shade' },
      { t: 'poly', pts: [[-0.3, -0.36], [0.3, -0.36], [0.3, -0.48], [-0.3, -0.48]], c: 'cap' },
      { t: 'poly', pts: [[-0.31, -0.02], [0.32, -0.02], [0.325, 0.16], [-0.315, 0.16]], c: 'band' },
    ];
    case 'fruit': return fruitPrims(fruit);
    case 'blob': return [
      { t: 'poly', pts: circlePts(0, 0.06, 0.4, 0.36, 40), c: 'body' },
      { t: 'poly', pts: farSide(0, 0.06, 0.4, 0.36), c: 'shade' },
      { t: 'disc', x: -0.15, y: -0.08, r: 0.07, c: 'light' },
    ];
    default: return [   // bottle
      { t: 'poly', pts: rrectPts(0, 0.14, 0.5, 0.66, 0.1), c: 'body' },
      { t: 'poly', pts: rrectPts(0.15, 0.14, 0.2, 0.66, 0.1), c: 'shade' },
      { t: 'poly', pts: [[-0.25, -0.12], [0.25, -0.12], [0.12, -0.26], [-0.12, -0.26]], c: 'body' },
      { t: 'poly', pts: [[-0.25, 0.02], [0.25, 0.02], [0.25, 0.26], [-0.25, 0.26]], c: 'band' },
      { t: 'poly', pts: rrectPts(0, -0.37, 0.24, 0.24, 0.04), c: 'cap' },
    ];
  }
}

function fruitPrims(kind) {
  switch (kind) {
    case 'citrus': return [
      { t: 'poly', pts: circlePts(0, 0.06, 0.4, 0.38), c: 'body' }, { t: 'poly', pts: farSide(0, 0.06, 0.4, 0.38), c: 'shade' },
      { t: 'disc', x: 0, y: -0.3, r: 0.035, c: 'cap' }, { t: 'poly', pts: leafPts([0.02, -0.32], [0.3, -0.46], 0.08), c: 'cap' }, { t: 'disc', x: -0.16, y: -0.06, r: 0.06, c: 'light' },
    ];
    case 'persimmon': return [
      { t: 'poly', pts: circlePts(0, 0.1, 0.44, 0.33), c: 'body' }, { t: 'poly', pts: farSide(0, 0.1, 0.44, 0.33), c: 'shade' },
      ...[0, 1, 2, 3].map(i => ({ t: 'poly', pts: leafPts([0, -0.2], [Math.cos(i * Math.PI / 2 + 0.4) * 0.22, -0.2 + Math.sin(i * Math.PI / 2 + 0.4) * 0.08], 0.07), c: 'cap' })),
      { t: 'seg', a: [0, -0.2], b: [0.02, -0.32], w: 0.05, c: 'cap' }, { t: 'disc', x: -0.2, y: 0.0, r: 0.06, c: 'light' },
    ];
    case 'pear': return [
      { t: 'poly', pts: [...circlePts(0, 0.18, 0.34, 0.28, 24, -0.2, Math.PI + 0.2), ...circlePts(0, -0.12, 0.2, 0.22, 20, Math.PI + 0.3, TAU - 0.3)], c: 'body' },
      { t: 'poly', pts: farSide(0, 0.18, 0.34, 0.28, 0.3, 0.9), c: 'shade' },
      { t: 'seg', a: [0, -0.33], b: [0.04, -0.47], w: 0.045, c: 'cap' }, { t: 'poly', pts: leafPts([0.03, -0.42], [0.24, -0.48], 0.06), c: 'cap' },
    ];
    case 'berry': return [
      { t: 'poly', pts: heartPts(0, 0.08, 0.4).map(([x, y]) => [x, -y + 0.16]), c: 'body' },
      ...[[-0.12, 0.0], [0.1, 0.02], [-0.02, 0.14], [0.14, 0.18], [-0.15, 0.2]].map(([x, y]) => ({ t: 'disc', x, y, r: 0.025, c: 'light' })),
      ...[0, 1, 2, 3, 4].map(i => ({ t: 'poly', pts: leafPts([0, -0.24], [Math.cos(Math.PI + i * Math.PI / 4) * 0.22, -0.24 + Math.sin(Math.PI + i * Math.PI / 4) * 0.08], 0.05), c: 'cap' })),
    ];
    case 'grape': return [
      ...[[-0.18, -0.16], [0, -0.18], [0.18, -0.16], [-0.1, 0.02], [0.1, 0.02], [0, 0.2], [-0.2, 0.12], [0.2, 0.12]].map(([x, y], i) => ({ t: 'disc', x, y, r: 0.11, c: i % 3 === 2 ? 'shade' : 'body' })),
      { t: 'seg', a: [0, -0.3], b: [0.04, -0.46], w: 0.045, c: 'cap' }, { t: 'poly', pts: leafPts([0.02, -0.36], [0.3, -0.44], 0.08), c: 'cap' },
    ];
    default: return [   // apple
      { t: 'poly', pts: [...circlePts(-0.17, 0.08, 0.25, 0.34, 20, -Math.PI / 2, Math.PI / 2), ...circlePts(0.17, 0.08, 0.25, 0.34, 20, Math.PI / 2, Math.PI * 1.5)].map(([x, y]) => [x, y]), c: 'body' },
      { t: 'poly', pts: farSide(0.17, 0.08, 0.25, 0.34, 0.4, 1.2), c: 'shade' },
      { t: 'seg', a: [0, -0.24], b: [0.03, -0.42], w: 0.045, c: 'cap' }, { t: 'poly', pts: leafPts([0.03, -0.36], [0.28, -0.44], 0.08), c: 'cap' }, { t: 'disc', x: -0.17, y: -0.04, r: 0.06, c: 'light' },
    ];
  }
}

// 화살표: 가운데 기준 가로 길이 1. dir = right · left · up · down. draw 0~1(자라남)
export function arrowPrims(dir, draw = 1) {
  const rot = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 }[dir] ?? 0, c = Math.cos(rot), s = Math.sin(rot);
  const R = ([x, y]) => [x * c - y * s, x * s + y * c];
  const end = -0.5 + Math.max(0.02, draw);
  const out = [{ t: 'seg', a: R([-0.5, 0]), b: R([end - 0.06, 0]), w: 0.09, c: 'main' }];
  if (draw >= 0.85) out.push({ t: 'seg', a: R([end, 0]), b: R([end - 0.2, -0.17]), w: 0.09, c: 'main' }, { t: 'seg', a: R([end, 0]), b: R([end - 0.2, 0.17]), w: 0.09, c: 'main' });
  return out;
}

// 도형 묶음을 지역 → 세계 좌표로(가운데 x,y, 크기 s px, 좌우 뒤집기 없음)
export function placePrims(prims, x, y, s) {
  const P = ([u, v]) => [x + u * s, y + v * s];
  return prims.map(p => {
    if (p.t === 'disc' || p.t === 'ring') return { ...p, x: x + p.x * s, y: y + p.y * s, r: p.r * s, w: (p.w ?? 0) * s };
    if (p.t === 'seg') return { ...p, a: P(p.a), b: P(p.b), w: p.w * s };
    return { ...p, pts: p.pts.map(P) };
  });
}

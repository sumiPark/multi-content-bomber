// 50년대 플랫 카툰 스타일 모듈(Canvas 2D, WebGL 없음 — GPU 없는 GitHub 러너에서도 빠름).
// 그리기 엔진은 lemo-opuscar styles/midcentury-toon/demo/engine/toon.js 복사본(이 폴더, MIT, Copyright 2026 LemoLab):
// 색 셀이 선에서 몇 px 어긋나 12fps로 떨림, 끊어지는 잉크선, 마른 붓 결, 종이 결 · 비네트.
// 배경은 방을 그리지 않고 색 면 + 바닥 띠 + 지평선(스타일 규칙 §1), 효과는 4각 반짝임 · 별 터짐 · 햇살.
import { PAL, REG, setClock, textures, shape, plane, ink, rect, starPts, sparkle, rays, paperFinish, path } from './toon.js';
import { wipe as wipeT } from '../../transitions.js';
import { clamp, lerp, ss } from '/core/lib.js';
import { shade } from '../../geom.js';

export const META = {
  render_mode: '2d', webgl: false,
  transitions: ['cut', 'wipe', 'match'],   // 원 · 색 블록 와이프 · 컷(디졸브 없음). fade · page-turn은 cut으로 바뀐다
};

export function create(canvas, prod) {
  const Wc = canvas.width, Hc = canvas.height, g = canvas.getContext('2d');
  const PW = prod.size.w, PH = prod.size.h, k = Wc / PW;
  const params = prod.style.params || {};
  textures();
  REG.dx = typeof params.register === 'number' ? params.register : 6; REG.dy = REG.dx * 0.66;
  const brand = prod.brand || {}, pal = brand.palette || [];
  const c = {
    ink: brand.ink || PAL.ink, white: PAL.white, mouth: PAL.coralD, blush: PAL.pink, sky: PAL.blueL, yellow: PAL.mustard, ochre: PAL.mustardD,
    brown: PAL.brown, accent2: PAL.teal, paper: brand.paper || PAL.paper,
    a1: pal[0] || PAL.coral, a2: pal[1] || PAL.mustard, a3: pal[2] || PAL.teal,
  };
  const grain = typeof params.grain === 'number' ? params.grain : 1;
  let s = k;   // 세계 → 화면 배율(카메라 확대 포함)
  const toW = w => (w ?? 6) * 0.62 * Math.pow(s, 0.3) / s;   // 크레용 기준 굵기 → 이 스타일의 얇은 잉크(확대해도 3배로 굵어지지 않게)
  const pen = {
    style: 'midcentury-toon', c,
    lw: R => clamp(3.6 + R * (5 / 3) * 0.034, 4, 7.5),
    part(poly, fo, lo) {
      shape(g, poly, { fill: fo ? fo.col : null, line: lo ? toW(lo.w) : 0, lineColor: (lo && lo.col) || c.ink, seed: (lo && lo.seed) || (fo && fo.seed) || 1, grain: 0.3, breaks: 0.14, alpha: fo && fo.p < 0.6 ? fo.p + 0.3 : 1 });
    },
    line(pts, o = {}) {
      if ((o.draw ?? 1) <= 0) return;
      ink(g, o.closed ? pts : pts, toW(o.w), { color: o.col || c.ink, seed: o.seed || 1, taper: o.taper !== 0, upto: o.draw ?? 1, alpha: Math.min(1, (o.p ?? 1) + 0.2), wob: 0.4 });
    },
    hatch(poly, o = {}) {
      const a = (o.p ?? 1) * (o.draw ?? 1); if (a <= 0.01) return;
      shape(g, poly, { fill: o.col, line: 0, grain: 0.2, seed: o.seed || 1, alpha: Math.min(1, a + 0.1) });
    },
    dab(x, y, r, o = {}) { g.save(); g.globalAlpha = o.p ?? 1; g.fillStyle = o.col || c.ink; g.beginPath(); g.ellipse(x, y, r, r, 0, 0, Math.PI * 2); g.fill(); g.restore(); },
    text(str, x, y, o = {}) {
      const size = o.size || 40, reveal = o.reveal ?? 1; if (reveal <= 0) return;
      g.save(); g.translate(x, y); if (o.rot) g.rotate(o.rot);
      g.font = `${o.weight ?? 700} ${size}px Gaegu`; g.textAlign = o.align || 'center'; g.textBaseline = 'alphabetic';
      const w = g.measureText(str).width, x0 = g.textAlign === 'center' ? -w / 2 : g.textAlign === 'right' ? -w : 0;
      if (reveal < 1) { g.beginPath(); g.rect(x0 - 4, -size * 1.2, w * reveal + 4, size * 1.6); g.clip(); }
      g.fillStyle = c.a2; g.fillText(str, REG.dx * 0.6, REG.dy * 0.6);   // 어긋난 색 판
      g.fillStyle = o.col || c.ink; g.fillText(str, 0, 0);
      g.restore();
    },
  };
  const S = {
    slug: 'midcentury-toon', canvas, drawFps: 12, W: Wc, H: Hc, k, c,
    transitions: META.transitions, defaultBackground: 'plane', sheetBackground: 'plane',
    pen() { return pen; },
    begin({ cam, t }) {
      setClock(t);
      g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
      g.fillStyle = c.paper; g.fillRect(0, 0, Wc, Hc);
      s = cam.zoom * k;
      g.translate(Wc / 2, Hc / 2); if (cam.rot) g.rotate(cam.rot * Math.PI / 180); g.scale(s, s); g.translate(-cam.x * PW, -cam.y * PH);
    },
    setBoil(m) { REG.jit = 1.6 * m; },
    setPage() {},
    end() { paperFinish(g, Wc, Hc, grain); },
    snapshot(dst) { dst.g.setTransform(1, 0, 0, 1, 0, 0); dst.g.clearRect(0, 0, Wc, Hc); dst.g.drawImage(canvas, 0, 0); },
    present(src) { g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.drawImage(src.c, 0, 0); },
    transitionFns: {
      // 색 블록 와이프: 브랜드 색 띠가 왼쪽에서 밀고 지나가며 다음 장면을 드러낸다
      wipe: (gg, A, B, u, W, H) => wipeT(gg, A, B, u, W, H, { band: W * 0.22, color: c.a1 }),
    },
    backgrounds: {
      plane: {
        params: { color: '벽 색(#hex, 기본 브랜드 첫 색의 옅은 톤)', floor: '바닥 높이(0~1, 기본 0.74)', floor_color: '바닥 띠 색(기본 벽 색보다 진하게)', horizon: 'true면 바닥 경계에 끊긴 지평선' },
        draw(S2, p) {
          const wall = p.color || shade(c.a2, 1.55), fy = (typeof p.floor === 'number' ? p.floor : 0.74) * PH, floorC = p.floor_color || shade(wall, 0.86);
          plane(g, rect(-PW, -PH, PW * 3, fy + PH), wall, { grain: 0.18 });
          plane(g, rect(-PW, fy, PW * 3, PH * 2), floorC, { grain: 0.28 });
          if (p.horizon !== false) ink(g, [[-PW * 0.2, fy], [PW * 1.2, fy]], toW(6), { color: c.ink, breaks: 0.35, seed: 41, taper: false, wob: 0.2 });
          return { ground: () => fy };
        },
      },
      sunburst: {
        params: { color: '바탕 색', ray_color: '햇살 색', cx: '햇살 중심 x(0~1)', cy: '햇살 중심 y(0~1)', floor: '바닥 높이(0~1, 기본 0.78)' },
        draw(S2, p, ctx) {
          const base = p.color || c.a2, fy = (typeof p.floor === 'number' ? p.floor : 0.78) * PH;
          plane(g, rect(-PW, -PH, PW * 3, PH * 3), base, { grain: 0.18 });
          rays(g, (p.cx ?? 0.5) * PW, (p.cy ?? 0.4) * PH, 30, PH * 1.6, p.ray_color || shade(base, 1.18), { rot: ctx.t * 0.04, alpha: 0.7 });
          plane(g, rect(-PW, fy, PW * 3, PH * 2), shade(base, 0.85), { grain: 0.28 });
          ink(g, [[-PW * 0.2, fy], [PW * 1.2, fy]], toW(6), { color: c.ink, breaks: 0.35, seed: 42, taper: false, wob: 0.2 });
          return { ground: () => fy };
        },
      },
      dots: {
        params: { color: '바탕 색', dot_color: '물방울 무늬 색', size: '무늬 크기(px, 기본 18)', floor: '바닥 높이(0~1, 기본 0.76)' },
        draw(S2, p) {
          const base = p.color || shade(c.a3, 1.6), fy = (typeof p.floor === 'number' ? p.floor : 0.76) * PH, r = typeof p.size === 'number' ? p.size : 18;
          plane(g, rect(-PW, -PH, PW * 3, PH * 3), base, { grain: 0.18 });
          g.save(); g.fillStyle = p.dot_color || shade(base, 0.9);
          for (let y = -r * 4; y < fy; y += r * 5) for (let x = -r * 4 + ((y / (r * 5)) % 2 ? r * 2.5 : 0); x < PW + r * 4; x += r * 5) { g.beginPath(); g.ellipse(x, y, r, r, 0, 0, Math.PI * 2); g.fill(); }
          g.restore();
          plane(g, rect(-PW, fy, PW * 3, PH * 2), shade(base, 0.82), { grain: 0.28 });
          return { ground: () => fy };
        },
      },
    },
    fx: {
      starburst: {
        layer: 'under', desc: '별 터짐(16각 흰 별이 뒤에서 튀어나옴, 0.25초 오버슈트 뒤 유지 1.5초)',
        draw(S2, f) { if (f.age < 0 || f.age > 1.8) return; const e = clamp(f.age / 0.25), sc = e < 1 ? 1.25 * Math.sin(e * Math.PI / 2) : 1; shape(g, starPts(f.x, f.y, 160 * sc, 16, 0.62, f.q * 0.3), { fill: c.white, line: toW(5), seed: f.seed, grain: 0.15 }); },
      },
      rays: {
        layer: 'under', desc: '햇살(30개 쐐기가 천천히 돎) — 결과 · 제품을 띄울 때',
        draw(S2, f) { if (f.age < 0) return; rays(g, f.x, f.y, 30, 900, shade(c.a2, 1.2), { rot: f.age * 0.15, alpha: 0.55 * clamp(f.age / 0.3) }); },
      },
      wash: {
        layer: 'under', desc: '색 면이 at.y 높이 띠를 왼쪽 → 오른쪽으로 1.8초에 덮음(크레용 수채 대신)',
        draw(S2, f) {
          const u = ss(clamp(f.age / 1.8)), y0 = (f.fy - 0.12) * PH, y1 = (f.fy + 0.125) * PH, x1 = lerp(-PW * 0.1, PW * 1.1, u);
          g.save(); g.globalAlpha = 0.45; g.fillStyle = c.sky; path(g, [[-PW * 0.2, y0], [x1, y0], [x1 + 40, (y0 + y1) / 2], [x1, y1], [-PW * 0.2, y1]]); g.fill(); g.restore();
        },
      },
      sparkle4: {
        layer: 'over', desc: '4각 원자 반짝임(흰색, 0.6초)',
        draw(S2, f) { if (f.age < 0 || f.age > 0.6) return; sparkle(g, f.x, f.y, 34 * Math.sin(Math.PI * f.age / 0.6), { fill: c.white }); },
      },
    },
  };
  return S;
}

// 공용 효과: 스타일 펜으로 그린다. f = { kind, x, y(세계 px), age(효과 시작 뒤 초, 매끈), q(그림 시각) }
// 스타일 전용 효과(크레용 수채 wash, 50년대 starburst 등)는 스타일 모듈의 fx에 있다.
import { clamp } from '/core/lib.js';

export const FX = {
  sparkle: {
    layer: 'over', desc: '반짝 별(노란 별 하나가 2.5초 동안 깜빡임)',
    draw(pen, f) {
      if (f.age < 0 || f.age > 2.5) return;
      const r = 16 * (1 + 0.25 * Math.sin(f.q * 9)), { x, y } = f;
      const pts = []; for (let k = 0; k <= 10; k++) { const a = -Math.PI / 2 + k * Math.PI / 5; const rr = k % 2 ? r * 0.45 : r; pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr]); }
      pen.hatch(pts, { col: pen.c.yellow, p: 1, gap: 3.5, w: 5, over: 1, seed: f.seed });
      pen.line([...pts, pts[1]], { w: 4, col: pen.c.ochre, seed: f.seed + 1 });
    },
  },
  burst: {
    layer: 'over', desc: '번쩍(노란 짧은 선 5개가 방사, 0.2초) — 잡기 · 부딪힘 강조',
    draw(pen, f) {
      if (f.age < 0 || f.age > 0.2) return;
      for (let j = 0; j < 5; j++) { const a = j / 5 * 6.28; pen.line([[f.x + Math.cos(a) * 24, f.y + Math.sin(a) * 24], [f.x + Math.cos(a) * 40, f.y + Math.sin(a) * 40]], { w: 6, col: pen.c.yellow, seed: f.seed + j }); }
    },
  },
  steam: {
    layer: 'over', desc: '김(물결선 3가닥이 0.45초 간격으로 위로 올라가며 사라짐, 약 2.5초)',
    draw(pen, f) {
      for (let j = 0; j < 3; j++) {
        const u = (f.q - j * 0.45) / 1.6; if (u < 0 || u > 1) continue;
        const bx = f.x + (j - 1) * 28, by = f.y - 96 * u;
        const pts = []; for (let i = 0; i <= 8; i++) pts.push([bx + 8.4 * Math.sin(i * 1.3 + j + u * 4), by - i * 9.6]);
        pen.line(pts, { w: 9, col: j === 1 ? pen.c.accent2 : pen.c.sky, p: 0.85 * (1 - clamp((u - 0.65) / 0.35)), seed: f.seed + j, draw: clamp(u / 0.35), wob: 0.4 });
      }
    },
  },
  splash: {
    layer: 'over', desc: '튀는 물(짧은 하늘색 선 6개가 위로 퍼짐, 0.35초) — 착지 · 쏟아짐',
    draw(pen, f) {
      if (f.age < 0 || f.age > 0.35) return;
      for (let j = 0; j < 6; j++) { const a = -Math.PI * (0.15 + 0.7 * j / 5); pen.line([[f.x + Math.cos(a) * 42, f.y - 6 + Math.sin(a) * 24], [f.x + Math.cos(a) * 66, f.y - 6 + Math.sin(a) * 45]], { w: 6, col: pen.c.sky, seed: f.seed + j }); }
    },
  },
  speed: {
    layer: 'over', desc: '속도선(세로 짧은 선 3개, 0.8초) — 빠르게 오르내림',
    draw(pen, f) {
      if (f.age < 0 || f.age > 0.8) return;
      for (let j = 0; j < 3; j++) pen.line([[f.x - 10 + j * 10, f.y - j * 6], [f.x - 10 + j * 10, f.y - 48 - j * 6]], { w: 4.5, col: pen.c.sky, p: 0.9, seed: f.seed + j });
    },
  },
};

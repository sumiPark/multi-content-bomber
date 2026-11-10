// 공용 매개변수 리그: characterSpecSchema의 body(shape · height · head_ratio · colors · features)만으로 캐릭터를 그린다.
// 그리기는 전부 스타일 모듈의 펜(pen)으로 한다 → 같은 캐릭터가 크레용 · 50년대 카툰 어느 스타일에서도 같은 외형 · 비율.
// 동작 풀이(solveAction) · 손 위치(resolveHands) · 얼굴(drawFace) · 팔다리는 계정 전용 module 리그(rig.js)도 가져다 쓴다.
//
// 펜 인터페이스(스타일 모듈이 구현, 좌표는 모두 세계 px):
//   pen.part(poly, fill|null, line|null, {occ, kn})  닫힌 부품. 먼저 그린 같은 캐릭터 부품을 가린다(occ), 뒤 배경을 비운다(kn)
//   pen.line(pts, {w, col, seed, p, taper, streak, draw, boil, closed})
//   pen.hatch(poly, {col, seed, p, draw, ...})       윤곽선 없는 칠(볼 · 그늘)
//   pen.dab(x, y, r, {col, seed, p})                  작은 점(눈동자 하이라이트)
//   pen.text(str, x, y, {size, col, seed, reveal, weight, align})
//   pen.lw(R) → 이 크기 캐릭터의 기본 선 굵기,  pen.c → 이름 붙은 색(ink, white, mouth, blush, sky ...)
// 지역 좌표: 단위 R, 원점 = 발 아래 가운데, 위쪽이 음수. 오른쪽(+x)이 "보는 쪽"이고 왼쪽 보기는 flip으로 뒤집는다.
import { clamp, ss } from '/core/lib.js';
import { ellipse, handCircle, smooth, tube, curve, TR, toLocal, lerp2, elbow, reach, shade } from './geom.js';

export const SHAPES = ['drop', 'blob', 'bottle', 'fruit', 'human', 'animal'];
export const EXPRESSIONS = ['neutral', 'happy', 'surprised', 'worried', 'determined', 'sad', 'talk', 'calm'];
export const VIEWS = ['front', 'q', 'side'];
const tw = (t, per) => Math.floor(Math.max(0, t) / per + 1e-6) % 2;   // 두 장 교대(대치 동작)

// ——— 동작 풀이: 몸(눌림 · 기울기 · 뜀) + 팔 자세 이름 + 발 ———
// p: 엔진 배우 상태(action, at, moveU, info, rank ...), A: 해부(hopH, jumpH: 뛰는 높이 R 단위)
export function moveState(p) {
  if (p.moveU == null) return { st: 'none', age: p.at };
  const w = p.info && Array.isArray(p.info.move) ? p.info.move : [0, p.sceneDur];
  if (p.moveU <= 0) return { st: 'before', age: p.at };
  if (p.moveU < 1) return { st: 'during', age: p.at - w[0] };
  return { st: 'after', age: p.at - w[1] };
}
export function solveAction(p, A = {}) {
  const at = Math.max(0, p.at), hopH = A.hopH ?? 1.6, jumpH = A.jumpH ?? 2.2;
  const b = { sq: 1, rot: 0, dy: 0, dx: 0, scaleK: 1, lift: [0, 0], spread: 0, arms: 'down', expr: null };
  const ms = moveState(p);
  const landed = (age, after = 'down') => {   // 착지: 찌그러짐 → 살짝 튐 → 섬
    if (age < 0.1) { b.sq = 0.68; b.arms = 'rest'; } else if (age < 0.27) { b.sq = 1.12; b.dy = 0.2; b.arms = 'up'; } else b.arms = after;
  };
  switch (p.action) {
    case 'walk': { const s = tw(at, 0.25); b.lift = s ? [0.18, 0] : [0, 0.18]; b.dy = s ? 0.05 : 0; b.rot = 0.05; b.arms = s ? 'swingA' : 'swingB'; break; }
    case 'hop':
      if (ms.st !== 'none') { if (ms.st === 'before') { b.sq = 0.86; b.arms = 'rest'; } else if (ms.st === 'during') { b.sq = 1.08; b.arms = 'up'; b.spread = 0.06; } else if (ms.age < 0.12) { b.sq = 0.72; b.arms = 'rest'; } else { b.sq = 0.92; b.arms = 'rest'; } break; }
      if (at < 0.2) { b.sq = at > 0.05 ? 0.86 : 1; b.arms = 'rest'; }
      else if (at < 0.7) { const u = (at - 0.2) / 0.5; b.dy = hopH * Math.sin(Math.PI * u); b.sq = u < 0.25 ? 1.1 : 1; b.arms = 'up'; b.spread = 0.06; }
      else if (at < 0.85) { b.sq = 0.72; b.arms = 'rest'; }
      else { b.sq = 0.92; b.arms = 'rest'; }
      break;
    case 'wave': b.arms = tw(at, 1 / 3) ? 'wave' : 'wave2'; b.rot = -0.02; break;
    case 'point': b.arms = 'point'; b.rot = 0.03; break;
    case 'nod': { const ph = (at % 0.8) / 0.8; if (ph < 0.35) { b.sq = 0.9; b.rot = 0.07; b.expr = 'calm'; } break; }
    case 'bow': { const u = at - (p.rank || 0) * ((p.info && p.info.stagger) || 0.42); if (u >= 0 && u < 0.36) { b.sq = 0.86; b.rot = (p.rank || 0) % 2 ? 0.1 : -0.1; b.expr = 'calm'; } break; }
    case 'shake': b.rot = tw(at, 0.17) ? 0.09 : -0.09; b.arms = 'rest'; break;
    case 'jump':
      if (ms.st !== 'none') { if (ms.st === 'during') { b.arms = 'up'; b.sq = 1.1; b.spread = 0.08; } else if (ms.st === 'after') landed(ms.age, 'down'); else { b.sq = 0.82; b.arms = 'rest'; } break; }
      if (at < 0.15) { b.sq = 0.8; b.arms = 'rest'; }
      else if (at < 0.6) { const u = (at - 0.15) / 0.45; b.dy = jumpH * Math.sin(Math.PI * u); b.sq = 1.12; b.arms = 'up'; b.spread = 0.08; }
      else if (at < 0.72) { b.sq = 0.75; b.arms = 'up2'; }
      else b.arms = 'up';
      break;
    case 'hug': b.arms = p.partners && p.partners.target ? 'down' : 'hug'; b.rot = tw(at, 0.5) ? 0.07 : -0.07; break;   // 상대가 있으면 한 팔만 감싸고 다른 팔은 내림
    case 'push': b.rot = 0.16; b.arms = 'push'; b.dx = tw(at, 0.1) ? 0.03 : 0; b.spread = 0.1; b.lift = [0, 0.04]; break;
    case 'lift': b.arms = 'lift'; b.sq = tw(at, 0.3) ? 0.95 : 0.98; b.spread = 0.08; break;
    case 'shrink': b.scaleK = 1 - 0.35 * ss(at / 0.6); b.arms = 'self'; b.sq = 0.95; break;
    case 'cheer': b.arms = tw(at, 0.25) ? 'up' : 'up2'; b.dy = 0.35 * hopH / 1.6 * Math.abs(Math.sin(Math.PI * at / 0.5)); break;
    case 'fall':
      if (ms.st === 'after') landed(ms.age, 'down');
      else { b.arms = 'up'; b.spread = 0.08; }
      break;
    case 'float': b.arms = tw(at, 1 / 6) ? 'up' : 'up2'; b.spread = 0.08; b.rot = 0.06 * Math.sin(at * 5); break;
    case 'pulled':
      if (ms.st === 'after') { landed(ms.age, 'down'); b.arms = ms.age < 0.1 ? 'rest' : 'down'; }
      else { b.arms = tw(at, 1 / 6) ? 'up' : 'up2'; b.spread = 0.08; }
      break;
    case 'pull': b.arms = 'down'; b.rot = at > 0.5 && at < 1.5 ? -0.05 : 0; break;
    case 'link': b.arms = 'down'; break;
    case 'sit': b.sq = 0.9; b.arms = 'rest'; break;
    default: b.sq = 1 + 0.022 * Math.sin(at * 2 * Math.PI / 1.8); b.arms = 'down';   // idle
  }
  return b;
}

// 팔 자세 이름 → 지역 손 위치 [[왼손], [오른손]]. sh: 어깨, top: 머리 꼭대기 y, al: 팔 길이 단위
export function armPreset(name, sh, top, al = 1, human = false) {
  const [L, Rr] = sh, m = (s, ox, oy) => [s[0] + ox * al, s[1] + oy * al], mL = (ox, oy) => m(L, -ox, oy), mR = (ox, oy) => m(Rr, ox, oy);
  const shx = Rr[0], shy = Rr[1];
  if (human) switch (name) {   // 사람: 팔이 길고 두 마디라 손이 허리 · 머리 위까지 간다
    case 'rest': return [mL(0.22, 0.85), mR(0.22, 0.85)];
    case 'wave': return [mL(0.12, 0.92), mR(0.42, -0.82)];
    case 'wave2': return [mL(0.12, 0.92), mR(0.72, -0.58)];
    case 'up': return [mL(0.25, -0.95), mR(0.25, -0.95)];
    case 'up2': return [mL(0.5, -0.82), mR(0.5, -0.82)];
    case 'hold': return [mL(0.95, 0.05), mR(0.95, 0.05)];
    case 'hug': return [[0.5 * shx, shy + 0.45 * al], [-0.5 * shx, shy + 0.5 * al]];
    case 'self': return [[0.4 * shx, shy + 0.35 * al], [-0.4 * shx, shy + 0.42 * al]];
    case 'point': return [mL(0.15, 0.9), mR(0.98, -0.12)];
    case 'push': return [[shx * 0.6 + 0.78 * al, shy + 0.12 * al], mR(0.9, 0.1)];
    case 'lift': return [[-0.3 * shx, top - 0.18 * al], [0.3 * shx, top - 0.18 * al]];
    case 'swingA': return [mL(-0.25, 0.88), mR(0.35, 0.85)];
    case 'swingB': return [mL(0.35, 0.85), mR(-0.25, 0.88)];
    default: return [mL(0.12, 0.95), mR(0.12, 0.95)];   // down
  }
  switch (name) {
    case 'rest': return [mL(0.22, 0.53), mR(0.22, 0.53)];
    case 'wave': return [mL(0.32, 0.33), mR(0.46, -1.0)];
    case 'wave2': return [mL(0.32, 0.33), mR(0.76, -0.67)];
    case 'up': return [mL(0.44, -1.1), mR(0.44, -1.1)];
    case 'up2': return [mL(0.59, -0.9), mR(0.59, -0.9)];
    case 'hold': return [mL(0.69, 0), mR(0.69, 0)];
    case 'hug': return [[0.64 * shx, shy], [-0.64 * shx, shy + 0.05 * al]];
    case 'self': return [[0.5 * shx, shy + 0.15 * al], [-0.5 * shx, shy + 0.2 * al]];
    case 'point': return [mL(0.22, 0.53), mR(0.95, -0.25)];
    case 'push': return [[shx * 0.55 + 0.62 * al, shy + 0.3 * al], mR(0.8, 0.25)];   // 얼굴을 가리지 않게 가슴 아래 높이
    case 'lift': return [[-0.42 * shx, top - 0.22 * al], [0.42 * shx, top - 0.22 * al]];
    case 'swingA': return [mL(0.05, 0.45), mR(0.42, 0.25)];
    case 'swingB': return [mL(0.42, 0.25), mR(0.05, 0.45)];
    default: return [mL(0.32, 0.33), mR(0.32, 0.33)];   // down
  }
}

// 상대가 있는 동작(point · hug · pull · pulled · link)의 손 목표를 세계 좌표로 풀고 지역 좌표로 바꾼다
// o: TR 변환 인자, R: 단위, hands: 기본 손 위치(지역). 돌려주는 값도 지역 좌표
export function resolveHands(p, hands, o, R, A = {}) {
  const out = [hands[0], hands[1]], at = Math.max(0, p.at), T = p.partners || {};
  const loc = w => toLocal(o, R, w);
  const sideOf = w => (loc(w)[0] >= 0 ? 1 : 0);   // 목표가 지역 +x 쪽이면 오른팔(1)
  const blend = (i, w, k) => { const l = loc(w); out[i] = lerp2(hands[i], l, clamp(k)); };
  if (p.action === 'point' && p.lookAt) { const i = sideOf(p.lookAt), s = (A.sh || [[-0.86, -0.95], [0.86, -0.95]])[i], l = loc(p.lookAt), d = Math.hypot(l[0] - s[0], l[1] - s[1]) || 1, rr = Math.min(d, (A.al ?? 1) * 1.15); out[i] = [s[0] + (l[0] - s[0]) / d * rr, s[1] + (l[1] - s[1]) / d * rr]; }
  if (p.action === 'hug' && T.target) {
    const t = T.target, dirW = Math.sign(t.x - p.x) || 1, i = sideOf([t.x, t.y]);
    out[i] = loc([t.x + dirW * t.hw * 0.55, t.y - t.height * 0.45]);   // 상대 몸 너머로 감싼다
  }
  if ((p.action === 'pull' && T.target) || p.action === 'pulled') {
    const g = grabPoint(p, T.target);
    if (g) {
      const i = sideOf(g);
      if (p.action === 'pull') blend(i, g, at < 0.05 ? 0 : (at - 0.05) / 0.45);
      else if (at >= 0.5) out[i] = loc(g);
    }
  }
  if (p.action === 'link') {
    const k = ss((at - 0.2) / 0.35);
    const gap = (a, b) => [((a.x + a.hw) + (b.x - b.hw)) / 2, Math.min(a.y, b.y) - 0.42 * Math.min(a.height, b.height)];
    const me = { x: p.x, y: p.y, height: p.height, hw: p.height * (A.hwK ?? 0.4) };
    if (T.left) blend(p.flip ? 1 : 0, gap(T.left, me), k);
    if (T.right) blend(p.flip ? 0 : 1, gap(me, T.right), k);
  }
  return out;
}
// 끌어 내리기에서 두 손이 만나는 점: 끌려 내려오는 쪽(pulled) 몸 옆, 키의 2/3 높이
function grabPoint(p, target) {
  const pulled = p.action === 'pulled' ? p : target; if (!pulled) return null;
  const other = p.action === 'pulled' ? (p.partners && p.partners.target) : p;
  const dir = other ? Math.sign(other.x - pulled.x) || 1 : 1;
  return [pulled.x + dir * 0.52 * pulled.height, pulled.y - 0.67 * pulled.height];
}

// ——— 얼굴 ———
// F = [눈 y, 입 y, 볼 y, 눈 x 간격, 볼 x 간격] (지역 R 단위), fs = 얼굴 크기 배율
export function drawFace(pen, P, f) {
  const { R, seed: sd, F, fs = 1, view = 'front', colors = {} } = f;
  let ex = f.expr || 'neutral'; if (ex === 'smile') ex = 'neutral';
  const lw = pen.lw(R), look = f.look || [0, 0];
  const [ey, my, cy, eX0, cX0] = F;
  const shift = view === 'q' ? 0.16 * fs : view === 'side' ? 0.42 * fs : 0;
  const eyes = view === 'side' ? [[eX0 * 0.6 + shift, 1]] : [[-eX0 + shift, view === 'q' ? 0.82 : 1], [eX0 + shift, 1]];
  const eyeR = (ex === 'surprised' ? 0.135 : 0.11) * fs * (f.eyeK || 1);
  const ink = colors.line || pen.c.ink, mouthC = pen.c.mouth;
  const blink = f.blink;
  eyes.forEach(([x, kx], i) => {
    if (ex === 'happy' || ex === 'calm' || blink) {   // 웃는 눈(^) · 편한 눈(︶)
      const up = ex === 'happy' ? -1 : 1, w = 0.12 * fs * kx;
      pen.line(P([[x - w, ey + 0.02 * fs * -up], [x - w * 0.4, ey - 0.07 * fs * -up], [x + w * 0.4, ey - 0.07 * fs * -up], [x + w, ey + 0.02 * fs * -up]]), { w: lw * 0.85, seed: sd + 1 + i, taper: 0.3, col: ink });
      return;
    }
    const lk = ex === 'sad' ? [look[0] * 0.5, Math.max(0.6, look[1])] : look;
    const px = x + lk[0] * 0.05 * fs, py = ey + lk[1] * 0.05 * fs;
    const ry = ex === 'determined' ? eyeR * 0.85 : eyeR * 1.15;
    pen.part(P(ellipse(px, py, eyeR * 0.85 * kx, ry, 16)), { col: ink, p: 1, gap: 3, w: 5, over: 0.5, seed: sd + 3 + i, ang: 1.2 }, null, { occ: false, kn: false });
    const hl = P([[px + 0.035 * fs, py - 0.05 * fs]])[0];
    pen.dab(hl[0], hl[1], Math.max(2.2, R * 0.032 * fs), { col: pen.c.white, p: 1, seed: sd + 5 + i });
    const inner = (view === 'side' || i === 1) ? -1 : 1;   // 눈썹 안쪽 방향
    const bw = 0.12 * fs * kx;
    if (ex === 'worried' || ex === 'sad') line2(i ? [[x - bw, ey - 0.27 * fs], [x + bw, ey - 0.2 * fs]] : [[x - bw, ey - 0.2 * fs], [x + bw, ey - 0.27 * fs]], sd + 7 + i);   // 안쪽이 올라감
    if (ex === 'determined') line2(inner > 0 ? [[x - bw, ey - 0.27 * fs], [x + bw, ey - 0.18 * fs]] : [[x - bw, ey - 0.18 * fs], [x + bw, ey - 0.27 * fs]], sd + 7 + i);   // 안쪽이 내려감(V)
    if (ex === 'surprised') line2([[x - bw, ey - 0.27 * fs], [x, ey - 0.33 * fs], [x + bw, ey - 0.27 * fs]], sd + 7 + i);
  });
  function line2(pts, s) { pen.line(P(pts), { w: lw * 0.7, seed: s, col: ink }); }
  // 볼(분홍 낙서)
  const ck = f.cheeks ?? 0;
  if (ck > 0 && colors.cheek !== null) {
    const cxs = view === 'side' ? [cX0 * 0.55 + shift] : [-cX0 + shift, cX0 + shift];
    cxs.forEach((x, i) => pen.hatch(P(handCircle(x, cy, 0.12 * fs, sd + 9 + i, 0, 18)), { col: colors.cheek || pen.c.blush, p: 0.85, gap: 4, w: 6, over: 1.5, seed: sd + 11 + i, ang: 0.4, draw: ck }));
  }
  // 입
  const mx = view === 'side' ? 0.62 * fs : shift * 0.9, M = pts => P(pts.map(([u, v]) => [u * fs + mx, v * fs + my]));
  const mp = { occ: false, kn: false };
  if (ex === 'surprised') pen.part(M(ellipse(0, 0.03, 0.085, 0.11, 16)), { col: mouthC, p: 0.85, gap: 3, w: 4, over: 0.5, seed: sd + 13 }, { w: lw * 0.75, seed: sd + 14, col: ink }, mp);
  else if (ex === 'happy') pen.part(M([[-0.16, -0.03], [-0.08, 0.09], [0.08, 0.09], [0.16, -0.03]]), { col: mouthC, p: 0.8, gap: 3, w: 4, over: 0.5, seed: sd + 15 }, { w: lw * 0.75, seed: sd + 16, col: ink }, mp);
  else if (ex === 'worried') pen.line(M([[-0.1, 0.03], [-0.03, -0.01], [0.03, 0.02], [0.1, -0.01]]), { w: lw * 0.75, seed: sd + 17, col: ink });
  else if (ex === 'sad') pen.line(M([[-0.11, 0.05], [0, -0.02], [0.11, 0.05]]), { w: lw * 0.8, seed: sd + 19, col: ink });
  else if (ex === 'determined') pen.line(M([[-0.11, 0.0], [0.11, -0.025]]), { w: lw * 0.85, seed: sd + 20, col: ink });
  else if (ex === 'talk') {
    if (tw(f.at ?? 0, 1 / 6)) pen.part(M(ellipse(0, 0.02, 0.09, 0.075, 14)), { col: mouthC, p: 0.85, gap: 3, w: 4, over: 0.5, seed: sd + 21 }, { w: lw * 0.75, seed: sd + 22, col: ink }, mp);
    else pen.line(M([[-0.1, -0.01], [0, 0.04], [0.1, -0.01]]), { w: lw * 0.8, seed: sd + 23, col: ink });
  }
  else if (ex === 'calm') pen.line(M([[-0.08, 0.0], [0, 0.04], [0.08, 0.0]]), { w: lw * 0.75, seed: sd + 24, col: ink });
  else pen.line(M([[-0.1, -0.01], [0, 0.05], [0.1, -0.01]]), { w: lw * 0.8, seed: sd + 18, col: ink });   // neutral
  if (ex === 'sad' && view !== 'side') { const tp = P([[-eX0 + shift - 0.02, ey + 0.2 * fs]])[0]; pen.dab(tp[0], tp[1], Math.max(2.5, R * 0.05 * fs), { col: pen.c.sky, p: 0.9, seed: sd + 25 }); }   // 눈물 한 방울
}
// 볼 칠하기 정도: 장면 중 happy로 바뀌면 0.6초 동안 칠해진다(색칠이 곧 연기), 그 밖엔 늘 칠해져 있다
export function cheekAmount(p, colors) {
  if (!colors || colors.cheek === null) return 0;
  const ex = p.expr;
  if (ex === 'sad' || ex === 'determined') return 0;
  if ((ex === 'happy' || ex === 'calm') && p.actor && p.actor.expr_to === ex && p.exprAge < 0.6) return clamp(p.exprAge / 0.6);
  return 1;
}

// 몸 칠 기본값(크레용 스타일은 빗금 간격을 쓰고, 다른 스타일은 색만 쓴다)
export function bodyFill(col, seed, small = false, ang = 0.6) {
  return { col, p: 0.82, gap: small ? 7 : 10, w: small ? 9 : 12, ang, seed, over: small ? 2 : 4, cross: !small, crossP: 0.45 };
}
// 관 모양 팔(어깨 → 손) + 벙어리장갑 손. 두 마디(human)면 팔꿈치를 굽힌다
export function drawArm(pen, P, sh, hand, o) {
  const { R, fillO, lw, seed, width = 0.24, handR = 0.16, jointed = false, al = 1, bend = 1, handCol } = o;
  void R;
  let mid;
  if (jointed) { hand = reach(sh, hand, al * 1.15); mid = elbow(sh, hand, al * 1.15, bend); }   // 두 마디 팔은 늘어나지 않는다
  else mid = [(sh[0] + hand[0]) / 2 + (hand[0] > sh[0] ? 0.05 : -0.05), (sh[1] + hand[1]) / 2 - 0.05];
  pen.part(P(tube(curve([sh, mid, hand], 4), width)), fillO, { w: lw * 0.9, seed, col: o.lineCol });
  pen.part(P(handCircle(hand[0], hand[1], handR, seed + 2, 0, 16)), handCol ? { ...fillO, col: handCol } : fillO, { w: lw * 0.85, seed: seed + 4, col: o.lineCol });
}

// ——— 모양별 해부(지역 R 단위) ———
const DROP = [[0, -2.75], [0.2, -2.42], [0.45, -2.02], [0.72, -1.58], [0.93, -1.12], [1.0, -0.72], [0.9, -0.42], [0.58, -0.27], [0, -0.24], [-0.58, -0.27], [-0.9, -0.42], [-1.0, -0.72], [-0.93, -1.12], [-0.72, -1.58], [-0.45, -2.02], [-0.2, -2.42]];
function anatomy(spec) {
  const b = spec.body, f = b.features || {}, hr = clamp(b.head_ratio || 0.35, 0.15, 0.7);
  switch (b.shape) {
    case 'drop': return { units: 2.8, sh: [[-0.86, -0.95], [0.86, -0.95]], top: -2.75, F: [-1.12, -0.8, -0.9, 0.34, 0.6], fs: 1, feet: 0.32, hwK: 0.36, hopH: 1.9, jumpH: 2.4 };
    case 'blob': return { units: 2.05, sh: [[-0.92, -1.0], [0.92, -1.0]], top: -1.95, F: [-1.08, -0.78, -0.86, 0.34, 0.62], fs: 1, feet: 0.38, hwK: 0.5, hopH: 1.4, jumpH: 1.9 };
    case 'fruit': return { units: 2.3, sh: [[-0.95, -1.0], [0.95, -1.0]], top: -2.0, F: [-1.18, -0.84, -0.94, 0.34, 0.62], fs: 1, feet: 0.38, hwK: 0.44, hopH: 1.5, jumpH: 2.0 };
    case 'bottle': return { units: 2.8, sh: [[-0.8, -1.45], [0.8, -1.45]], top: -2.75, F: [-1.85, -1.58, -1.66, 0.3, 0.52], fs: 0.95, feet: 0.4, hwK: 0.3, hopH: 1.4, jumpH: 2.0 };
    case 'animal': {
      const headR = clamp(hr * 3.2 / 2, 0.75, 1.25), cy = -3.2 + headR + (f.ears && f.ears !== 'none' ? 0.15 : 0);
      return { units: 3.2, human: false, animal: true, headR, cy, sh: [[-0.62, -1.45], [0.62, -1.45]], top: cy - headR, F: [cy + 0.02 * headR, cy + 0.5 * headR, cy + 0.36 * headR, 0.38 * headR, 0.66 * headR], fs: headR / 1.0, feet: 0.32, hwK: 0.3, hopH: 1.6, jumpH: 2.2, al: 0.85 };
    }
    default: {   // human
      const headR = clamp(hr * 4.0 / 2, 0.45, 1.3), cy = -4.0 + headR, neck = cy + headR * 0.92, hip = neck + (0 - neck) * 0.45;
      const shx = Math.max(0.5, headR * 0.82);
      return { units: 4.0, human: true, headR, cy, neck, hip, shx, sh: [[-shx * 0.95, neck + 0.18], [shx * 0.95, neck + 0.18]], top: cy - headR, F: [cy + 0.05 * headR, cy + 0.48 * headR, cy + 0.34 * headR, 0.36 * headR, 0.62 * headR], fs: headR / 0.95, feet: 0.24, hwK: 0.2, hopH: 1.4, jumpH: 2.0, al: (hip - neck) * 1.25 };
    }
  }
}
export function halfWidth(spec) { return anatomy(spec).hwK; }
export const ANATOMY = anatomy;

// ——— 그리기 ———
// pose: 엔진 배우 상태(x, y, height, flip, view, expr, exprAge, look, lookAt, action, at, partners ...)
export function draw(pen, pose, spec) {
  const A = anatomy(spec), body = spec.body, C = body.colors, f = body.features || {};
  const R0 = pose.height / A.units, sd = (pose.seed || 1) % 997 + 100;
  const b = solveAction(pose, A);
  const R = R0 * b.scaleK;
  const o = { x: pose.x + b.dx * R * (pose.flip ? -1 : 1), y: pose.y, sq: b.sq, r: b.rot * (pose.flip ? -1 : 1), flip: pose.flip, lift: b.dy * R };
  const P = TR(o, R), lw = pen.lw(R), small = R < 40;
  const fillO = bodyFill(C.body, sd + 1, small);
  const lineO = { w: lw, seed: sd + 2, col: C.line };
  const view = pose.view || 'front';
  let hands = armPreset(b.arms, A.sh, A.top, A.al ?? 1, !!A.human);
  hands = resolveHands(pose, hands, o, R, A);
  const look = pose.look ? [pose.look[0] * (pose.flip ? -1 : 1), pose.look[1]] : [0, 0];
  const expr = b.expr || pose.expr;
  const face = { R, seed: sd + 50, F: A.F, fs: A.fs, view, look, expr, at: pose.at, colors: C, cheeks: cheekAmount({ ...pose, expr }, C) };
  const armO = (i, extra = {}) => ({ R, fillO, lw, seed: sd + 30 + i * 6, lineCol: C.line, al: A.al ?? 1, ...extra });
  // 팔 순서: 몸 뒤로 가는 팔(q 보기의 먼 팔)은 몸보다 먼저
  const backArm = view === 'front' ? -1 : 0;
  const shape = body.shape;
  if (shape === 'human') return drawHuman(pen, P, pose, spec, A, b, R, hands, face, armO, lw, sd, view);
  if (shape === 'animal') return drawAnimal(pen, P, pose, spec, A, b, R, hands, face, armO, lw, sd, view);
  // 발
  const legs = shape !== 'bottle';
  [-1, 1].forEach((k, i) => {
    const fx = k * (A.feet + b.spread), fy = -0.06 - b.lift[i];
    if (legs) pen.part(P(tube(curve([[k * A.feet * 0.95, -0.36], [fx, -0.18 - b.lift[i] * 0.5], [fx + k * 0.02, fy]], 4), 0.24)), fillO, lineO);
    pen.part(P(ellipse(fx + k * 0.06, fy + 0.01, 0.2, 0.1, 16)), shape === 'bottle' ? { ...fillO, col: C.accent } : fillO, { ...lineO, seed: sd + 22 + i });
  });
  if (backArm === 0) drawArm(pen, P, A.sh[0], hands[0], armO(0));
  // 몸
  const poly = bodyPoly(shape, f);
  pen.part(P(poly), shape === 'bottle' ? bodyFill(C.body, sd + 1, small, 0.45) : fillO, lineO);
  // 모양별 장식
  if (shape === 'drop') {
    pen.line(P([[-0.42, -2.0], [-0.6, -1.66], [-0.7, -1.3]]), { w: lw * 1.7, col: pen.c.white, p: 1, seed: sd + 3, taper: 0.4, streak: 0 });
    const d = P([[-0.52, -1.05]])[0]; pen.dab(d[0], d[1], R * 0.05, { col: pen.c.white, p: 1, seed: sd + 4 });
  } else if (shape === 'blob') {
    pen.line(P([[-0.62, -1.42], [-0.72, -1.15]]), { w: lw * 1.5, col: pen.c.white, p: 1, seed: sd + 4, taper: 0.4, streak: 0 });
    if (f.sprout !== false) pen.line(P(curve([[0, -1.9], [0.06, -2.12], [0.22, -2.16], [0.2, -2.02], [0.1, -2.06]], 4)), { w: lw, seed: sd + 3, col: C.line });
  } else if (shape === 'fruit') fruitDetails(pen, P, f, C, lw, sd);
  else if (shape === 'bottle') bottleDetails(pen, P, f, C, lw, sd, R);
  drawFace(pen, P, face);
  if (backArm === 0) drawArm(pen, P, A.sh[1], hands[1], armO(1));
  else { drawArm(pen, P, A.sh[0], hands[0], armO(0)); drawArm(pen, P, A.sh[1], hands[1], armO(1)); }
}

function bodyPoly(shape, f) {
  if (shape === 'drop') return smooth(DROP, 6);
  if (shape === 'bottle') return smooth([[-0.78, -0.12], [-0.8, -0.9], [-0.8, -1.7], [-0.68, -2.02], [-0.45, -2.2], [0.45, -2.2], [0.68, -2.02], [0.8, -1.7], [0.8, -0.9], [0.78, -0.12], [0, -0.08]], 5);
  if (shape === 'fruit') {
    const kind = f.kind || 'apple', out = [];
    for (let i = 0; i <= 56; i++) {
      const a = i / 56 * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      let rx = 1.0, ry = 0.92, y0 = -1.05;
      if (kind === 'apple') { const dip = Math.exp(-Math.pow((a - Math.PI * 1.5) / 0.35, 2)) * 0.16; ry -= dip; rx *= 1 + 0.04 * Math.sin(a * 2); }
      if (kind === 'berry') { rx = s < 0 ? 1.02 : 1.0 - 0.45 * s; ry = s < 0 ? 0.8 : 1.05; }
      if (kind === 'pear') { rx = s < 0 ? 0.68 + 0.3 * (1 + s) : 1.0; ry = s < 0 ? 1.2 : 0.85; y0 = -0.95; }
      out.push([c * rx, y0 + s * ry]);
    }
    return out;
  }
  // blob: 살짝 찌그러진 동그라미
  const out = []; for (let i = 0; i <= 48; i++) { const a = i / 48 * Math.PI * 2; const rr = 1 + 0.04 * Math.sin(a * 3 + 1.3) + 0.03 * Math.sin(a * 5 + 0.7); out.push([Math.cos(a) * rr, -1.0 + Math.sin(a) * rr * 0.92]); }
  return out;
}
function fruitDetails(pen, P, f, C, lw, sd) {
  const kind = f.kind || 'apple', top = kind === 'pear' ? -2.15 : kind === 'berry' ? -1.85 : -1.86;
  if (kind === 'berry') {   // 씨앗 점 + 꼭지 잎 왕관
    for (let i = 0; i < 9; i++) { const x = -0.6 + (i % 3) * 0.6 + (Math.floor(i / 3) % 2) * 0.3 - 0.15, y = -1.45 + Math.floor(i / 3) * 0.38; const d = P([[x * (1 - Math.floor(i / 3) * 0.25), y]])[0]; pen.dab(d[0], d[1], lw * 0.55, { col: f.seed_color || pen.c.yellow, p: 1, seed: sd + 60 + i }); }
    const leaf = []; for (let k = 0; k < 5; k++) { const a = -Math.PI / 2 + (k - 2) * 0.55; leaf.push([Math.cos(a) * 0.15, top + 0.05 + Math.sin(a) * 0.15], [Math.cos(a) * 0.55, top + 0.12 + Math.sin(a) * 0.3]); }
    pen.part(P(leaf), { col: f.leaf || '#6a9a3a', p: 0.9, gap: 6, w: 8, seed: sd + 70 }, { w: lw * 0.8, seed: sd + 71, col: C.line });
    return;
  }
  pen.line(P([[0.02, top + 0.12], [0.06, top - 0.1], [0.12, top - 0.22]]), { w: lw * 1.2, col: f.stem || pen.c.brown, seed: sd + 72 });
  if (f.leaf !== false) pen.part(P(smooth([[0.1, top - 0.12], [0.35, top - 0.32], [0.62, top - 0.22], [0.4, top - 0.04]], 6)), { col: typeof f.leaf === 'string' ? f.leaf : '#6a9a3a', p: 0.9, gap: 6, w: 8, seed: sd + 73 }, { w: lw * 0.8, seed: sd + 74, col: C.line });
  if (kind === 'citrus') for (let i = 0; i < 6; i++) { const d = P([[-0.55 + i * 0.22, -0.55 - (i % 2) * 0.25]])[0]; pen.dab(d[0], d[1], lw * 0.35, { col: shade(C.body, 0.8), p: 0.8, seed: sd + 80 + i }); }
  pen.line(P([[-0.6, -1.5], [-0.72, -1.2]]), { w: lw * 1.5, col: pen.c.white, p: 1, seed: sd + 75, taper: 0.4, streak: 0 });
}
function bottleDetails(pen, P, f, C, lw, sd, R) {
  // 목 + 뚜껑
  pen.part(P([[-0.45, -2.32], [0.45, -2.32], [0.45, -2.18], [-0.45, -2.18]]), { col: C.body, p: 0.95, gap: 4, w: 6, seed: sd + 90 }, { w: lw * 0.8, seed: sd + 91, col: C.line });
  const capOpen = f.cap_open ? 1 : 0, hx = 0.48, hy = -2.32, a = -2.1 * capOpen;
  const cap = [[-0.48, -2.32], [-0.46, -2.75], [0.46, -2.75], [0.48, -2.32]].map(([u, v]) => { const du = u - hx, dv = v - hy; return [hx + du * Math.cos(a) - dv * Math.sin(a), hy + du * Math.sin(a) + dv * Math.cos(a)]; });
  pen.part(P(cap), { col: C.accent, p: 1, gap: 5, w: 7, seed: sd + 92 }, { w: lw * 0.85, seed: sd + 93, col: C.line });
  // 라벨 띠 + 글자
  pen.part(P([[-0.66, -0.55], [0.66, -0.55], [0.66, -1.25], [-0.66, -1.25]]), { col: f.label_color || pen.c.white, p: 0.95, gap: 5, w: 7, seed: sd + 94 }, { w: lw * 0.7, seed: sd + 95, col: C.line });
  if (f.label) { const c = P([[0, -0.82]])[0]; pen.text(String(f.label), c[0], c[1], { size: R * 0.42, col: C.line, seed: sd + 96, weight: 700 }); }
  pen.line(P([[-0.6, -1.65], [-0.62, -1.4]]), { w: lw * 1.3, col: pen.c.white, p: 1, seed: sd + 97, taper: 0.3, streak: 0 });
}

function drawHuman(pen, P, pose, spec, A, b, R, hands, face, armO, lw, sd, view) {
  const C = spec.body.colors, f = spec.body.features || {};
  const skin = f.skin || '#f2c7a0', pants = f.pants || shade(C.body, 0.55), shoes = f.shoes || C.line, hair = f.hair || '#3a2621';
  const skinF = bodyFill(skin, sd + 5, R < 40), topF = bodyFill(C.body, sd + 6, R < 40), pantF = bodyFill(pants, sd + 7, R < 40, -0.5), hairF = { ...bodyFill(hair, sd + 8, R < 40, 1.1), cross: false };
  const L = { w: lw, seed: sd + 2, col: C.line };
  const { headR, cy, neck, hip, shx } = A;
  // 다리(걷기: 번갈아 들기) + 신발
  [-1, 1].forEach((k, i) => {
    const hx = k * 0.26, fx = k * (0.3 + b.spread), lift = b.lift[i], fy = -lift;
    const knee = [hx + k * 0.04 + (lift ? 0.18 : 0), (hip + fy) / 2 - lift * 0.4];
    if (f.skirt) pen.part(P(tube([[hx * 0.7, hip + 0.2], knee, [fx, fy - 0.12]], 0.2)), skinF, L);
    else pen.part(P(tube(curve([[hx, hip], knee, [fx, fy - 0.12]], 4), 0.34)), pantF, { ...L, seed: sd + 10 + i });
    pen.part(P(smooth([[fx - 0.18, fy - 0.12], [fx + 0.1, fy - 0.16], [fx + 0.3, fy - 0.04], [fx + 0.26, fy + 0.02], [fx - 0.2, fy + 0.02]], 4)), { col: shoes, p: 0.95, gap: 4, w: 6, seed: sd + 12 + i }, { ...L, seed: sd + 14 + i });
  });
  // 먼 팔(q 보기)
  if (view !== 'front') drawArm(pen, P, A.sh[0], hands[0], armO(0, { jointed: true, width: 0.24, handR: 0.15, handCol: skin, fillO: topF }));
  // 몸통(윗옷) + 치마
  const torso = smooth([[-shx, neck + 0.08], [-shx * 0.6, neck - 0.04], [shx * 0.6, neck - 0.04], [shx, neck + 0.08], [shx * 0.86, hip + 0.06], [-shx * 0.86, hip + 0.06]], 5);
  if (f.skirt) pen.part(P([[-shx * 0.8, hip - 0.05], [shx * 0.8, hip - 0.05], [shx * 1.15, hip + 0.55], [-shx * 1.15, hip + 0.55]]), pantF, L);
  pen.part(P(torso), topF, L);
  // 목 + 머리
  pen.part(P([[-0.12, neck - 0.2], [0.12, neck - 0.2], [0.13, neck + 0.04], [-0.13, neck + 0.04]]), skinF, L);
  const hs = hairShape(f.hair_style || 'short', headR, cy, view);
  if (hs.back) pen.part(P(hs.back), hairF, { ...L, seed: sd + 17 });
  const sx = view === 'q' ? 0.06 : view === 'side' ? 0.12 : 0;
  pen.part(P(ellipse(sx, cy, headR * (view === 'side' ? 0.94 : 1), headR * 1.04, 36)), skinF, { ...L, seed: sd + 18 });
  if (view === 'side' || view === 'q') { const nx = sx + headR * (view === 'side' ? 0.86 : 0.62); pen.line(P([[nx, cy + headR * 0.02], [nx + headR * 0.12, cy + headR * 0.22], [nx - headR * 0.02, cy + headR * 0.27]]), { w: lw * 0.75, seed: sd + 19, col: C.line }); }   // 코(꺾은 선 하나)
  if (hs.front) pen.part(P(hs.front), hairF, { ...L, seed: sd + 20 });
  drawFace(pen, P, face);
  if (view === 'front') { drawArm(pen, P, A.sh[0], hands[0], armO(0, { jointed: true, width: 0.24, handR: 0.15, handCol: skin, fillO: topF, bend: 1 })); }
  drawArm(pen, P, A.sh[1], hands[1], armO(1, { jointed: true, width: 0.24, handR: 0.15, handCol: skin, fillO: topF, bend: -1 }));   // 팔꿈치는 바깥쪽으로
}
function hairShape(style, r, cy, view) {
  const q = view === 'q' ? 0.06 : view === 'side' ? 0.12 : 0;
  const cap = [[-r * 1.04 + q, cy + r * 0.05], [-r * 0.95 + q, cy - r * 0.6], [-r * 0.4 + q, cy - r * 1.12], [r * 0.4 + q, cy - r * 1.14], [r * 0.98 + q, cy - r * 0.55], [r * 1.02 + q, cy - r * 0.05], [r * 0.6 + q, cy - r * 0.48], [-r * 0.1 + q, cy - r * 0.55], [-r * 0.7 + q, cy - r * 0.35]];
  if (style === 'none') return {};
  if (style === 'bob') return { back: smooth([[-r * 1.18 + q, cy + r * 0.75], [-r * 1.1 + q, cy - r * 0.7], [0 + q, cy - r * 1.2], [r * 1.1 + q, cy - r * 0.7], [r * 1.18 + q, cy + r * 0.75]], 6), front: smooth(cap, 5) };
  if (style === 'long') return { back: smooth([[-r * 1.2 + q, cy + r * 1.9], [-r * 1.15 + q, cy - r * 0.7], [0 + q, cy - r * 1.22], [r * 1.15 + q, cy - r * 0.7], [r * 1.2 + q, cy + r * 1.9], [0 + q, cy + r * 1.7]], 6), front: smooth(cap, 5) };
  if (style === 'bun') return { back: ellipse(q, cy - r * 1.25, r * 0.45, r * 0.4, 20), front: smooth(cap, 5) };
  if (style === 'spiky') { const s = []; for (let i = 0; i <= 8; i++) { const a = Math.PI + i / 8 * Math.PI; const rr = i % 2 ? r * 1.38 : r * 1.06; s.push([Math.cos(a) * rr + q, cy + Math.sin(a) * rr]); } s.push([r * 0.6 + q, cy - r * 0.4], [-r * 0.6 + q, cy - r * 0.4]); return { front: s }; }
  return { front: smooth(cap, 5) };   // short
}

function drawAnimal(pen, P, pose, spec, A, b, R, hands, face, armO, lw, sd, view) {
  const C = spec.body.colors, f = spec.body.features || {};
  const bodyF = bodyFill(C.body, sd + 1, R < 40), accF = bodyFill(C.accent, sd + 3, R < 40, -0.4);
  const L = { w: lw, seed: sd + 2, col: C.line };
  const { headR, cy } = A, q = view === 'q' ? 0.1 : view === 'side' ? 0.22 : 0;
  // 꼬리(몸 뒤)
  const tail = f.tail || 'curl';
  if (tail !== 'none') {
    const tp = tail === 'long' ? [[-0.55, -0.7], [-1.05, -0.9], [-1.25, -1.4]] : tail === 'fluffy' ? [[-0.6, -0.75], [-1.0, -1.1], [-0.95, -1.5]] : [[-0.55, -0.7], [-0.95, -0.85], [-0.9, -1.2], [-0.72, -1.1]];
    pen.part(P(tube(curve(tp, 4), tail === 'fluffy' ? 0.4 : 0.2, tail === 'fluffy' ? 0.3 : 0.14)), bodyF, { ...L, seed: sd + 40 });
  }
  [-1, 1].forEach((k, i) => {
    const fx = k * (A.feet + b.spread), fy = -0.06 - b.lift[i];
    pen.part(P(tube(curve([[k * 0.3, -0.5], [fx, -0.22 - b.lift[i] * 0.5], [fx, fy]], 4), 0.3)), bodyF, { ...L, seed: sd + 20 + i });
    pen.part(P(ellipse(fx + k * 0.05, fy + 0.01, 0.22, 0.11, 16)), bodyF, { ...L, seed: sd + 22 + i });
  });
  if (view !== 'front') drawArm(pen, P, A.sh[0], hands[0], armO(0, { width: 0.26, handR: 0.15 }));
  pen.part(P(ellipse(q * 0.5, -0.95, 0.78, 0.82, 36)), bodyF, L);
  if (f.belly !== false) pen.part(P(ellipse(q * 0.9, -0.85, 0.46, 0.52, 28)), accF, { ...L, seed: sd + 4, w: lw * 0.7 }, { occ: false, kn: false });
  // 귀
  const ears = f.ears || 'round';
  const earPts = (k) => {
    const ex = k * headR * 0.62 + q, ey = cy - headR * 0.78;
    if (ears === 'pointy') return [[ex - 0.28 * headR, ey + 0.2 * headR], [ex + k * 0.1 * headR, ey - 0.62 * headR], [ex + 0.28 * headR, ey + 0.2 * headR]];
    if (ears === 'long') return ellipse(ex, ey - 0.55 * headR, 0.2 * headR, 0.62 * headR, 20, 0, Math.PI * 2, k * 0.15);
    if (ears === 'floppy') return ellipse(k * headR * 0.98 + q, cy - 0.05 * headR, 0.22 * headR, 0.55 * headR, 20, 0, Math.PI * 2, -k * 0.3);
    return ellipse(ex, ey, 0.3 * headR, 0.3 * headR, 20);
  };
  if (ears !== 'none') [-1, 1].forEach((k, i) => { pen.part(P(earPts(k)), bodyF, { ...L, seed: sd + 44 + i }); if (ears !== 'floppy') pen.hatch(P(xfIn(earPts(k), 0.55)), { col: C.accent, p: 0.8, gap: 4, w: 6, seed: sd + 46 + i }); });
  pen.part(P(ellipse(q, cy, headR, headR * 0.94, 40)), bodyF, { ...L, seed: sd + 48 });
  if (f.snout !== false) {
    pen.part(P(ellipse(q * 1.6 + (view === 'side' ? 0.35 * headR : 0), cy + headR * 0.42, headR * 0.36, headR * 0.26, 24)), accF, { ...L, seed: sd + 49, w: lw * 0.75 }, { occ: false, kn: false });
    const n = P([[q * 1.6 + (view === 'side' ? 0.5 * headR : 0), cy + headR * 0.3]])[0]; pen.dab(n[0], n[1], R * 0.09 * headR, { col: C.line, p: 1, seed: sd + 51 });
  }
  drawFace(pen, P, { ...face, F: [face.F[0], cy + headR * 0.62, face.F[2], face.F[3], face.F[4]] });
  if (view === 'front') drawArm(pen, P, A.sh[0], hands[0], armO(0, { width: 0.26, handR: 0.15 }));
  drawArm(pen, P, A.sh[1], hands[1], armO(1, { width: 0.26, handR: 0.15 }));
}
function xfIn(pts, k) { let cx = 0, cy = 0; for (const [x, y] of pts) { cx += x; cy += y; } cx /= pts.length; cy /= pts.length; return pts.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]); }

// 시트용: 동작별 키포즈 시각(초) — 한 번 하는 동작은 단계별, 반복 동작은 두 장
export function keyTimes(action, info) {
  const K = {
    idle: [0, 0.9], walk: [0.1, 0.35], hop: [0.12, 0.45, 0.78], wave: [0.1, 0.45], point: [0.2], nod: [0.1, 0.5], bow: [0.1, 0.5], shake: [0.05, 0.22],
    jump: [0.08, 0.38, 0.66], hug: [0.1, 0.6], push: [0.05, 0.15], lift: [0.1, 0.4], shrink: [0.0, 0.3, 0.7], cheer: [0.1, 0.35], fall: [0.5, 1.2, 1.22], float: [0.1, 0.25],
    pulled: [0.3, 0.8], pull: [0.25, 0.8], link: [0.0, 0.6], sit: [0.3],
  };
  return K[action] || (info && info.dur ? [0, info.dur * 0.5, info.dur] : [0.1, 0.5]);
}

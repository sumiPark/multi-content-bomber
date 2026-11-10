// 이미지 전환: A(나가는 장면의 마지막 그림) · B(들어오는 장면의 지금 그림) 두 2D 캔버스를 섞어 out(2D)에 그린다. u: 0→1
// page-turn은 퍼스트겔 크레용 시험본 film.js의 페이지 넘김(띠마다 아핀 변환 — lemo-opuscar crayon-book STYLE.md §9)을 일반화한 것.
import { ss } from '/core/lib.js';

export function fade(g, A, B, u, W, H) {
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.drawImage(A, 0, 0, W, H);
  g.globalAlpha = ss(u); g.drawImage(B, 0, 0, W, H); g.globalAlpha = 1;
}
// 왼쪽 → 오른쪽으로 새 장면이 드러남. 가장자리는 손으로 자른 듯 들쭉날쭉(색 띠는 스타일이 덧그린다)
export function wipe(g, A, B, u, W, H, o = {}) {
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.drawImage(A, 0, 0, W, H);
  const e = ss(u), band = o.band || 0, X = y => -W * 0.08 + (W * 1.16 + band) * e + 10 * Math.sin(y * 0.03) + 6 * Math.sin(y * 0.11);
  g.save(); g.beginPath(); g.moveTo(-10, -10);
  for (let y = -10; y <= H + 10; y += 20) g.lineTo(X(y) - band, y);
  g.lineTo(-10, H + 10); g.closePath(); g.clip(); g.drawImage(B, 0, 0, W, H); g.restore();
  if (band > 0 && o.color) {   // 경계에 색 띠(50년대 색 블록 와이프)
    g.save(); g.beginPath(); for (let y = -10; y <= H + 10; y += 20) g.lineTo(X(y), y); for (let y = H + 10; y >= -10; y -= 20) g.lineTo(X(y) - band, y); g.closePath();
    g.fillStyle = o.color; g.fill(); g.restore();
  }
}
// 책장 넘김: A가 오른쪽 가장자리부터 들려 왼쪽으로 넘어가고 B가 드러난다
export function pageTurn(g, A, B, u, W, H) {
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.drawImage(B, 0, 0, W, H);
  const th = (Math.PI / 2 + 0.25) * Math.pow(ss(u), 1.25), D = 2400 * W / 1080, N = 54;
  const ang = x => th + 0.45 * Math.sin(Math.min(Math.PI, 2 * th)) * Math.pow(x / W, 1.6);
  const proj = (x, y, a) => { const hgt = x * Math.sin(a), f = D / (D - hgt), X = x * Math.cos(a); return [W / 2 + (X - W / 2) * f, H / 2 + (y - H / 2) * f]; };
  const [ex] = proj(W, 0, ang(W));
  if (ex > 0) { const gr = g.createLinearGradient(ex, 0, ex + 260 * Math.sin(th), 0); gr.addColorStop(0, `rgba(40,28,15,${0.35 * Math.sin(Math.min(th, Math.PI / 2))})`); gr.addColorStop(1, 'rgba(40,28,15,0)'); g.fillStyle = gr; g.fillRect(Math.max(0, ex - 2), 0, W, H); }
  for (let i = 0; i < N; i++) {
    const u0 = W * i / N, u1 = W * (i + 1) / N, aA = ang(u0), aB = ang(u1);
    const [XA, YA0] = proj(u0, 0, aA), [, YA1] = proj(u0, H, aA), [XB, YB0] = proj(u1, 0, aB);
    if (XB < 0 && XA < 0) continue;
    if (Math.cos(aB) < 0) continue;
    if (Math.abs(XB - XA) < 0.2) continue;
    const sw = W / N;
    g.save(); g.setTransform((XB - XA) / sw, (YB0 - YA0) / sw, 0, (YA1 - YA0) / H, XA, YA0);
    g.drawImage(A, u0, 0, sw, H, 0, 0, sw * 1.05, H);
    g.fillStyle = `rgba(60,40,20,${0.3 * Math.sin((aA + aB) / 2) * (0.5 + 0.5 * u0 / W)})`; g.fillRect(0, 0, sw * 1.05, H);
    g.restore();
  }
}
export const TRANSITIONS = { fade, wipe, 'page-turn': pageTurn };

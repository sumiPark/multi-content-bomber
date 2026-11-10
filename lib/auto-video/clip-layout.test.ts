import assert from "node:assert/strict";
import test from "node:test";
import { compareLayout, countTimes, stepsLayout } from "./clips";
import { avoidSideCut, avoidTextCut, avoidTextCuts, gifCols, gifRows, mergeGifRows, type GifRow } from "./gif-clips";

// 2026-11-09 시험 영상의 두 문제를 재현한다.
// ① 목록 도식(steps)의 두 번째 항목이 장면 가운데 이후에 나와, 가운데 프레임이 항목 하나 · 작은 제목뿐인 "거의 한 색" 화면이 됐다.
// ② 상세페이지 GIF를 자를 때 위 경계가 빨간 제목 띠의 글자 줄을 지나가 글자 윗부분이 잘린 채 들어갔다.

test("목록 도식은 짧은 장면에서도 가운데 프레임 전에 모든 항목이 나온다", () => {
  // 시험 영상의 실제 값: 4번 컷 2.72초, 5번 컷 1.979초, 항목 2개
  for (const [items, seconds] of [[["발효", "비타민 B12"], 2.72], [["비타민 B12", "사이아노코발아민"], 1.979]] as const) {
    const { times } = stepsLayout([...items], seconds);
    assert.equal(times.length, 2);
    assert.ok(times[1] + 0.3 < seconds / 2, `${seconds}초 장면의 두 번째 항목이 ${times[1]}초에 나온다`);
  }
  for (let n = 1; n <= 4; n++) {
    for (const seconds of [1.2, 1.8, 2.5, 4, 6, 8]) {
      const { times } = stepsLayout(Array.from({ length: n }, (_, i) => `항목${i}`), seconds);
      assert.ok(times.every((t, i) => i === 0 || t > times[i - 1]), "항목은 차례로 나온다");
      // 등장 움직임(0.3초)까지 끝난 뒤에도 장면의 절반 이상 동안 목록 전체가 보인다
      assert.ok(times[n - 1] + 0.3 <= Math.max(0.8, seconds * 0.5), `${n}개 · ${seconds}초: 마지막 항목 ${times[n - 1]}초`);
    }
  }
});

test("목록 도식은 항목이 적을수록 크게, 가장 긴 항목도 한 줄에 들어가게 그린다", () => {
  const two = stepsLayout(["발효", "비타민 B12"], 2.7);
  const four = stepsLayout(["하나", "둘", "셋", "넷"], 2.7);
  assert.ok(two.font > 66, "예전 크기(66px)보다 크다");
  assert.ok(two.font > four.font);
  const long = stepsLayout(["가나다라마바사아자차카타", "짧게"], 3);
  assert.ok(long.icon + 32 + 12 * long.font <= 900, "12자 항목이 글자 영역 안에 들어간다");
  // 목록 묶음은 자막 자리(화면 아래쪽) 위, 화면 가운데쯤에 선다
  for (const [lay, n] of [[two, 2], [four, 4], [long, 2]] as const) {
    assert.ok(lay.titleTop >= 400 && lay.top + n * lay.icon + (n - 1) * lay.rowGap <= 1300, JSON.stringify(lay));
  }
});

/** 시험 영상 g5(760x1530)의 자른 열을 본뜬 줄 정보: 위쪽은 상세페이지 글자 · 빨간 띠, 732줄부터 사진 */
function g5Rows(): GifRow[] {
  return Array.from({ length: 1530 }, (_, y) => {
    if (y >= 731 && y < 1136) return { flat: 0.15, text: false };
    const text = (y >= 100 && y < 140) || (y >= 632 && y < 668) || (y >= 676 && y < 708);
    return { flat: text ? 0.5 : 0.95, text };
  });
}

test("GIF 자르기 위 경계가 글자 띠 안에 걸리면 띠를 통째로 빼고 사진부터 쓴다", () => {
  // 시험 영상 g5의 장면표 값: crop_y 0.43 · crop_h 0.2 → 658~964줄, 위 경계가 "파이니티 리젠" 줄(632~668)을 지나간다
  const c = avoidTextCut(g5Rows(), { x: 395, y: 658, w: 258, h: 306 });
  assert.equal(c.y, 731);
  assert.equal(c.h, 232);
  assert.equal(c.x, 395);
  assert.equal(c.w, 258);
});

test("띠를 빼면 화면이 너무 작아질 때는 지나가던 글자 줄을 통째로 넣는다", () => {
  const c = avoidTextCut(g5Rows(), { x: 395, y: 658, w: 258, h: 140 });
  assert.ok(c.y <= 632, `위 경계 ${c.y}가 글자 줄 위에 있어야 한다`);
  assert.ok(c.y + c.h >= 658 + 140 - 1);
  assert.equal(c.h % 2, 0);
});

test("아래 경계가 글자 띠에 걸리면 띠 앞에서 끊는다", () => {
  const rows = g5Rows().map((r, y) => (y >= 1100 && y < 1300 ? { flat: 0.9, text: y >= 1150 && y < 1190 } : y >= 731 && y < 1100 ? { flat: 0.15, text: false } : r));
  const c = avoidTextCut(rows, { x: 0, y: 760, w: 760, h: 420 });
  assert.equal(c.y, 760);
  assert.equal(c.y + c.h, 1100);
});

test("경계가 사진 안이거나, 걸린 띠 안에 자른 구역 쪽 글자가 없으면 그대로 둔다", () => {
  const photo = { x: 395, y: 760, w: 258, h: 300 };
  assert.deepEqual(avoidTextCut(g5Rows(), photo), photo);
  // 띠(0~731줄) 안이지만 자른 구역에 들어오는 글자는 없다: 글자 줄은 100~140뿐
  const rows = g5Rows().map((r, y) => (y >= 600 && y < 731 ? { flat: 0.95, text: false } : r));
  const plain = { x: 395, y: 650, w: 258, h: 300 };
  assert.deepEqual(avoidTextCut(rows, plain), plain);
  // 전체 구역은 경계가 그림 끝이라 옮길 일이 없다
  const whole = { x: 0, y: 0, w: 760, h: 1530 };
  assert.deepEqual(avoidTextCut(g5Rows(), whole), whole);
});

test("픽셀에서 단색 띠 위 글자 줄과 사진 줄을 가른다", () => {
  const w = 200;
  const h = 30;
  const rgb = new Uint8Array(w * h * 3);
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      if (y < 10) rgb.set([204, 0, 0], i); // 빨간 띠 바탕
      else if (y < 20) rgb.set(x % 10 < 4 ? [255, 255, 255] : [204, 0, 0], i); // 띠 위 흰 글자 획
      else rgb.set([Math.floor(rand() * 255), Math.floor(rand() * 255), Math.floor(rand() * 255)], i); // 사진
    }
  }
  const rows = gifRows(rgb, w, h, 0, w);
  assert.ok(rows.slice(0, 10).every((r) => r.flat > 0.9 && !r.text));
  assert.ok(rows.slice(10, 20).every((r) => r.flat >= 0.4 && r.text));
  assert.ok(rows.slice(20).every((r) => r.flat < 0.4 && !r.text));
  // 움직이는 장면은 프레임마다 달라 한 프레임에서만 글자처럼 보이는 줄은 글자로 치지 않는다
  const merged = mergeGifRows([rows, rows.map((r, y) => (y >= 15 && y < 20 ? { flat: 0.2, text: false } : r))]);
  assert.ok(merged.slice(10, 15).every((r) => r.text));
  assert.ok(merged.slice(15, 20).every((r) => !r.text));
});

// ── 2026-11-09 검토 후속: 비교 · 숫자 도식의 시각, 비교 글자 크기, GIF 왼쪽 · 오른쪽 경계 ──

const SCENES = [1.6, 2, 2.5, 3, 4, 6, 8];
const POP = 0.22;

test("비교 도식은 짧은 장면에서도 오른쪽 값이 장면 안에서 다 바뀌고, 결과가 남은 시간 동안 보인다", () => {
  // 예전에는 2개 값이면 5.8초에야 바뀌어 2~4초 장면에서는 결과가 나오지 않았다
  for (let n = 1; n <= 5; n++) {
    for (const seconds of SCENES) {
      const lay = compareLayout({ labels: ["일반", "우리"], values: ["1", "2"] }, n, seconds);
      assert.equal(lay.changes.length, n - 1);
      const all = [lay.left, lay.first, ...lay.changes];
      assert.ok(all.every((t, i) => i === 0 || t > all[i - 1]), `${n}개 · ${seconds}초: 차례로 나온다 ${JSON.stringify(all)}`);
      const last = all[all.length - 1];
      assert.ok(last + POP <= seconds * 0.75, `${n}개 · ${seconds}초: 마지막 값 ${last.toFixed(2)}초`);
      assert.ok(last <= 5.8, "긴 장면에서도 예전보다 늦지 않다");
      if (n <= 2 && seconds >= 2) assert.ok(last + POP <= seconds * 0.56, `${n}개 · ${seconds}초: 결과가 장면 절반쯤 동안 보인다 (${last.toFixed(2)}초)`);
      if (n <= 3 && seconds >= 3) assert.ok(last + POP <= seconds * 0.6, `${n}개 · ${seconds}초: ${last.toFixed(2)}초`);
      // 오른쪽 값이 바뀌기 전에 읽을 틈이 있다
      const right = [lay.first, ...lay.changes];
      if (seconds >= 2.5) for (let i = 1; i < right.length; i++) assert.ok(right[i] - right[i - 1] >= 0.18, `${n}개 · ${seconds}초: 틈 ${(right[i] - right[i - 1]).toFixed(2)}초`);
      assert.ok(lay.fillAt + lay.fillDur <= seconds, "오른쪽 칸 물들기도 장면 안에서 끝난다");
    }
  }
});

test("비교 도식 값 · 이름은 반쪽 칸(430px)에 한 줄로 들어가는 크기로 줄인다", () => {
  const half = 430 - 56;
  // 짧은 값은 예전 크기 그대로
  const short = compareLayout({ labels: ["일반", "우리"], values: ["2배", "1개"] }, 1, 3);
  assert.equal(short.valueFont, 104);
  assert.equal(short.labelFont, 50);
  // 스키마 상한(6자) 한글 값: 예전 104px이면 6 × 104 = 624px로 칸을 넘어 잘렸다
  const long = compareLayout({ labels: ["시중 일반 제품 평균", "우리"], values: ["사이아노코발", "1,000mg"] }, 1, 3);
  assert.ok(long.valueFont * 6 <= half, `6자 값 ${long.valueFont}px`);
  assert.ok(long.valueFont >= 44 && !long.valueWrap);
  assert.ok(long.labelFont * 10 <= half && !long.labelWrap, `10자 이름 ${long.labelFont}px`);
  // 글자가 줄어도 줄 가운데 높이는 비슷하게 유지된다
  assert.ok(long.valueTop > 220 && long.valueTop < 260);
  // 가장 작은 크기로도 안 들어가면 자르지 않고 줄을 바꾼다
  const huge = compareLayout({ labels: ["", ""], values: ["가나다라마바사아자차카타"] }, 1, 3);
  assert.equal(huge.valueFont, 44);
  assert.equal(huge.valueWrap, true);
});

test("숫자 도식은 짧은 장면에서도 숫자와 끝 글자가 장면 안에서 나온다", () => {
  for (const seconds of SCENES) {
    const plain = countTimes(seconds, false);
    assert.ok(plain.start + plain.run <= Math.max(0.8, seconds * 0.5), `${seconds}초: 숫자가 ${(plain.start + plain.run).toFixed(2)}초에 다 찬다`);
    const end = countTimes(seconds, true);
    const shown = end.endAt + 0.35;
    // 예전: 2초 장면이면 끝 글자가 2.1초(장면 뒤), 3초면 3.1초
    assert.ok(shown <= seconds - 0.15, `${seconds}초: 끝 글자가 ${shown.toFixed(2)}초에야 다 나온다`);
    if (seconds >= 2) assert.ok(shown <= seconds * 0.75, `${seconds}초: 끝 글자 ${shown.toFixed(2)}초`);
    if (seconds >= 3) assert.ok(shown <= seconds * 0.62, `${seconds}초: 끝 글자 ${shown.toFixed(2)}초`);
    // 다 찬 숫자를 잠깐이라도 보여 준 뒤 끝 글자로 넘어간다
    assert.ok(end.fadeAt - (end.start + end.run) >= 0.199);
    assert.ok(end.run >= 0.5 && plain.run >= 0.5, "숫자가 너무 빨리 차지 않는다");
  }
  // 긴 장면은 예전(최대 4초)보다 길게 끌지 않는다
  assert.ok(countTimes(8, false).run <= 4);
});

/** 상세페이지 한 단을 본뜬 열 정보: 0~279열은 흰 설명 칸(글자 낱말 40~120 · 150~260열), 280열부터 사진 */
function sideCols(): GifRow[] {
  return Array.from({ length: 760 }, (_, x) => {
    if (x >= 280) return { flat: 0.12, text: false };
    const text = (x >= 40 && x < 120) || (x >= 150 && x < 260);
    return { flat: text ? 0.6 : 0.97, text };
  });
}

test("GIF 자르기 왼쪽 경계가 설명 글 칸 안에 걸리면 칸을 통째로 빼고 사진부터 쓴다", () => {
  // 왼쪽 경계 200이 "150~260" 낱말을 세로로 지나간다
  const c = avoidSideCut(sideCols(), { x: 200, y: 300, w: 400, h: 500 });
  assert.equal(c.x, 280);
  assert.equal(c.w, 320);
  assert.equal(c.y, 300);
  assert.equal(c.h, 500);
});

test("칸을 빼면 너무 좁아질 때는 지나가던 낱말을 통째로 넣는다", () => {
  const c = avoidSideCut(sideCols(), { x: 200, y: 0, w: 160, h: 500 });
  assert.ok(c.x <= 150, `왼쪽 경계 ${c.x}가 낱말 앞에 있어야 한다`);
  assert.ok(c.x + c.w >= 360 - 1);
  assert.equal(c.w % 2, 0);
});

test("오른쪽 경계가 설명 글 칸에 걸리면 칸 앞에서 끊고, 사진 안이면 그대로 둔다", () => {
  // 사진이 왼쪽, 설명 칸이 오른쪽인 단
  const cols = sideCols().slice().reverse();
  const c = avoidSideCut(cols, { x: 100, y: 0, w: 460, h: 400 }); // 오른쪽 경계 560이 낱말(500~610)을 지나간다
  assert.equal(c.x, 100);
  assert.equal(c.x + c.w, 480);
  const photo = { x: 300, y: 0, w: 200, h: 400 };
  assert.deepEqual(avoidSideCut(sideCols(), photo), photo);
  const whole = { x: 0, y: 0, w: 760, h: 400 };
  assert.deepEqual(avoidSideCut(sideCols(), whole), whole);
});

test("픽셀에서 흰 칸 위 글자 열과 사진 열을 가르고, 네 경계를 함께 고친다", () => {
  const w = 400;
  const h = 200;
  const rgb = new Uint8Array(w * h * 3);
  let seed = 11;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      if (x >= 120) rgb.set([Math.floor(rand() * 255), Math.floor(rand() * 255), Math.floor(rand() * 255)], i); // 사진
      else if (x >= 20 && x < 100 && y % 12 < 5) rgb.set([20, 20, 20], i); // 흰 칸 위 검은 글자 획(가로 글자 줄이 여러 줄)
      else rgb.set([250, 250, 250], i); // 흰 칸 바탕
    }
  }
  const cols = gifCols(rgb, w, h, 0, h);
  assert.ok(cols.slice(20, 100).every((r) => r.flat >= 0.4 && r.text), "글자 열");
  assert.ok(cols.slice(0, 20).every((r) => r.flat > 0.9 && !r.text), "흰 바탕 열");
  assert.ok(cols.slice(120).every((r) => r.flat < 0.4 && !r.text), "사진 열");
  // 왼쪽 경계 60이 글자 열을 세로로 지나간다 → 흰 칸(0~120)을 통째로 빼고 사진부터
  const asked = { x: 60, y: 0, w: 300, h: 200 };
  const fixed = avoidTextCuts([rgb], { w, h }, asked);
  assert.deepEqual(fixed, { x: 120, y: 0, w: 240, h: 200 });
  // 원본을 못 읽으면 고른 구역 그대로
  assert.equal(avoidTextCuts(null, { w, h }, asked), asked);
});

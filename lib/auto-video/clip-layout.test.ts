import assert from "node:assert/strict";
import test from "node:test";
import { stepsLayout } from "./clips";
import { avoidTextCut, gifRows, mergeGifRows, type GifRow } from "./gif-clips";

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

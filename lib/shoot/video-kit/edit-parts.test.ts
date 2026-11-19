import assert from "node:assert/strict";
import test from "node:test";
import { partSubtitles, toSrt } from "./edit-parts";
import type { Timeline } from "./timeline";

// 편집용 파일 묶음의 자막 파일(srt) — 2026-11-19

test("srt는 시각 차례 · 1부터 번호 · 쉼표 밀리초로 쓰고 빈 글은 뺀다", () => {
  const srt = toSrt([
    { start: 3.3, end: 4.8, text: "물도 부어 줄게요." },
    { start: 2, end: 3.2, text: "볼에 가루를 붓고" },
    { start: 5, end: 6, text: "  " },
  ]);
  assert.equal(srt, "1\n00:00:02,000 --> 00:00:03,200\n볼에 가루를 붓고\n\n2\n00:00:03,300 --> 00:00:04,800\n물도 부어 줄게요.\n");
});

test("말 자막과 첫 화면 · 끝 화면 글자를 따로 나눈다", () => {
  const blank = { at_word: "", at: 0, text: "", small: "", sub: "", note: "", chip: "", tone: "", side: "", number: "", unit: "", left: "", right: "", left_value: 0, right_value: 0, items: [], x: 0, y: 0, r: 0, from: "" };
  const tl = {
    duration: 70,
    captions: [{ id: "c", text: "자막", emphasis: [], start: 2, end: 3, beat: 1 }],
    graphics: [{ id: "g", type: "end_card", g: { ...blank, type: "end_card", text: "프로필 링크", sub: "지금 확인" }, start: 60, end: 65, beat: 9 }],
    hook: { start: 0, end: 1.8, onScreen: "K피자에\n넣지 마세요", highlight: "", position: "top" },
  } as unknown as Timeline;
  const { captions, titles } = partSubtitles(tl);
  assert.match(captions, /^1\n00:00:02,000 --> 00:00:03,000\n자막\n$/);
  assert.match(titles, /00:00:00,000 --> 00:00:01,800\nK피자에\n넣지 마세요/);
  assert.match(titles, /00:01:00,000 --> 00:01:05,000\n프로필 링크\n지금 확인/);
});

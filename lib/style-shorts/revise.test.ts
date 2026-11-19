import assert from "node:assert/strict";
import test from "node:test";
import { quotedTexts } from "@/lib/agents/edit-revise";
import type { VersionTimeline } from "@/lib/style-shorts/jobs";
import { asksFor, noteContext, reviseRequestText, type ReviseNote } from "./revise";

// 스타일 쇼츠 주석 수정 — 주석을 편집 에이전트가 읽을 글로 바꾸는 순수 함수(2026-11-19)

const tl: VersionTimeline = {
  duration: 20,
  cuts: [
    { start: 0, end: 4, clip: 1, in: 2, },
    { start: 4, end: 9, clip: 2, in: 0 },
  ],
  captions: [{ start: 4.2, end: 6, text: "딱 3분이면 끝" }],
  graphics: [{ start: 5, end: 7, type: "badge", text: "꿀팁" }],
  sfx: [{ t: 5.1, name: "pop_soft" }],
};

const note = (over: Partial<ReviseNote>): ReviseNote => ({ no: 1, at: 5, x: 0.8, y: 0.9, body: "여기 자막이 상품을 가려요", ...over });

test("주석 시각의 장면 · 자막 · 그래픽 · 효과음과 동그라미 자리를 적는다", () => {
  const text = noteContext(note({}), tl);
  assert.match(text, /5\.0초/);
  assert.match(text, /화면 아래 오른쪽/);
  assert.match(text, /촬영본 2번 1\.0초 근처/);
  assert.match(text, /그때 자막: 〈딱 3분이면 끝〉/);
  assert.match(text, /badge 〈꿀팁〉/);
  assert.match(text, /pop_soft\(5\.1초\)/);
});

test("영상 전체 의견은 시각 · 자리 없이 적는다", () => {
  assert.equal(noteContext(note({ at: null, x: null, y: null }), tl), "영상 전체 의견");
});

test("지금 글은 따옴표로 감싸지 않아 따옴표 글자 규칙에 섞이지 않는다", () => {
  const { request } = reviseRequestText([note({ body: '자막을 "3분 컷"으로 바꿔 주세요' })], tl);
  assert.deepEqual(quotedTexts(request), ["3분 컷"]);
});

test("음악 · 자막 모양을 바꾸라는 주석만 다시 고른다", () => {
  assert.deepEqual(asksFor([note({ body: "자막 오타 고쳐 주세요" })]), { music: false, captionDesign: false });
  assert.deepEqual(asksFor([note({ body: "자막 모양이 너무 튀어요" })]), { music: false, captionDesign: true });
  assert.deepEqual(asksFor([note({ body: "배경음악을 더 밝게" })]), { music: true, captionDesign: false });
  assert.deepEqual(asksFor([note({ body: "글꼴을 굵게" })]), { music: false, captionDesign: true });
});

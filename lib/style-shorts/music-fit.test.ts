import assert from "node:assert/strict";
import { test } from "node:test";
import { orderReady } from "@/lib/shoot/video-kit/music";
import { judgeTrack, passedTracks, type FitTrack, type MoodGuide } from "@/lib/style-shorts/music-fit";

// 경쾌하고 장난스러운 분위기를 원할 때의 낱말(2026-11-20 해물모듬 카드)
const guide: MoodGuide = {
  fits: ["playful and quirky music", "celebratory and joyful music", "energetic and driving music"],
  avoid: ["calm and relaxing music", "sad and melancholic music", "romantic music"],
};

const track = (id: string, over: Partial<FitTrack>): FitTrack => ({
  id,
  fit: 3.5,
  moods: { "playful and quirky music": 3, "celebratory and joyful music": 2.5, "energetic and driving music": 2, "calm and relaxing music": 1, "sad and melancholic music": 0.5, "romantic music": 0.8 },
  loop: { period: 4.8, same: 0.75 },
  like: null,
  near: {},
  ...over,
});

test("배경음악 판정: 분위기가 맞고 반복이 아닌 곡은 통과한다", () => {
  const v = judgeTrack(track("a", {}), guide);
  assert.equal(v.ok, true);
  assert.equal(v.score, 3.5);
});

test("배경음악 판정: 원하는 분위기 글과 안 맞는 곡(피아노 발라드 실측 0.53)은 뺀다", () => {
  const v = judgeTrack(track("ballad", { fit: 0.53, moods: { "sad and melancholic music": 4.03, "romantic music": 3.63, "playful and quirky music": 0.4 } }), guide);
  assert.equal(v.ok, false);
  assert.match(v.why ?? "", /안 맞음/);
});

test("배경음악 판정: 글과는 맞아도 피할 분위기가 더 또렷하면 뺀다(잔잔한 도입부 실측: 잔잔 2.55 · 장난 2.24)", () => {
  const v = judgeTrack(track("calm-intro", { fit: 3.48, moods: { "calm and relaxing music": 2.55, "playful and quirky music": 2.24, "celebratory and joyful music": 2.18, "energetic and driving music": 1.2 } }), guide);
  assert.equal(v.ok, false);
  assert.match(v.why ?? "", /calm and relaxing/);
});

test("배경음악 판정: 같은 소리를 그대로 이어 붙인 루프(실측 8초 · 1.0)는 뺀다", () => {
  const v = judgeTrack(track("loop", { fit: 4.53, loop: { period: 8, same: 1 } }), guide);
  assert.equal(v.ok, false);
  assert.match(v.why ?? "", /8초짜리 같은 소리/);
});

test("배경음악 판정: 분위기 낱말을 못 골랐으면 글과 맞는 정도 · 반복만 본다", () => {
  assert.equal(judgeTrack(track("a", { moods: { "calm and relaxing music": 3, "playful and quirky music": 1 } }), null).ok, true);
  assert.equal(judgeTrack(track("b", { fit: 1.9 }), null).ok, false);
});

test("배경음악 판정: 잴 수 없던 곡은 빼고, 통과한 곡은 잘 맞는 순서로 돌려준다", () => {
  const { passed, dropped } = passedTracks([track("low", { fit: 2.4 }), { id: "broken", error: "AudioError" }, track("high", { fit: 4.2 })], guide);
  assert.deepEqual(passed.map((p) => p.id), ["high", "low"]);
  assert.deepEqual(dropped.map((d) => d.id), ["broken"]);
});

test("곡 바꿈: 통과한 후보 가운데 먼저 고른 곡과 소리가 닮은 곡을 먼저 쓴다", () => {
  const ready = [
    { id: "far", score: 3.4, near: { first: 0.3 }, like: null },
    { id: "close", score: 3.1, near: { first: 0.8 }, like: null },
  ];
  // 먼저 고른 곡이 없으면 점수 순서
  assert.deepEqual(orderReady(ready, null).map((r) => r.id), ["far", "close"]);
  assert.deepEqual(orderReady(ready, "first").map((r) => r.id), ["close", "far"]);
  // 먼저 고른 곡이 같은 묶음에 없었으면 판정기가 따로 잰 값(like)을 쓴다
  assert.deepEqual(orderReady([{ id: "x", score: 3, near: {}, like: 0.2 }, { id: "y", score: 2.8, near: {}, like: 0.7 }], "other").map((r) => r.id), ["y", "x"]);
});

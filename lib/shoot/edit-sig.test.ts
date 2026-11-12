import assert from "node:assert/strict";
import { test } from "node:test";
import { editRestart, editSig, lastEditBrief } from "./edit-sig";

const clips = [
  { cut: 2, path: "org/b.mp4" },
  { cut: 1, path: "org/a.mp4" },
];

test("서명은 편집 서버가 저장해 온 형식 그대로다 — 촬영본 순서대로 + 하고 싶은 말", () => {
  assert.equal(editSig(clips, " 껍질째 먹는 법 "), "org/a.mp4|org/b.mp4|brief:껍질째 먹는 법");
  assert.equal(editSig(clips, null), "org/a.mp4|org/b.mp4|brief:");
  assert.equal(editSig(clips, "   "), "org/a.mp4|org/b.mp4|brief:");
  assert.equal(editSig([], "말"), "brief:말");
});

test("촬영본과 하고 싶은 말이 같으면 지난 계획을 그대로 쓴다", () => {
  const last = editSig(clips, "껍질째 먹는 법");
  assert.equal(editRestart(last, clips.slice().reverse(), "껍질째 먹는 법 "), null);
});

test("하고 싶은 말만 바뀌면 brief", () => {
  const last = editSig(clips, "껍질째 먹는 법");
  assert.equal(editRestart(last, clips, "씨 없는 감"), "brief");
  assert.equal(editRestart(last, clips, null), "brief");
  assert.equal(editRestart(editSig(clips, null), clips, "새로 넣은 말"), "brief");
});

test("촬영본만 바뀌면 clips, 둘 다 바뀌면 both", () => {
  const last = editSig(clips, "껍질째 먹는 법");
  const swapped = [clips[0], { cut: 1, path: "org/c.mp4" }];
  assert.equal(editRestart(last, swapped, "껍질째 먹는 법"), "clips");
  assert.equal(editRestart(last, swapped, "씨 없는 감"), "both");
  // 순서만 바꿔도 새로 편집한다
  assert.equal(
    editRestart(
      last,
      [
        { cut: 1, path: "org/b.mp4" },
        { cut: 2, path: "org/a.mp4" },
      ],
      "껍질째 먹는 법",
    ),
    "clips",
  );
});

test("하고 싶은 말이 없는 예전 서명 · 서명이 없는 계획은 old", () => {
  assert.equal(editRestart("org/a.mp4|org/b.mp4", clips, null), "old");
  assert.equal(editRestart(null, clips, null), "old");
});

test("지난 편집에 쓴 하고 싶은 말을 꺼낸다 — 말 안에 구분 글자가 있어도", () => {
  assert.equal(lastEditBrief(editSig(clips, "A|brief:B")), "A|brief:B");
  assert.equal(lastEditBrief(editSig([], "말")), "말");
  assert.equal(lastEditBrief(editSig(clips, null)), "");
  assert.equal(lastEditBrief("org/a.mp4|org/b.mp4"), null);
  assert.equal(lastEditBrief(null), null);
});

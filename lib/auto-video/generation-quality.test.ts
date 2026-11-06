import assert from "node:assert/strict";
import test from "node:test";
import { hookEvidenceProblems, rejectIncompatiblePhrases } from "./hook-evidence";
import { contrast, DEFAULT_LOOK, readableLook, readableRows } from "../shoot/video-kit/caption-style";
import { inspectAndRepairVideo, type VideoIssue, type VideoQuality } from "../shoot/video-kit/quality";

const textureBoard = {
  hook: { spoken: "이름 말고, 제형부터 보세요.", answer: "미세버블 제형", evidence_scenes: [1] },
  photos: [{ id: "p1", usable: true, kind: "product" }],
  scenes: [{ source: "photo", source_id: "p1", say: "후킹" }, { source: "photo", source_id: "p1", say: "거품 토너예요" }],
};
test("마지막 문구가 소재와 맞지 않으면 후킹을 유지하고 마지막 문구만 교체한다", () => {
  const state = { hooks: [{ text: "어느 단계에 쓸까요?", template: "어느 단계에 쓸까요?" }], endings: [{ text: "사용감부터 보세요", template: "사용감부터 보세요" }, { text: "제품 안내와 함께 확인하세요", template: "제품 안내와 함께 확인하세요" }], rejected: [] as { kind: "hook" | "ending"; template: string; why: string; afterCheck: boolean }[] };
  rejectIncompatiblePhrases(state, [{ kind: "ending", reason: "실제 사용감 컷이 없다" }]);
  assert.equal(state.hooks[0].text, "어느 단계에 쓸까요?");
  assert.equal(state.endings[0].text, "제품 안내와 함께 확인하세요");
  assert.equal(state.rejected[0].kind, "ending");
});
test("용기 사진만으로 제형 시연을 약속하지 않는다", () => {
  assert.match(hookEvidenceProblems(textureBoard, []).join(" "), /실제 제형/);
  assert.equal(hookEvidenceProblems({ ...textureBoard, photos: [{ id: "p1", usable: true, kind: "texture" }] }, []).length, 0);
  assert.equal(hookEvidenceProblems({ ...textureBoard, hook: { ...textureBoard.hook, spoken: "버블 토너는 어느 단계에 쓸까요?", answer: "세안 후 첫 단계" } }, []).length, 0);
});
test("후킹 답의 장면은 존재하는 본문을 가리켜야 한다", () => {
  assert.match(hookEvidenceProblems({ ...textureBoard, hook: { ...textureBoard.hook, evidence_scenes: [0, 99] } }, []).join(" "), /장면 번호/);
});
test("긴 자막과 고정 후킹도 낱말을 보존한 두 줄로 읽힌다", () => {
  for (const text of ["이름 말고, 제형부터 보세요.", "리유의 파이니티 리젠 버블 액티베이터는", "제품 안내와 함께 확인하세요.", "흡수될 때 보는 기준"]) {
    const rows = readableRows(text);
    assert.ok(rows.length <= 2);
    assert.equal(rows.join(" "), text);
    assert.ok(rows.every((r) => r.trim().length > 1));
  }
  const look = readableLook({ ...DEFAULT_LOOK, accent_color: "#141414" });
  assert.ok(contrast(look.text_color, look.box_color) >= 4.5);
  assert.ok(contrast(look.accent_color, look.box_color) >= 4.5);
});

const issue: VideoIssue = { kind: "caption", severity: "blocking", at: 2, detail: "자막이 겹침" };
test("완성본 실패 → 재편집 → 새 파일 재검수 뒤에만 통과한다", async () => {
  const seen: string[] = [];
  const saved: VideoQuality[] = [];
  const res = await inspectAndRepairVideo({ file: "initial.mp4", review: async (file) => { seen.push(file); return { issues: file === "initial.mp4" ? [issue] : [] }; }, repair: async () => "repaired.mp4", save: (q) => saved.push(structuredClone(q)) });
  assert.deepEqual(seen, ["initial.mp4", "repaired.mp4"]);
  assert.equal(saved[0].passed, false);
  assert.equal(res.quality.passed, true);
  assert.equal(res.quality.attempts.length, 2);
  assert.equal(res.quality.listening_review, "not_performed");
});
test("재편집 한도를 넘거나 소재 문제면 실패를 유지한다", async () => {
  let repairs = 0;
  const exhausted = await inspectAndRepairVideo({ file: "bad.mp4", review: async () => ({ issues: [issue] }), repair: async () => { repairs++; return "still-bad.mp4"; }, save: () => {} });
  assert.equal(repairs, 2);
  assert.equal(exhausted.quality.passed, false);
  repairs = 0;
  const mismatch = await inspectAndRepairVideo({ file: "bad.mp4", review: async () => ({ issues: [{ ...issue, kind: "content" }] }), repair: async () => { repairs++; return "wrong.mp4"; }, save: () => {} });
  assert.equal(repairs, 0);
  assert.equal(mismatch.quality.passed, false);
});
test("검수 API 실패를 문제 없음으로 바꾸지 않는다", async () => {
  await assert.rejects(inspectAndRepairVideo({ file: "video.mp4", review: async () => { throw new Error("검수 응답 없음"); }, repair: async () => "never.mp4", save: () => {} }), /검수 응답 없음/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { selectCaptionRenderer } from "./caption-renderer";
import { buildSubtitleFile, isMotionEffect, readableBrightness, type CaptionDesign } from "./caption-skill";

test("자동 콘텐츠도 설치된 자막 모션을 사용한다", () => {
  assert.equal(selectCaptionRenderer("auto", true), "motion");
  assert.equal(selectCaptionRenderer("shoot", true), "motion");
  assert.throws(() => selectCaptionRenderer("auto", false), /기본 자막으로 바꾸지/);
  assert.equal(isMotionEffect("39"), true);
  assert.equal(isMotionEffect("cut"), false);
  assert.equal(isMotionEffect("unknown"), false);
});
test("짧은 자막 합치기 이후에도 모션과 음성 시각을 보존한다", () => {
  const design: CaptionDesign = { key_fx: "39", small_fx: "cut", finish_fx: "38", key_font: "마루 부리", small_font: "주아체", reading: "차분한 정보", lines: [] };
  const cue = { id: "c1", text: "스킨케어 첫 단계에 써요.", start: 2.003, end: 3.5, beat: 1, emphasis: ["첫 단계"] };
  const file = buildSubtitleFile("video.mp4", [cue], ["lower"], design);
  assert.equal(file.lines[0].t0, 2.003);
  assert.equal(file.lines[0].t1, 3.5);
  assert.ok(file.lines[0].rows.every((r) => r.fx === "38"));
  assert.equal(file.lines[0].rows.map((r) => r.text).join("").replace(/\s/g, ""), cue.text.replace(/\s/g, ""));
  assert.ok(file.lines[0].rows.length <= 2);
});
test("밝은 펌프와 어두운 배경이 섞인 컷은 평균만 보고 검은 글자로 바꾸지 않는다", () => {
  assert.equal(readableBrightness(Uint8Array.from([70, 70, 250, 250])), null);
  assert.equal(readableBrightness(Uint8Array.from([180, 182, 178, 180])), 180);
  assert.equal(readableBrightness(new Uint8Array()), null);
});

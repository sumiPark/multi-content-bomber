import assert from "node:assert/strict";
import test from "node:test";
import { selectCaptionRenderer } from "./caption-renderer";
import { buildSubtitleFile, isMotionEffect, pickSubtitleFonts, readableBrightness, rowDelays, type CaptionDesign, type SkillBlock } from "./caption-skill";
import { FONT_PAIRING_RULES, fontChoiceLines, fontWeight, type SkillFont } from "./skill-fonts";

// 스킬 글꼴 목록(fonts.json)과 같은 모양의 시험용 값. 실제 글꼴 주소는 넣지 않는다
const font = (name: string, role: string, weights: (number | "single")[]): SkillFont => ({ name, role, look: "", webfont: weights.map((weight) => ({ weight, src: `https://example.invalid/${weight}.woff2` })) });
const FONTS: SkillFont[] = [
  font("마루 부리", "부리(명조)", [400, 600, 700, 300]),
  font("이서윤체", "손글씨", ["single"]),
  font("나눔명조", "부리(명조)", [400, 700, 800]),
  font("그리운 코코초이툰", "손글씨", ["single"]),
  font("온글잎 박다현체", "손글씨", ["single"]),
];
// 2026-11-09 시험 영상(파이니티 리젠 버블 액티베이터)의 자막 디자인 일부
const trial: CaptionDesign = {
  key_fx: "39",
  small_fx: "cut",
  finish_fx: "39",
  key_font: "마루 부리",
  small_font: "이서윤체",
  reading: "차분한 화장품 설명",
  lines: [
    { no: 0, rows: [{ text: "파이니티 리젠 버블 액티베이터라는", role: "key" }], fx: "", spark: false },
    { no: 1, rows: [{ text: "근데 성분표에서 ", role: "small" }, { text: "비타민 B12를 찾으면요?", role: "key" }], fx: "tilt", spark: true },
  ],
};
const trialCues = [
  { id: "c0", text: "파이니티 리젠 버블 액티베이터라는", start: 2.774, end: 4.52, beat: 1, emphasis: [] },
  { id: "c1", text: "근데 성분표에서 비타민 B12를 찾으면요?", start: 10.555, end: 13.035, beat: 4, emphasis: [] },
];
const hook: SkillBlock = { start: 0, end: 2.634, zone: "top", fx: "39", highlight: "이름", rows: [{ text: "비타민, 이름이 달라요", role: "key" }] };

test("자동 콘텐츠도 설치된 자막 모션을 사용한다", () => {
  assert.equal(selectCaptionRenderer(true), "motion");
  // 스킬을 못 쓰면 자동 영상도 실패 대신 기본 자막(경고는 파이프라인이 남긴다)
  assert.equal(selectCaptionRenderer(false), "basic");
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
test("효과 속도 배수를 따로 주지 않아 스킬의 자동 속도와 곱해지지 않는다", () => {
  const file = buildSubtitleFile("video.mp4", trialCues, ["top", "top"], trial, [], [hook], [], pickSubtitleFonts(FONTS, trial));
  // speed가 있으면 스킬이 줄마다 계산한 자동 속도(최대 2.2배)에 또 곱해져 등장이 0.1~0.3초로 끝난다
  assert.equal("speed" in file, false);
  // fx가 빈 줄은 정지(cut)가 아니라 대표 모션으로 움직인다
  const first = file.lines.find((l) => l.t0 === 2.774)!;
  assert.deepEqual(first.rows.map((r) => r.fx), ["39"]);
});
test("두 줄 짝의 아랫줄은 그 말을 하는 시각에 나온다", () => {
  const file = buildSubtitleFile("video.mp4", trialCues, ["top", "top"], trial, [], [], [], pickSubtitleFonts(FONTS, trial));
  const pair = file.lines.find((l) => l.t0 === 10.555)!;
  const [small, key] = pair.rows as { delay?: number; fx: string }[];
  assert.equal(small.delay, undefined);
  // "근데성분표에서"(7자) / 전체 19자 × 2.48초 ≈ 0.91초
  assert.ok(key.delay! > 0.7 && key.delay! < 0.95, `아랫줄 지연 ${key.delay}`);
  assert.equal(key.fx, "tilt");
  // 반짝이는 강조어 줄이 나온 뒤에 붙는다
  const deco = (pair as { deco?: { at: number }[] }).deco!;
  assert.ok(deco[0].at > key.delay!);
  // 한 줄 자막, 너무 짧은 자막은 지연하지 않는다
  assert.deepEqual(rowDelays({ start: 0, end: 1.5 }, ["한 줄"]), [0]);
  assert.deepEqual(rowDelays({ start: 0, end: 0.6 }, ["제품 안내에서", "붉은 컬러의"]), [0, 0]);
  // 아랫줄은 적어도 0.5초 읽을 시간을 남긴다
  const [, late] = rowDelays({ start: 0, end: 1.2 }, ["아주 긴 윗줄 설명 문장이에요", "끝"]);
  assert.ok(late <= 0.7 + 1e-9);
});
test("강조어는 도식과 같은 굵은 굵기로, 작은 줄은 보통 굵기로 넘긴다", () => {
  // 시험 영상: 마루 부리가 자막 · 후킹에선 400(스킬 기본), 도식 · 칩에선 700으로 나와 다른 글꼴처럼 보였다
  const fonts = pickSubtitleFonts(FONTS, trial);
  assert.equal(fonts.keyWeight, 700);
  assert.equal(fontWeight(FONTS[0], true), 700);
  assert.equal(fonts.smallWeight, null);
  const file = buildSubtitleFile("video.mp4", trialCues, ["top", "top"], trial, [], [hook], [], fonts);
  const rows = file.lines.flatMap((l) => l.rows as { key?: boolean; weight?: number }[]);
  assert.ok(rows.filter((r) => r.key).every((r) => r.weight === 700), "강조어 줄 · 후킹 굵기");
  assert.ok(rows.filter((r) => !r.key).every((r) => r.weight === undefined), "작은 줄은 줄마다 굵기를 주지 않는다");
  // 한 굵기뿐인 손글씨는 굵기를 지정하지 않는다
  assert.equal("weight" in file.style, false);
  // 굵기가 여럿인 글꼴을 작은 줄에 쓰면 스킬 본문 기본(800) 대신 보통 굵기
  const serifSmall = pickSubtitleFonts(FONTS, { key_font: "그리운 코코초이툰", small_font: "나눔명조" });
  assert.equal(serifSmall.keyWeight, null);
  assert.equal(serifSmall.smallWeight, 400);
  const plain = buildSubtitleFile("video.mp4", trialCues, ["top", "top"], trial, [], [], [], serifSmall);
  assert.equal((plain.style as { weight?: number }).weight, 400);
  assert.ok(plain.lines.flatMap((l) => l.rows as { key?: boolean; weight?: number }[]).filter((r) => r.key).every((r) => r.weight === undefined));
});
test("글꼴을 고르는 에이전트에게 짝 규칙과 굵기 범위를 준다", () => {
  const lines = fontChoiceLines(FONTS);
  assert.match(lines, /마루 부리 · 부리\(명조\) · {2}· 굵기 300~700/);
  assert.match(lines, /이서윤체 · 손글씨 · {2}· 한 굵기/);
  assert.ok(FONT_PAIRING_RULES.some((r) => r.includes("같은 글꼴을 두 번")));
});
test("밝은 펌프와 어두운 배경이 섞인 컷은 평균만 보고 검은 글자로 바꾸지 않는다", () => {
  assert.equal(readableBrightness(Uint8Array.from([70, 70, 250, 250])), null);
  assert.equal(readableBrightness(Uint8Array.from([180, 182, 178, 180])), 180);
  assert.equal(readableBrightness(new Uint8Array()), null);
});

test("예능 모션은 강조어 줄에만 쓰고 테이프 모션에는 테이프 바탕을 같이 넘긴다", () => {
  assert.equal(isMotionEffect("slam"), true);
  assert.equal(isMotionEffect("wave"), true);
  const design: CaptionDesign = { ...trial, key_fx: "slam", small_fx: "shake", finish_fx: "tapeTurn" };
  const file = buildSubtitleFile("video.mp4", trialCues, ["lower", "lower"], design, [], [], [], pickSubtitleFonts(FONTS, trial));
  const first = file.lines[0].rows[0] as Record<string, unknown>;
  assert.equal(first.fx, "slam");
  assert.equal("tape" in first, false);
  // 작은 윗줄에 예능 모션을 고르면 cut으로 둔다. 줄에 고른 모션(tilt)은 강조어 줄에 그대로 쓴다
  const last = file.lines[1].rows as Record<string, unknown>[];
  assert.deepEqual(last.map((r) => r.fx), ["cut", "tilt"]);
  // 마지막 자막의 대표 모션이 테이프면 바탕이 같이 간다
  const tape = buildSubtitleFile("video.mp4", [trialCues[0]], ["lower"], design).lines[0].rows[0] as Record<string, unknown>;
  assert.equal(tape.fx, "tapeTurn");
  assert.deepEqual(tape.tape, { v: 2 });
  // 테이프 위 글자는 강조색이 아니라 어두운 색
  assert.equal(tape.color, "#1B1F27");
  assert.equal("tone" in tape, false);
  // 스킬은 효과음을 자막 파일의 sfx로만 켠다. 편집 키트 효과음과 겹치지 않게 주지 않는다
  assert.equal("sfx" in file, false);
});
test("한 영상의 자막마다 고른 서로 다른 모션을 줄 수 제한 없이 그대로 쓴다", () => {
  // 2026-11-12 사용자 결정: 한 영상에 모션 하나만 고집하지 않고 여러 모션을 조합한다
  const texts = ["이거 진짜예요?", "딱 3일이면", "깜짝 놀랐어요", "매일 아침에 써요", "지금 확인해 보세요"];
  const cues = texts.map((text, i) => ({ id: `c${i}`, text, start: i * 2, end: i * 2 + 1.8, beat: i, emphasis: [] }));
  const picked = ["tilt", "slam", "hop", "", "wave"];
  const design: CaptionDesign = {
    ...trial,
    key_fx: "39",
    finish_fx: "38",
    lines: texts.map((text, no) => ({ no, rows: [{ text, role: "key" as const }], fx: picked[no], spark: false })),
  };
  const file = buildSubtitleFile("video.mp4", cues, cues.map(() => "lower" as const), design, [], [], [], pickSubtitleFonts(FONTS, trial));
  const used = file.lines.map((l) => (l.rows[0] as { fx: string }).fx);
  // 모션을 고르지 않은 줄만 대표 모션. 마지막 자막도 줄에 고른 모션이 먼저다
  assert.deepEqual(used, ["tilt", "slam", "hop", "39", "wave"]);
  assert.equal(new Set(used).size, 5);
});
test("예능 모양은 강조어 줄에 장식과 함께 넘기고 밝은 배경에서는 입히지 않는다", () => {
  const design: CaptionDesign = {
    ...trial,
    key_look: "예능 흰",
    lines: [
      { ...trial.lines[0], look: "매운맛" },
      { ...trial.lines[1], fx: "", look: "예능 골드" },
    ],
  };
  const fonts = pickSubtitleFonts(FONTS, trial);
  const file = buildSubtitleFile("video.mp4", [...trialCues, { id: "c2", text: "끝까지 촉촉해요", start: 14, end: 16, beat: 5, emphasis: [] }], ["lower", "lower", "lower"], design, [], [], [], fonts);
  const rows = file.lines.map((l) => l.rows as Record<string, unknown>[]);
  // 줄에 고른 모양이 먼저, 장식은 코드가 붙인다. 모양을 입힌 줄에는 강조색을 주지 않는다
  assert.equal(rows[0][0].look, "매운맛");
  assert.equal(rows[0][0].fire, true);
  assert.equal("color" in rows[0][0] || "tone" in rows[0][0], false);
  // 작은 줄은 그대로, 강조어 줄은 모양의 짝 모션
  assert.equal("look" in rows[1][0], false);
  assert.equal(rows[1][1].look, "예능 골드");
  assert.equal(rows[1][1].fx, "shine");
  // 줄에 고르지 않은 자막은 영상 전체 모양
  assert.equal(rows[2][0].look, "예능 흰");
  // 붓글씨 글꼴로 바뀌는 모양은 고른 강조어 글꼴을 그대로 넘긴다
  const scary = buildSubtitleFile("video.mp4", [trialCues[0]], ["lower"], { ...trial, key_look: "괴담", lines: [] }, [], [], [], fonts).lines[0].rows[0] as Record<string, unknown>;
  assert.equal(scary.font, fonts.key);
  assert.equal(scary.blood, true);
  // 밝은 배경 자막은 어두운 글자가 먼저다. 없는 모양 이름은 쓰지 않는다
  const bright = buildSubtitleFile("video.mp4", [trialCues[0]], ["lower"], design, [200], [], [], fonts).lines[0].rows[0] as Record<string, unknown>;
  assert.equal("look" in bright, false);
  assert.equal(bright.color, "#1B1F27");
  const unknown = buildSubtitleFile("video.mp4", [trialCues[0]], ["lower"], { ...trial, key_look: "없는 모양", lines: [] }, [], [], [], fonts).lines[0].rows[0] as Record<string, unknown>;
  assert.equal("look" in unknown, false);
  // 예전에 저장된 디자인(모양 값 없음)도 그대로 쓴다
  const old = buildSubtitleFile("video.mp4", trialCues, ["lower", "lower"], trial, [], [], [], fonts);
  assert.ok(old.lines.every((l) => (l.rows as Record<string, unknown>[]).every((r) => !("look" in r))));
});

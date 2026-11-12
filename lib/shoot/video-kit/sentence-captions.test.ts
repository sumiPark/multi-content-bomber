import assert from "node:assert/strict";
import test from "node:test";
import type { EditPlan } from "@/lib/agents/edit-plan";
import { humanPriceLines } from "@/lib/agents/edit-plan";
import { buildSubtitleFile, type CaptionDesign } from "./caption-skill";
import { captionZones } from "./compose";
import { planProblems } from "./pipeline";
import { layoutBeats, snapCuts, timeText, type VoiceClip } from "./timeline";

// 문장 자막 · 컷 맞춤 · 끝 화면 겹침 · 특가 문구 조건(2026-11-12 사람 편집본 비교에서 나온 수정)

const blank = { at_word: "", at: 0, text: "", small: "", sub: "", note: "", chip: "", tone: "", side: "", number: "", unit: "", left: "", right: "", left_value: 0, right_value: 0, items: [], x: 0, y: 0, r: 0, from: "" };
const beat = (tts: string, captions: string[], extra: Partial<EditPlan["beats"][number]> = {}): EditPlan["beats"][number] => ({
  mode: "tts",
  tts,
  captions,
  emphasis: [],
  cuts: [{ clip: 1, in: 0, out: 2, what: "시험" }],
  graphics: [],
  sfx: [],
  ...extra,
});
const planOf = (beats: EditPlan["beats"], style?: EditPlan["caption_style"]): EditPlan =>
  ({ caption_style: style, hook: { on_screen: "오징어 넣지 마세요", highlight: "", position: "top", spoken: "" }, beats, visuals: [], warnings: [] }) as unknown as EditPlan;
const voices = (n: number, seconds = 2): VoiceClip[] => Array.from({ length: n }, () => ({ file: null, fileIn: 0, fileOut: 0, estimated: seconds }));
const design: CaptionDesign = { key_fx: "04", small_fx: "cut", finish_fx: "04", key_font: "", small_font: "", reading: "", lines: [] };

test("문장 자막은 말한 문장을 같은 자리 · 같은 크기의 움직이지 않는 줄로 보여 주고, 큰 강조 자막만 강조어 디자인을 쓴다", () => {
  const plan = planOf([beat("훅", []), beat("물이랑 밀가루는 일대일로 섞어요", ["물이랑 밀가루는 1:1로 섞어요"]), beat("완성", ["K-피자 완성"], { big: true })], "sentence");
  const tl = timeText(plan, layoutBeats(plan, voices(3), new Map([[1, 10]])), [], new Map());
  assert.deepEqual(tl.captions.map((c) => [c.sentence, c.big]), [[true, false], [true, true]]);
  assert.equal(captionZones(tl, null)[0], "lower");
  const file = buildSubtitleFile("video.mp4", tl.captions, ["lower", "lower"], design);
  const [plain, big] = file.lines.map((l) => l.rows as Record<string, unknown>[]);
  assert.equal(plain.map((r) => r.text).join(" "), "물이랑 밀가루는 1:1로 섞어요");
  assert.ok(plain.every((r) => r.fx === "cut" && !("key" in r) && r.size === plain[0].size));
  assert.ok(big.some((r) => r.key === true));
});

test("예전 계획(caption_style 없음)은 자막이 예전 방식 그대로다", () => {
  const plan = planOf([beat("훅", []), beat("촉촉하게 스며들어요", ["촉촉하게 스며들어요"])]);
  const tl = timeText(plan, layoutBeats(plan, voices(2), new Map([[1, 10]])), [], new Map());
  assert.equal(tl.captions[0].sentence, undefined);
  const rows = buildSubtitleFile("video.mp4", tl.captions, ["lower"], design).lines[0].rows as Record<string, unknown>[];
  assert.ok(rows.some((r) => r.key === true));
});

test("0.8초보다 짧게 지나가는 자막 묶음은 글자를 빼지 않고 옆 묶음과 합친다", () => {
  const plan = planOf([beat("훅", []), beat("물이랑 밀가루는 일대일", ["물:밀가루", "1:1"])]);
  const tl = timeText(plan, layoutBeats(plan, voices(2, 1.2), new Map([[1, 10]])), [], new Map());
  assert.deepEqual(tl.captions.map((c) => c.text), ["물:밀가루 1:1"]);
});

test("끝 화면이 있는 비트는 자막을 내지 않고, 마지막 말이 끝나면 0.5초 안에 끝난다", () => {
  const last = beat("댓글 남겨 주세요", ["댓글에 ♥ 남겨 주세요"], { graphics: [{ ...blank, type: "end_card", text: "해물모둠", sub: "댓글에 ♥ 남겨 주세요" }] });
  const plan = planOf([beat("훅", []), beat("하나", ["하나"]), last]);
  const base = layoutBeats(plan, voices(3), new Map([[1, 10]]));
  const tl = timeText(plan, base, [], new Map());
  assert.deepEqual(tl.captions.map((c) => c.text), ["하나"]);
  assert.ok(tl.duration - base.lines[2].end <= 0.51);
  // 끝 화면을 화면에 내지 않는 경로(AI 자동)는 자막을 남긴다
  assert.equal(timeText(plan, base, [], new Map(), { keepEndCardCaptions: true }).captions.length, 2);
  assert.ok(!planProblems(planOf([beat("훅", []), beat("하나", ["하나"])])).some((p) => p.includes("end_card")));
});

test("한 비트 안에서 컷이 바뀌는 시각을 가까운 낱말 시작에 맞춘다", () => {
  const two = beat("오징어링 그리고 새우", ["오징어링 그리고 새우"], { cuts: [{ clip: 1, in: 0, out: 1, what: "오징어링" }, { clip: 1, in: 3, out: 4, what: "새우" }] });
  const plan = planOf([beat("훅", []), two]);
  const base = layoutBeats(plan, voices(2), new Map([[1, 10]]));
  const inner = base.cuts.filter((c) => c.beat === 1);
  const word = Number((inner[0].end + 0.2).toFixed(3));
  const snapped = snapCuts(base, [{ text: "새우", start: word, end: word + 0.4 }], new Map([[1, 10]])).cuts.filter((c) => c.beat === 1);
  assert.ok(Math.abs(snapped[0].end - word) <= 1 / 30);
  assert.equal(snapped[1].start, snapped[0].end);
  assert.equal(snapped[1].end, inner[1].end);
  // 낱말 시각을 모르면 그대로 둔다
  assert.deepEqual(snapCuts(base, [], new Map([[1, 10]])).cuts, base.cuts);
});

test("효과음이 많거나 큰 강조 자막이 3곳을 넘으면 계획을 다시 쓰게 한다", () => {
  const noisy = planOf(Array.from({ length: 6 }, (_, i) => beat("짧은 말을 합니다", ["짧은 말"], { big: true, cuts: [{ clip: i + 1, in: 0, out: 2, what: "시험" }], sfx: [{ name: "pop", at_word: "", at: 0 }] })), "sentence");
  const problems = planProblems(noisy);
  assert.ok(problems.some((p) => p.includes("효과음")));
  assert.ok(problems.some((p) => p.includes("큰 강조 자막")));
});

test("사람이 말하지 않는 직접 촬영은 대본이 25~40초 분량이 아니면 계획을 다시 쓰게 한다", () => {
  // 7자짜리 줄 n개 = 약 n초 분량
  const lines = (n: number) => planOf(Array.from({ length: n }, (_, i) => beat("일이삼사오육칠", ["자막"], { cuts: [{ clip: i + 1, in: 0, out: 2, what: "시험" }] })));
  const length = (n: number, footageSeconds: number) => planProblems(lines(n), { footageSeconds }).filter((p) => p.includes("분량"));
  assert.match(length(21, 60)[0], /약 21초 분량.*짧아요.*25~40초/);
  assert.deepEqual(length(30, 60), []);
  // 어림값이라 10%까지는 넘어간다
  assert.deepEqual(length(23, 60), []);
  assert.deepEqual(length(43, 60), []);
  assert.match(length(46, 60)[0], /길어요/);
  // 촬영본 합계가 25초보다 짧으면 촬영본 합계까지만 요구한다
  assert.deepEqual(length(18, 18.4), []);
  assert.match(length(12, 18.4)[0], /18~40초/);
  // 기준을 주지 않는 경로(AI 자동 · 말하는 영상)는 예전 기준 그대로다
  assert.deepEqual(planProblems(lines(21)).filter((p) => p.includes("분량")), []);
});

test("특가 · 금액은 관리자가 넣은 문구에 있을 때만 쓸 수 있는 문구로 넘긴다", () => {
  assert.deepEqual(humanPriceLines({ brief: "이번 주 특가 중이에요", fixedEnding: "댓글 남겨 주세요" }), ["이번 주 특가 중이에요"]);
  assert.deepEqual(humanPriceLines({ fixedEnding: "지금 19,900원" }), ["지금 19,900원"]);
  assert.deepEqual(humanPriceLines({ brief: "바삭하게 튀기는 법", humanHook: null }), []);
});

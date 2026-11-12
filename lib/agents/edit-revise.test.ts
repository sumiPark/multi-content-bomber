import assert from "node:assert/strict";
import test from "node:test";
import { zodResponseFormat } from "openai/helpers/zod";
import type { EditGraphic, EditPlan } from "@/lib/agents/edit-plan";
import type { ProductFacts } from "@/lib/agents/product-facts";
import type { ContentRule } from "@/lib/rules/check";
import { applyRevision, editRevisionSchema, planView, quotedTexts, restoreQuoted, restoreQuotedInPlan, revisionChanges, revisionPrompt, ruleNotes, type EditRevision, type SavedEditPlan } from "./edit-revise";

// 완성본 고치기 — 계획 적용 · 전 → 후 목록 · 따옴표 글자 되돌리기(2026-11-12). AI 호출 없이 순수 함수만 본다

const blank: EditGraphic = { type: "chip", at_word: "", at: 0, text: "", small: "", sub: "", note: "", chip: "", tone: "", side: "", number: "", unit: "", left: "", right: "", left_value: 0, right_value: 0, items: [], x: 0, y: 0, r: 0, from: "" };
const look = { reading: "", align: "center", treatment: "stroke", text_color: "#FFFFFF", accent_color: "#FFD23F", box_color: "#111111", size: 62, emphasis_scale: 1, emphasis: "color", layout: "inline", reveal: "line", entrance: "fade", tilt: 0, punch: false, behind_word: "", music_query: "bright acoustic guitar", music_intent: "밝고 가벼운 분위기", music: "bgm" };

function samplePlan(): SavedEditPlan {
  const plan = {
    look,
    caption_style: "keyword",
    analysis: [],
    components: [],
    hook: { on_screen: "오징어 넣지 마세요", highlight: "오징어", position: "top", spoken: "오징어 넣지 마세요" },
    thumbnail: { title: "김치전 꿀팁", highlight: "꿀팁", position: "top", sub: "", clip: 1, at: 1 },
    beats: [
      { mode: "tts", tts: "오징어 넣지 마세요", captions: [], emphasis: [], cuts: [{ clip: 1, in: 0.5, out: 2.5, what: "오징어를 든 손" }], graphics: [], sfx: [] },
      { mode: "tts", tts: "새우를 넣으면 훨씬 달아요", captions: ["새우를 넣으면", "훨씬 달아요"], emphasis: ["새우"], cuts: [{ clip: 2, in: 1, out: 4, what: "새우를 올리는 장면" }], graphics: [{ ...blank, type: "chip", text: "새우 한 줌", at_word: "새우" }], sfx: [{ name: "pop", at_word: "새우", at: 0 }] },
      { mode: "tts", tts: "반죽은 얇게 펴 주세요", captions: ["반죽은 얇게"], emphasis: [], cuts: [{ clip: 3, in: 0, out: 3, what: "반죽을 펴는 장면" }, { clip: 3, in: 5, out: 7, what: "뒤집는 장면" }], graphics: [], sfx: [] },
      { mode: "tts", tts: "오늘 저녁에 해 보세요", captions: ["오늘 저녁에 해 보세요"], emphasis: [], cuts: [{ clip: 4, in: 2, out: 5, what: "완성된 김치전" }], graphics: [{ ...blank, type: "end_card", text: "김치전 밀키트" }], sfx: [{ name: "ding", at_word: "", at: 0 }] },
    ],
    visuals: [{ beat: 2, key: "flour", subject: "밀가루 결정", evidence: "", prompt: "", motion: "solid" }],
    warnings: [],
    pickedMusic: { name: "Sunny Ukulele", in: 0, gain_db: -6, source: null, query: "bright acoustic guitar" },
    captionDesign: { key_fx: "04", small_fx: "cut", finish_fx: "04", key_font: "큰 글꼴", small_font: "작은 글꼴", reading: "", lines: [{ no: 0, rows: [{ text: "새우를 넣으면", role: "key" }], fx: "", spark: false }] },
  };
  return plan as unknown as SavedEditPlan;
}

const noChange = (): EditRevision => ({
  hook: { on_screen: null, highlight: null, spoken: null },
  thumbnail: { title: null, highlight: null, sub: null },
  beats: [],
  order: null,
  repick_music: false,
  repick_caption_design: false,
  look: { align: null, treatment: null, text_color: null, accent_color: null, box_color: null, size: null, emphasis_scale: null, emphasis: null, layout: null, reveal: null, entrance: null, tilt: null, punch: null, music_query: null, music_intent: null, music: null },
  footage: [],
  cannot: [],
  notes: [],
});
const beatPatch = (no: number, patch: Partial<EditRevision["beats"][number]> = {}): EditRevision["beats"][number] => ({ no, remove: false, tts: null, captions: null, emphasis: null, big: null, graphics: null, sfx: null, cuts: null, ...patch });

test("고칠 내용에서 따옴표로 적은 글자를 뽑는다", () => {
  assert.deepEqual(quotedTexts(`후킹을 "이거 모르고 사면 손해"로, 표지는 “김치전 3분 컷”, 자막은 '바삭해요', 마지막은 「오늘 해 봐요」로`), ["이거 모르고 사면 손해", "김치전 3분 컷", "바삭해요", "오늘 해 봐요"]);
  assert.deepEqual(quotedTexts("음악을 더 잔잔하게 바꿔 줘"), []);
  assert.equal(restoreQuoted("이거 모르고 사면, 손해!", ["이거 모르고 사면 손해"]), "이거 모르고 사면 손해");
  assert.equal(restoreQuoted("이거 알고 사면 이득", ["이거 모르고 사면 손해"]), "이거 알고 사면 이득");
});

test("바뀐 것이 없으면 계획과 목록이 그대로다", () => {
  const plan = samplePlan();
  const applied = applyRevision(plan, noChange());
  assert.deepEqual(applied.plan, plan);
  assert.deepEqual(revisionChanges(plan, applied), []);
  assert.deepEqual(applied.rejected, []);
  assert.equal(applied.humanHook, null);
});

test("요청한 장면의 글만 바뀌고 나머지 장면은 그대로다", () => {
  const plan = samplePlan();
  const rev = { ...noChange(), beats: [beatPatch(2, { tts: "새우를 넣으면 감칠맛이 살아요", captions: ["새우를 넣으면", "감칠맛이 살아요"] })] };
  const applied = applyRevision(plan, rev);
  assert.equal(applied.plan.beats[1].tts, "새우를 넣으면 감칠맛이 살아요");
  assert.deepEqual([applied.plan.beats[0], applied.plan.beats[2], applied.plan.beats[3]], [plan.beats[0], plan.beats[2], plan.beats[3]]);
  assert.deepEqual(applied.plan.hook, plan.hook);
  assert.deepEqual(applied.plan.pickedMusic, plan.pickedMusic);
  assert.deepEqual(revisionChanges(plan, applied), [
    { label: "2번 장면 읽는 말", before: "새우를 넣으면 훨씬 달아요", after: "새우를 넣으면 감칠맛이 살아요" },
    { label: "2번 장면 자막", before: "새우를 넣으면 / 훨씬 달아요", after: "새우를 넣으면 / 감칠맛이 살아요" },
  ]);
});

test("읽는 말만 바꾸고 자막을 내지 않으면 새 말로 자막을 다시 나눈다", () => {
  const applied = applyRevision(samplePlan(), { ...noChange(), beats: [beatPatch(3, { tts: "반죽은 최대한 얇게 펴서 바삭하게 구워 주세요" })] });
  assert.equal(applied.plan.beats[2].captions.join(" "), "반죽은 최대한 얇게 펴서 바삭하게 구워 주세요");
  assert.ok(applied.plan.beats[2].captions.every((c) => c.length <= 16));
});

test("따옴표로 적은 후킹은 AI가 다듬어도 글자 그대로 넣고, 사람이 정한 글로 저장한다", () => {
  const plan = samplePlan();
  const request = `후킹을 "이거 모르고 사면 손해"로 바꿔 줘`;
  const rev = { ...noChange(), hook: { on_screen: "이거 모르고 사면, 손해!", highlight: "손해", spoken: null } };
  const applied = applyRevision(plan, rev, { quoted: quotedTexts(request) });
  assert.equal(applied.plan.hook.on_screen, "이거 모르고 사면 손해");
  assert.equal(applied.humanHook, "이거 모르고 사면 손해");
  // 사람이 정한 후킹은 워커가 후킹 말 · 첫 장면의 읽는 말에도 그대로 쓴다 — 미리 보기도 같다
  assert.equal(applied.plan.hook.spoken, "이거 모르고 사면 손해");
  assert.equal(applied.plan.beats[0].tts, "이거 모르고 사면 손해");
  assert.deepEqual(revisionChanges(plan, applied).map((c) => c.label), ["후킹 글자", "후킹 강조 낱말", "후킹 말"]);
});

test("따옴표 없이 바꾼 후킹 글자는 고정하지 않지만, 이미 정해 둔 후킹이 있으면 새 글자로 저장한다", () => {
  const rev = { ...noChange(), hook: { on_screen: "새우가 답이에요", highlight: null, spoken: null } };
  const free = applyRevision(samplePlan(), rev);
  assert.equal(free.humanHook, null);
  assert.equal(free.plan.hook.spoken, "오징어 넣지 마세요");
  const pinned = applyRevision(samplePlan(), rev, { pins: { humanHook: "오징어 넣지 마세요" } });
  assert.equal(pinned.humanHook, "새우가 답이에요");
  assert.equal(pinned.plan.beats[0].tts, "새우가 답이에요");
  // AI가 후킹을 바꾸며 첫 장면 자막에도 같은 글을 적으면 비운다(후킹 글자가 화면에 나온다)
  const doubled = applyRevision(samplePlan(), { ...rev, hook: { on_screen: "새우가 답이에요", highlight: null, spoken: "새우가 답이에요" }, beats: [beatPatch(1, { captions: ["새우가 답이에요!"] })] });
  assert.deepEqual(doubled.plan.beats[0].captions, []);
  assert.equal(doubled.plan.beats[0].tts, "새우가 답이에요");
  // 후킹이 정해져 있으면 후킹 말만 따로 바꿀 수 없다
  const spokenOnly = applyRevision(samplePlan(), { ...noChange(), hook: { on_screen: null, highlight: null, spoken: "오징어는 빼 주세요" } }, { pins: { fixedHook: "오징어 넣지 마세요" } });
  assert.equal(spokenOnly.plan.beats[0].tts, "오징어 넣지 마세요");
  assert.equal(spokenOnly.rejected[0].request, "후킹 말");
});

test("컷은 지금 컷 범위 안에서 좁히기 · 빼기 · 순서 바꾸기만 받고, 벗어나면 그 변경만 버린다", () => {
  const plan = samplePlan();
  const ok = applyRevision(plan, { ...noChange(), beats: [beatPatch(3, { cuts: [{ clip: 3, in: 5.5, out: 7, what: "" }, { clip: 3, in: 0.5, out: 2, what: "반죽" }] })] });
  assert.deepEqual(ok.plan.beats[2].cuts, [{ clip: 3, in: 5.5, out: 7, what: "뒤집는 장면" }, { clip: 3, in: 0.5, out: 2, what: "반죽" }]);
  assert.deepEqual(ok.rejected, []);
  assert.deepEqual(revisionChanges(plan, ok), [{ label: "3번 장면 컷", before: "3번 촬영본 0.0~3.0초, 3번 촬영본 5.0~7.0초", after: "3번 촬영본 5.5~7.0초, 3번 촬영본 0.5~2.0초" }]);

  const bad = applyRevision(plan, { ...noChange(), beats: [beatPatch(3, { tts: "반죽은 얇게", cuts: [{ clip: 3, in: 8, out: 10, what: "다른 구간" }] })] });
  assert.deepEqual(bad.plan.beats[2].cuts, plan.beats[2].cuts);
  assert.equal(bad.plan.beats[2].tts, "반죽은 얇게");
  assert.equal(bad.rejected.length, 1);
  assert.equal(bad.rejected[0].request, "3번 장면 컷");
  const otherClip = applyRevision(plan, { ...noChange(), beats: [beatPatch(2, { cuts: [{ clip: 9, in: 0, out: 2, what: "" }] })] });
  assert.deepEqual(otherClip.plan.beats[1].cuts, plan.beats[1].cuts);
  assert.equal(otherClip.rejected.length, 1);
});

test("장면을 빼고 순서를 바꾸면 장면 번호 · AI 이미지 번호가 맞춰지고 목록에 남는다", () => {
  const plan = samplePlan();
  const applied = applyRevision(plan, { ...noChange(), beats: [beatPatch(2, { remove: true })], order: [1, 4, 3] });
  assert.deepEqual(applied.plan.beats.map((b) => b.tts), ["오징어 넣지 마세요", "오늘 저녁에 해 보세요", "반죽은 얇게 펴 주세요"]);
  assert.deepEqual(applied.sceneMap, [0, null, 2, 1]);
  assert.deepEqual(applied.plan.visuals.map((v) => v.beat), [2]);
  assert.equal(applied.plan.redoCaptionLines, true);
  const changes = revisionChanges(plan, applied);
  assert.deepEqual(changes, [
    { label: "장면 순서", before: "1 → 3 → 4", after: "1 → 4 → 3" },
    { label: "2번 장면", before: "새우를 넣으면 훨씬 달아요", after: "빼요" },
  ]);
  // 순서가 맞지 않으면 순서만 버리고 빼기는 반영한다
  const wrong = applyRevision(plan, { ...noChange(), beats: [beatPatch(2, { remove: true })], order: [1, 4] });
  assert.deepEqual(wrong.plan.beats.map((b) => b.tts), ["오징어 넣지 마세요", "반죽은 얇게 펴 주세요", "오늘 저녁에 해 보세요"]);
  assert.equal(wrong.rejected[0].request, "장면 순서");
  const all = applyRevision(plan, { ...noChange(), beats: [1, 2, 3, 4].map((no) => beatPatch(no, { remove: true })) });
  assert.equal(all.plan.beats.length, 4);
});

test("그래픽 · 효과음을 고치면 그 장면만 바뀌고 목록에 전 → 후가 남는다", () => {
  const plan = samplePlan();
  const applied = applyRevision(plan, { ...noChange(), beats: [beatPatch(2, { graphics: [{ ...blank, type: "chip", text: "새우 두 줌", at_word: "새우" }], sfx: [] })] });
  assert.deepEqual(revisionChanges(plan, applied), [
    { label: "2번 장면 화면 문구", before: "표시 줄 “새우 한 줌”", after: "표시 줄 “새우 두 줌”" },
    { label: "2번 장면 효과음", before: "팝(“새우”에서)", after: "없음" },
  ]);
  // 첫 장면에는 후킹 글자가 나와 다른 그래픽을 넣지 않는다
  const first = applyRevision(plan, { ...noChange(), beats: [beatPatch(1, { graphics: [{ ...blank, type: "badge", text: "주의" }] })] });
  assert.deepEqual(first.plan.beats[0].graphics, []);
  assert.equal(first.rejected.length, 1);
});

test("음악 · 자막 모양을 다시 고르면 저장된 값을 지우고 목록에 다시 골라요로 보인다", () => {
  const plan = samplePlan();
  const rev = { ...noChange(), repick_caption_design: true, look: { ...noChange().look, music_query: "calm soft piano", music_intent: "더 잔잔하고 차분한 분위기" } };
  const applied = applyRevision(plan, rev);
  assert.equal(applied.repickMusic, true);
  assert.equal(applied.plan.pickedMusic, undefined);
  assert.equal(applied.plan.captionDesign, undefined);
  assert.equal(applied.plan.look.music_query, "calm soft piano");
  assert.deepEqual(revisionChanges(plan, applied), [
    { label: "배경 음악", before: "Sunny Ukulele", after: "다시 골라요 (더 잔잔하고 차분한 분위기)" },
    { label: "자막 모양 · 글꼴", before: "큰 글꼴 · 작은 글꼴", after: "다시 골라요" },
  ]);
  // 요청하지 않으면 음악 · 자막 디자인은 그대로다
  const kept = applyRevision(plan, { ...noChange(), look: { ...noChange().look, accent_color: "#ff5a5f", text_color: "파랑" } });
  assert.deepEqual(kept.plan.pickedMusic, plan.pickedMusic);
  assert.deepEqual(kept.plan.captionDesign, plan.captionDesign);
  assert.equal(kept.plan.look.accent_color, "#FF5A5F");
  assert.equal(kept.plan.look.text_color, "#FFFFFF");
  assert.equal(kept.rejected[0].request, "글자색");
  assert.deepEqual(revisionChanges(plan, kept), [{ label: "글자 디자인", before: "강조색 #FFD23F", after: "강조색 #FF5A5F" }]);
});

test("계정에 정해 둔 끝 문구가 있으면 마지막 말은 바뀌지 않고 이유가 남는다", () => {
  const plan = samplePlan();
  plan.beats[3] = { ...plan.beats[3], tts: "댓글로 알려 주세요", captions: ["댓글로 알려 주세요"] };
  const applied = applyRevision(plan, { ...noChange(), beats: [beatPatch(4, { tts: "지금 바로 주문하세요", captions: ["지금 바로 주문하세요"] })] }, { pins: { fixedEnding: "댓글로 알려 주세요" } });
  assert.equal(applied.plan.beats[3].tts, "댓글로 알려 주세요");
  assert.equal(applied.rejected[0].request, "마지막 말");
  assert.deepEqual(revisionChanges(plan, applied), []);
});

test("새로 들어간 글이 광고 문구 규칙에 어긋나면 참고에 남긴다", () => {
  const plan = samplePlan();
  const rules: ContentRule[] = [
    { id: "1", scope: "ALL", ruleType: "BANNED", phrase: "최고", matchType: "CONTAINS", reason: "최상급 표현", suggestion: null },
    { id: "2", scope: "ALL", ruleType: "REQUIRED", phrase: "개인차", matchType: "CONTAINS", reason: null, suggestion: null },
  ];
  const facts = { kind: "FOOD" as const, approvedClaims: [], healthFunctional: null, certifiedFunctions: [] };
  const request = `3번 자막을 "최고의 바삭함"으로`;
  const applied = applyRevision(plan, { ...noChange(), beats: [beatPatch(3, { captions: ["최고의 바삭함!"] })] }, { quoted: quotedTexts(request) });
  assert.deepEqual(applied.plan.beats[2].captions, ["최고의 바삭함"]);
  const notes = ruleNotes(plan, applied.plan, { facts, rules, quoted: quotedTexts(request) });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /최고의 바삭함.*최상급 표현.*따옴표로 적은 글이라 그대로 넣었어요/);
  // 바뀌지 않은 글은 다시 보지 않는다
  assert.deepEqual(ruleNotes(plan, plan, { facts, rules }), []);
});

test("다시 세운 계획에서도 따옴표 글자를 되돌리고, 지난 계획에 있던 글은 건드리지 않는다", () => {
  const prev = samplePlan();
  const next = samplePlan() as EditPlan;
  next.beats[1] = { ...next.beats[1], tts: "새우 넣으면, 훨씬 달아요!" };
  next.beats[2] = { ...next.beats[2], captions: ["반죽은 얇게"] };
  const fixed = restoreQuotedInPlan(next, ["새우 넣으면 훨씬 달아요", "반죽은, 얇게"], prev);
  assert.equal(fixed.beats[1].tts, "새우 넣으면 훨씬 달아요");
  assert.deepEqual(fixed.beats[2].captions, ["반죽은 얇게"]);
});

test("AI에게 보여 주는 계획은 장면 번호를 1부터 붙이고, 답 형식은 strict JSON Schema로 만들어진다", () => {
  const view = planView(samplePlan());
  assert.match(view, /^장면 4개:$/m);
  assert.match(view, /^1\. \{"mode":"tts","tts":"오징어 넣지 마세요"/m);
  assert.match(view, /배경 음악: "Sunny Ukulele"/);
  const facts = { id: "p", name: "김치전 밀키트", rawName: "[무료배송] 김치전 밀키트", shop: "쿠마마켓", kind: "FOOD", kindLabel: "식품", price: 9900, stockStatus: "available", url: "", detailImages: 0, oneLine: null, usage: null, cautions: null, details: {}, claims: [], uncertainties: [], healthFunctional: false, approvedClaims: [], certifiedFunctions: [], sourceText: "상세페이지 원문" } as ProductFacts;
  const rules: ContentRule[] = [
    { id: "1", scope: "ALL", ruleType: "BANNED", phrase: "최고", matchType: "CONTAINS", reason: "최상급 표현", suggestion: "구체적인 특징으로" },
    { id: "2", scope: "COSMETIC", ruleType: "BANNED", phrase: "재생", matchType: "CONTAINS", reason: null, suggestion: null },
  ];
  const prompt = revisionPrompt({ service: null, accountName: "joongdi", facts, rules, plan: samplePlan(), request: " 음악을 더 잔잔하게 ", pins: { fixedHook: "오징어 넣지 마세요", fixedEnding: "댓글로 알려 주세요" }, tone: "친근한 수다체" });
  assert.match(prompt.system, /후킹은 사람이 정한 글 "오징어 넣지 마세요"로 고정돼 있다/);
  assert.match(prompt.system, /끝 문구 "댓글로 알려 주세요"로 고정돼 있다/);
  assert.match(prompt.system, /- 최고 — 최상급 표현 → 구체적인 특징으로/);
  // 다른 상품 종류의 규칙 · 상세페이지 원문은 넣지 않는다
  assert.doesNotMatch(prompt.system, /재생 —|- 재생$/m);
  assert.doesNotMatch(prompt.system, /상세페이지 원문|무료배송/);
  assert.match(prompt.system, /친근한 수다체/);
  assert.match(prompt.user, /고칠 내용:\n"""\n음악을 더 잔잔하게\n"""$/);
  const format = zodResponseFormat(editRevisionSchema, "edit_revision");
  assert.equal(format.json_schema.strict, true);
  assert.equal(editRevisionSchema.safeParse(noChange()).success, true);
});

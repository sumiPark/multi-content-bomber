import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cardMatches, knowledgeBlock, knowledgeEvidence } from "@/lib/agents/knowledge";
import { cleanStatement } from "@/lib/agents/knowledge-draft";
import { charRange, storyboardProblems, type Storyboard } from "@/lib/agents/storyboard";
import { cropPixels } from "@/lib/auto-video/gif-clips";

const scene = (over: Partial<Storyboard["scenes"][number]>): Storyboard["scenes"][number] => ({
  part: "knowledge",
  evidence: ["K1"],
  source: "photo",
  source_id: "p1",
  motion: null,
  shows: "",
  say: "가나다라마바사아자차카타파하가나다라",
  tts: "가나다라마바사아자차카타파하가나다라",
  captions: [],
  emphasis: [],
  graphics: [],
  ...over,
});

function board(scenes: Storyboard["scenes"], over: Partial<Storyboard> = {}): Storyboard {
  return {
    selling_point: "",
    story: "",
    question_reason: "",
    photos: [
      { id: "p1", usable: true, kind: "product", what: "", trim_top: 0, trim_bottom: 0 },
      { id: "p2", usable: true, kind: "product", what: "", trim_top: 0, trim_bottom: 0 },
    ],
    gifs: [{ id: "g1", usable: true, what: "", crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1 }],
    product_first_scene: 1,
    hook: { purpose: "curiosity", answer: "답", evidence_scenes: [1], spoken: "가나다", on_screen: "가나다", highlight: "", position: "top" },
    scenes,
    visuals: [],
    thumbnail: { title: "", highlight: "", position: "top", sub: "", scene: 0 },
    caption: { text: "", keywords: [] },
    look: {} as Storyboard["look"],
    key_font: "",
    small_font: "",
    ...over,
  };
}

const knowledge = {
  cards: [{ ref: "K1", id: "1", topic: "PDRN", statement: "소듐디엔에이는 DNA의 소듐염이다", sourceTitle: "성분사전", sourceUrl: "https://example.com" }],
  differences: [{ ref: "D1", id: "2", difference: "거품 밀도가 높아요", compareTo: "일반 버블토너", evidence: "상세" }],
};

// 18자 × 25장면 = 450자
function goodScenes(): Storyboard["scenes"] {
  return Array.from({ length: 25 }, (_, i) => {
    if (i === 0) return scene({ part: "hook", evidence: [], source: "photo", source_id: "p1" });
    if (i === 24) return scene({ part: "takeaway", evidence: [], source: "photo", source_id: "p1" });
    if (i >= 16 && i < 20) return scene({ part: "product", evidence: ["P"], source: i % 2 ? "photo" : "gif", source_id: i % 2 ? "p1" : "g1" });
    if (i >= 20) return scene({ part: "difference", evidence: ["D1"], source: i % 2 ? "photo" : "gif", source_id: i % 2 ? "p2" : "g1" });
    return scene({ source: "visual", source_id: `v${i}` });
  });
}

function goodBoard(): Storyboard {
  const scenes = goodScenes();
  return board(scenes, { visuals: scenes.flatMap((s, i) => (s.source === "visual" ? [{ beat: i, key: `k${i}`, subject: "", evidence: "", prompt: "p", motion: "solid" as const }] : [])) });
}

const limits: [number, number] = [445, 630];
const problems = (b: Storyboard, k = knowledge) => storyboardProblems(b, [], false, { knowledge: k, charLimits: limits });

describe("60~85초 장면표 점검", () => {
  it("음성 속도에 맞는 글자 수를 계산한다", () => {
    assert.deepEqual(charRange(7.4), [444, 629]);
  });

  it("구조를 지킨 장면표는 길이 · 구조 문제가 없다", () => {
    const out = problems(goodBoard());
    assert.deepEqual(out.filter((p) => !p.includes("번 썼다")), []);
  });

  it("15~25초 분량의 짧은 장면표를 잡는다", () => {
    const out = problems(board(goodScenes().slice(0, 7)));
    assert.equal(out.some((p) => p.includes("장면이 7개")), true);
    assert.equal(out.some((p) => p.includes("자로 쓴다")), true);
  });

  it("상품 이름이 너무 늦게 나오면 잡는다", () => {
    assert.equal(problems({ ...goodBoard(), product_first_scene: 20 }).some((p) => p.includes("40% 안쪽")), true);
  });

  it("확정된 차이가 없으면 우리 차이 장면을 쓰지 못한다", () => {
    const out = problems(goodBoard(), { ...knowledge, differences: [] });
    assert.equal(out.some((p) => p.includes("difference 장면을 쓰지 않는다")), true);
    assert.equal(out.some((p) => p.includes("근거 D1는 받은 자료에 없다")), true);
  });

  it("확정된 차이가 있는데 차이 장면이 없으면 잡는다", () => {
    const scenes = goodScenes().map((s) => (s.part === "difference" ? { ...s, part: "product" as const, evidence: ["P"] } : s));
    assert.equal(problems({ ...goodBoard(), scenes }).some((p) => p.includes("difference 장면이 없다")), true);
  });

  it("설명 화면이 많거나 연달아 나오면 잡는다", () => {
    const motion = { kind: "big_fact", title: "", left_label: "", right_label: "", left_value: "", right_values: [], number_to: 0, unit: "", end_text: "", items: [], big: "값", accent: "#E04E08" } as const;
    const scenes = goodScenes().map((s, i) => (i >= 2 && i < 12 ? { ...s, source: "motion" as const, source_id: `m${i}`, motion: { ...motion, right_values: [], items: [] } } : s));
    const out = problems({ ...goodBoard(), scenes });
    assert.equal(out.some((p) => p.includes("25% 이하")), true);
    assert.equal(out.some((p) => p.includes("연달아 쓴다")), true);
  });

  it("받지 않은 근거 번호를 잡는다", () => {
    const scenes = goodScenes();
    scenes[3] = { ...scenes[3], evidence: ["K9"] };
    assert.equal(problems({ ...goodBoard(), scenes }).some((p) => p.includes("K9")), true);
  });

  it("마지막 장면이 기억할 기준이 아니면 잡는다", () => {
    const scenes = goodScenes();
    scenes[24] = { ...scenes[24], part: "product", evidence: ["P"] };
    assert.equal(problems({ ...goodBoard(), scenes }).some((p) => p.includes("takeaway")), true);
  });
});

describe("상식 카드 찾기", () => {
  it("주제나 찾을 낱말이 상품 자료에 있으면 맞다", () => {
    assert.equal(cardMatches({ topic: "PDRN", terms: ["소듐디엔에이"] }, "성분소듐디엔에이글리세린"), true);
    assert.equal(cardMatches({ topic: "pdrn", terms: [] }, "연어pdrn토너"), true);
    assert.equal(cardMatches({ topic: "카라카라", terms: [] }, "부사사과"), false);
    assert.equal(cardMatches({ topic: "가", terms: [] }, "가나다"), false);
  });

  it("근거가 없으면 지어내지 말라고 알린다", () => {
    const text = knowledgeBlock({ cards: [], differences: [] });
    assert.ok(text.includes("우리가 다르다는 말을 하지 않고"));
    assert.equal(knowledgeEvidence({ cards: [], differences: [] }), "");
  });

  it("점검 글에 카드와 차이가 들어간다", () => {
    const text = knowledgeEvidence(knowledge);
    assert.ok(text.includes("K1: 소듐디엔에이"));
    assert.ok(text.includes("D1: 거품 밀도"));
  });
});

describe("초안 문장 다듬기", () => {
  it("문장 끝의 출처 링크를 지운다", () => {
    assert.equal(cleanStatement("부사는 후지의 다른 이름이에요. ([rda.go.kr](https://rda.go.kr/a?utm_source=openai))"), "부사는 후지의 다른 이름이에요.");
    assert.equal(cleanStatement("그대로 둔다 (괄호)"), "그대로 둔다 (괄호)");
  });
});

describe("움직이는 이미지 자르기", () => {
  it("비율을 짝수 픽셀로 바꾼다", () => {
    assert.deepEqual(cropPixels({ w: 760, h: 1530 }, { crop_x: 0.1, crop_y: 0.5, crop_w: 0.5, crop_h: 0.25 }), { x: 76, y: 765, w: 380, h: 382 });
  });

  it("너무 작은 구역이면 전체를 쓴다", () => {
    assert.deepEqual(cropPixels({ w: 400, h: 711 }, { crop_x: 0, crop_y: 0, crop_w: 0.1, crop_h: 0.1 }), { x: 0, y: 0, w: 400, h: 710 });
  });

  it("범위를 벗어난 값을 줄인다", () => {
    const c = cropPixels({ w: 400, h: 400 }, { crop_x: 0.8, crop_y: -1, crop_w: 2, crop_h: 2 });
    assert.ok(c.x + c.w <= 400);
    assert.equal(c.y, 0);
  });
});

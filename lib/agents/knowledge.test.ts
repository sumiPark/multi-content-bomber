import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { approvedFirst, cardMatches, COMMON_KNOWLEDGE_REF, evidenceRef, knowledgeBlock, knowledgeEvidence } from "@/lib/agents/knowledge";
import { cleanStatement } from "@/lib/agents/knowledge-draft";
import { charRange, repairEdgeVisuals, repairOverflow, repeatLimit, sentenceEnding, storyboardProblems, type Storyboard } from "@/lib/agents/storyboard";
import { cropPixels, gifRange } from "@/lib/auto-video/gif-clips";
import { stripFlaggedGraphics } from "@/lib/auto-video/make";

const scene = (over: Partial<Storyboard["scenes"][number]>): Storyboard["scenes"][number] => ({
  part: "knowledge",
  evidence: ["K1"],
  source: "photo",
  source_id: "p1",
  stock_query: "",
  motion: null,
  shows: "",
  say: "가나다라마바사아자차카타파하가나다라",
  tts: "가나다라마바사아자차카타파하가나다라",
  captions: [],
  emphasis: [],
  graphics: [],
  sfx: [],
  ...over,
});

function board(scenes: Storyboard["scenes"], over: Partial<Storyboard> = {}): Storyboard {
  return {
    selling_point: "",
    story: "",
    question_reason: "",
    situation: "",
    worry: "",
    one_thing: "",
    photos: [
      { id: "p1", usable: true, kind: "product", what: "", trim_top: 0, trim_bottom: 0, upright: true },
      { id: "p2", usable: true, kind: "product", what: "", trim_top: 0, trim_bottom: 0, upright: true },
      { id: "p3", usable: true, kind: "product", what: "", trim_top: 0, trim_bottom: 0, upright: false },
    ],
    gifs: [{ id: "g1", usable: true, what: "", crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1, start_sec: 0, end_sec: 4 }],
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
  cards: [{ ref: "K1", id: "1", topic: "PDRN", statement: "소듐디엔에이는 DNA의 소듐염이다", sourceTitle: "성분사전", sourceUrl: "https://example.com", approved: true }],
  differences: [{ ref: "D1", id: "2", difference: "거품 밀도가 높아요", compareTo: "일반 버블토너", evidence: "상세" }],
};

// 18자 × 25장면 = 450자
function goodScenes(): Storyboard["scenes"] {
  return Array.from({ length: 25 }, (_, i) => {
    const say = `장면${i}의 다른 말끝${i}번`;
    return { ...goodScene(i), say };
  });
}

function goodScene(i: number): Storyboard["scenes"][number] {
  return (() => {
    if (i === 0) return scene({ part: "situation", evidence: [], source: "photo", source_id: "p1" });
    if (i === 1 || i === 2) return scene({ part: "worry", evidence: [], source: "visual", source_id: `v${i}` });
    if (i === 24) return scene({ part: "takeaway", evidence: [], source: "photo", source_id: "p1" });
    if (i >= 16 && i < 20) return scene({ part: "product", evidence: ["P"], source: i % 2 ? "photo" : "gif", source_id: i % 2 ? "p1" : "g1" });
    if (i >= 20) return scene({ part: "difference", evidence: ["D1"], source: i % 2 ? "photo" : "gif", source_id: i % 2 ? "p2" : "g1" });
    return scene({ source: "visual", source_id: `v${i}` });
  })();
}

function goodBoard(): Storyboard {
  const scenes = goodScenes();
  return board(scenes, { visuals: scenes.flatMap((s, i) => (s.source === "visual" ? [{ beat: i, key: `k${i}`, subject: "", evidence: "", prompt: "p", motion: "solid" as const }] : [])) });
}

const limits: [number, number] = [222, 630];
const problems = (b: Storyboard, k = knowledge) => storyboardProblems(b, [], false, { knowledge: k, charLimits: limits });

describe("설명 영상 장면표 점검", () => {
  it("음성 속도에 맞는 글자 수를 계산한다", () => {
    assert.deepEqual(charRange(7.4), [222, 629]);
  });

  it("구조를 지킨 장면표는 길이 · 구조 문제가 없다", () => {
    const out = problems(goodBoard());
    assert.deepEqual(out.filter((p) => !p.includes("번 썼다")), []);
  });

  it("너무 짧은 장면표를 잡는다", () => {
    const out = problems(board(goodScenes().slice(0, 7)));
    assert.equal(out.some((p) => p.includes("장면이 7개")), true);
    assert.equal(out.some((p) => p.includes("자로 쓴다")), true);
  });

  it("1분을 채우지 않은 짧은 설명 영상도 통과한다", () => {
    const scenes = goodScenes().filter((_, i) => i === 0 || i === 24 || (i >= 16 && i < 24) || (i >= 1 && i < 6));
    const visuals = scenes.flatMap((s, i) => (s.source === "visual" ? [{ beat: i, key: `k${i}`, subject: "", evidence: "", prompt: "p", motion: "solid" as const }] : []));
    const out = problems(board(scenes, { visuals }));
    assert.equal(out.some((p) => p.includes("자로 쓴다") || p.includes("장면이 ")), false);
  });

  it("마지막 장면의 AI 이미지는 똑바로 선 상품 사진으로 바꾼다", () => {
    const scenes = goodScenes();
    scenes[24] = { ...scenes[24], source: "visual", source_id: "v24" };
    const visuals = [{ beat: 24, key: "a", subject: "", evidence: "", prompt: "p", motion: "solid" as const }, { beat: 3, key: "b", subject: "", evidence: "", prompt: "p", motion: "solid" as const }];
    const fixed = repairEdgeVisuals(board(scenes, { visuals, photos: [{ id: "p3", usable: true, kind: "product", what: "", trim_top: 0, trim_bottom: 0, upright: false }, { id: "p1", usable: true, kind: "product", what: "", trim_top: 0, trim_bottom: 0, upright: true }] }));
    assert.equal(fixed.scenes[24].source, "photo");
    assert.equal(fixed.scenes[24].source_id, "p1");
    assert.deepEqual(fixed.visuals.map((v) => v.beat), [3]);
  });

  it("눕힌 제품 사진은 쓰지 못한다", () => {
    const scenes = goodScenes();
    scenes[17] = { ...scenes[17], source: "photo", source_id: "p3" };
    assert.equal(problems({ ...goodBoard(), scenes }).some((p) => p.includes("p3는 쓸 수 있는 후보가 아니다")), true);
  });

  it("같은 말끝이 반복되면 잡는다", () => {
    assert.equal(sentenceEnding("성분표에 이렇게 적혀 있어요."), "적혀있어요");
    const scenes = goodScenes().map((s) => ({ ...s, say: "소듐디엔에이로 적혀 있어요." }));
    assert.equal(problems({ ...goodBoard(), scenes }).some((p) => p.includes("같은 말끝")), true);
  });

  it("같은 설명 화면을 되풀이하면 잡는다", () => {
    const motion = { kind: "big_fact", title: "전성분", left_label: "", right_label: "", left_value: "", right_values: [], number_to: 0, unit: "", end_text: "", items: [], big: "성분명", accent: "#E04E08" } as const;
    const scenes = goodScenes();
    for (const i of [3, 8]) scenes[i] = { ...scenes[i], source: "motion", source_id: `m${i}`, motion: { ...motion, right_values: [], items: [] } };
    assert.equal(problems({ ...goodBoard(), scenes }).some((p) => p.includes("되풀이")), true);
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

  it("첫 장면은 상황이어야 하고, AI 이미지(생활 장면)를 쓸 수 있다", () => {
    const scenes = goodScenes();
    scenes[0] = { ...scenes[0], source: "visual", source_id: "v0" };
    const visuals = [...goodBoard().visuals, { beat: 0, key: "s", subject: "", evidence: "", prompt: "p", motion: "solid" as const }];
    assert.equal(problems({ ...goodBoard(), scenes, visuals }).some((p) => p.includes("AI 이미지")), false);
    assert.equal(repairEdgeVisuals({ ...goodBoard(), scenes, visuals }).scenes[0].source, "visual");
    scenes[0] = { ...scenes[0], part: "knowledge", evidence: ["K1"] };
    assert.equal(problems({ ...goodBoard(), scenes, visuals }).some((p) => p.includes("상황(situation)으로 시작")), true);
  });

  it("고민 장면이 없거나 상품 뒤에 오면 잡는다", () => {
    const none = goodScenes().map((s) => (s.part === "worry" ? { ...s, part: "knowledge" as const } : s));
    assert.equal(problems({ ...goodBoard(), scenes: none }).some((p) => p.includes("고민(worry) 장면이 없다")), true);
    const late = goodScenes();
    late[21] = { ...late[21], part: "worry", evidence: [] };
    assert.equal(problems({ ...goodBoard(), scenes: late }).some((p) => p.includes("product) 장면보다 앞에")), true);
  });

  it("스톡 영상은 개수 · 구간 제한 없이 쓰고, 검색어만 확인한다", () => {
    const stock = (s: Storyboard["scenes"][number], q = "hands washing") => ({ ...s, source: "stock" as const, source_id: "", stock_query: q });
    const many = goodScenes();
    for (const i of [1, 4, 6, 8, 10, 17]) many[i] = stock(many[i]);
    assert.deepEqual(problems({ ...goodBoard(), scenes: many }).filter((p) => p.includes("스톡")), []);
    many[5] = stock(many[5], "");
    assert.equal(problems({ ...goodBoard(), scenes: many }).some((p) => p.includes("5번 장면에 스톡 검색어")), true);
  });

  it("같은 소재 횟수는 쓸 수 있는 소재가 적을수록 늘어난다", () => {
    assert.equal(repeatLimit(10, 25), 2);
    assert.equal(repeatLimit(3, 25), 4);
    assert.equal(repeatLimit(1, 25), 4);
    assert.equal(repeatLimit(0, 25), 2);
  });

  it("같은 소재가 연달아 나오면 뒤 장면을 바꾸고, 첫 장면 · 마지막 장면은 바꾸지 않는다", () => {
    // 횟수 한도에 걸리지 않게 나머지는 스톡으로 두고, 소재마다 두 번씩만 붙여 쓴다
    const scenes: Storyboard["scenes"] = goodScenes().map((s, i) => ({ ...s, source: "stock", source_id: `s${i}`, stock_query: "q" }));
    const last = scenes.length - 1;
    for (const [i, id] of [[0, "p1"], [1, "p1"], [10, "p2"], [11, "p2"], [last - 1, "g1"], [last, "g1"]] as const) scenes[i] = { ...scenes[i], source: id.startsWith("g") ? "gif" : "photo", source_id: id };
    const fixed = repairOverflow({ ...goodBoard(), scenes, visuals: [] }, []);
    assert.deepEqual(fixed.converted, [1, 11, last - 1]);
  });

  it("실물 소재가 1개뿐이면 상품 구간 실물 장면은 1개만 있어도 된다", () => {
    const one = { ...goodBoard(), photos: goodBoard().photos.map((p, i) => ({ ...p, usable: i === 0 })), gifs: goodBoard().gifs.map((g) => ({ ...g, usable: false })) };
    const real = (s: Storyboard["scenes"][number]) => (s.part === "product" || s.part === "difference") && ["photo", "gif", "archive"].includes(s.source);
    let kept = 0;
    one.scenes = one.scenes.map((s) => (real(s) && kept++ >= 1 ? { ...s, source: "stock" as const, source_id: "s", stock_query: "q" } : s));
    assert.equal(problems(one).some((p) => p.includes("장면 이상 쓴다")), false);
  });

  it("횟수를 넘는 같은 소재와 넘치는 설명 화면은 코드가 AI 이미지로 바꾼다", () => {
    const steps = { kind: "steps" as const, title: "t", left_label: "", right_label: "", left_value: "", right_values: [], number_to: 0, unit: "", end_text: "", items: ["a", "b"], big: "" } as unknown as Storyboard["scenes"][number]["motion"];
    const scenes = goodScenes();
    // p1을 상식 장면 3곳에 더 써서 7번이 된다(한도 4)
    for (const i of [3, 5, 7]) scenes[i] = { ...scenes[i], source: "photo", source_id: "p1" };
    // 설명 화면 7개(25장면의 25%는 6개)
    for (const i of [8, 9, 10, 11, 12, 13, 14]) scenes[i] = { ...scenes[i], source: "motion", source_id: `m${i}`, motion: steps };
    const b = { ...goodBoard(), scenes };
    b.visuals = b.visuals.filter((v) => scenes[v.beat].source === "visual");
    const fixed = repairOverflow(b, []);
    assert.equal(fixed.limit, 4);
    // 상품 · 마지막 장면은 두고 뒤쪽 상식 장면부터 바꾼다
    assert.deepEqual(fixed.converted.filter((i) => i < 8), [3, 5, 7]);
    assert.equal(fixed.converted.filter((i) => i >= 8).length, 1);
    for (const i of fixed.converted) assert.equal(fixed.board.scenes[i].source, "visual");
    assert.equal(fixed.board.scenes[24].source, "photo");
    const left = problems({ ...fixed.board, visuals: [...fixed.board.visuals, ...fixed.converted.map((i) => ({ beat: i, key: `x${i}`, subject: "", evidence: "", prompt: "p", motion: "solid" as const }))] });
    assert.equal(left.some((p) => p.includes("번 썼다") || p.includes("설명 화면이")), false);
  });

  it("글자 수가 완성본 길이 여유(3초) 안에서 모자라면 다시 쓰게 하지 않는다", () => {
    const short = (n: number) => goodScenes().map((s, i) => ({ ...s, tts: i === 0 ? "가".repeat(n) : "나".repeat(8) }));
    // 8자 × 24장면 = 192자. 첫 장면으로 합계를 맞춘다. 하한 222, 여유 22자
    assert.equal(problems({ ...goodBoard(), scenes: short(222 - 192 - 10) }).some((p) => p.includes("자로 쓴다")), false);
    assert.equal(problems({ ...goodBoard(), scenes: short(222 - 192 - 30) }).some((p) => p.includes("자로 쓴다")), true);
  });

  it("판매자 목소리(저희)는 우리 차이 장면에서만 쓴다", () => {
    const scenes = goodScenes();
    scenes[21] = { ...scenes[21], say: "저희는 고를 때 거품 밀도를 봐요" };
    assert.equal(problems({ ...goodBoard(), scenes }).some((p) => p.includes("판매자 목소리")), false);
    scenes[18] = { ...scenes[18], say: "저희가 직접 골랐어요" };
    assert.equal(problems({ ...goodBoard(), scenes }).some((p) => p.includes("18번 장면에서 판매자 목소리")), true);
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

  it("승인된 카드를 앞에 두고, 같은 상태 안에서는 순서를 지킨다", () => {
    const rows = [{ id: "a", status: "DRAFT" }, { id: "b", status: "APPROVED" }, { id: "c", status: "DRAFT" }, { id: "d", status: "APPROVED" }];
    assert.deepEqual(approvedFirst(rows).map((r) => r.id), ["b", "d", "a", "c"]);
  });

  it("승인 전 초안 카드는 표시하고, 일반 상식을 쓰는 법을 알린다", () => {
    const text = knowledgeBlock({ cards: [knowledge.cards[0], { ...knowledge.cards[0], ref: "K2", approved: false }], differences: [] });
    assert.ok(text.includes("- K1 [PDRN]"));
    assert.ok(text.includes("- K2 (승인 전 초안) [PDRN]"));
    assert.ok(text.includes(`"${COMMON_KNOWLEDGE_REF}"`));
  });

  it("근거 칸은 번호만, 일반 상식은 그대로 본다", () => {
    assert.equal(evidenceRef("P: 상세 문구"), "P");
    assert.equal(evidenceRef(" K1 소듐디엔에이"), "K1");
    assert.equal(evidenceRef("일반 상식 — 각질은 자연스럽게 떨어진다"), COMMON_KNOWLEDGE_REF);
  });

  it("장면 근거에 일반 상식을 쓸 수 있다", () => {
    const scenes = goodScenes();
    scenes[5] = { ...scenes[5], evidence: [COMMON_KNOWLEDGE_REF] };
    assert.equal(problems(board(scenes)).some((p) => p.includes("받은 자료에 없다")), false);
    scenes[5] = { ...scenes[5], evidence: ["K9"] };
    assert.equal(problems(board(scenes)).some((p) => p.includes("근거 K9는 받은 자료에 없다")), true);
  });

  it("점검 글에 카드와 차이가 들어간다", () => {
    const text = knowledgeEvidence(knowledge);
    assert.ok(text.includes("K1: 소듐디엔에이"));
    assert.ok(text.includes("D1: 거품 밀도"));
  });
});

describe("화면 그래픽 근거", () => {
  const graphic = (type: string, text: string, small = "") => ({ type, text, small, sub: "", note: "", chip: "", number: "", unit: "", left: "", right: "", from: "", items: [] }) as unknown as Storyboard["scenes"][number]["graphics"][number];
  const withGraphics = () => {
    const scenes = goodScenes();
    scenes[3] = { ...scenes[3], graphics: [graphic("badge", "비타민 B12", "전성분 표기"), graphic("chip", "미세거품")] };
    scenes[24] = { ...scenes[24], graphics: [graphic("end_card", "성분표부터 보세요")] };
    return board(scenes);
  };

  it("걸린 그래픽만 빼고 말은 그대로 둔다", () => {
    const b = withGraphics();
    const out = stripFlaggedGraphics(b, [{ kind: "grounding", detail: '근거 없음: "전성분 표기 비타민 B12" — 표기가 달라요' }]);
    assert.equal(out.removed, 1);
    assert.equal(out.unresolved, 0);
    assert.deepEqual(out.board.scenes[3].graphics.map((g) => g.text), ["미세거품"]);
    assert.equal(out.board.scenes[3].say, b.scenes[3].say);
  });

  it("말에서 걸린 문제나 다른 종류는 해결된 것으로 치지 않는다", () => {
    const b = withGraphics();
    assert.equal(stripFlaggedGraphics(b, [{ kind: "grounding", detail: '근거 없음: "피부가 좋아져요" — 근거 없음' }]).unresolved, 1);
    assert.equal(stripFlaggedGraphics(b, [{ kind: "rules", detail: "금지 표현" }]).unresolved, 1);
  });

  it("끝 카드는 빼지 않는다", () => {
    const out = stripFlaggedGraphics(withGraphics(), [{ kind: "grounding", detail: '근거 없음: "성분표부터 보세요" — 근거 없음' }]);
    assert.equal(out.removed, 0);
    assert.equal(out.unresolved, 1);
  });

  it("근거 번호 뒤에 문구를 덧붙여도 번호로 본다", () => {
    const scenes = goodScenes();
    scenes[5] = { ...scenes[5], evidence: ["K1: 소듐디엔에이 설명"] };
    assert.equal(problems({ ...goodBoard(), scenes }).some((p) => p.includes("받은 자료에 없다")), false);
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

  it("다른 상품이 나오기 전까지만 쓴다", () => {
    const crop = { crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1 };
    assert.deepEqual(gifRange(10, { ...crop, start_sec: 0, end_sec: 3 }), { start: 0, length: 3 });
    assert.deepEqual(gifRange(4, crop), { start: 0, length: 4 });
    assert.deepEqual(gifRange(4, { ...crop, start_sec: 3.9, end_sec: 4 }), { start: 0, length: 4 });
  });

  it("범위를 벗어난 값을 줄인다", () => {
    const c = cropPixels({ w: 400, h: 400 }, { crop_x: 0.8, crop_y: -1, crop_w: 2, crop_h: 2 });
    assert.ok(c.x + c.w <= 400);
    assert.equal(c.y, 0);
  });
});

describe("설명 화면 값 점검", () => {
  const steps = (items: string[]) => ({ kind: "steps", title: "", left_label: "", right_label: "", left_value: "", right_values: [], number_to: 0, unit: "", end_text: "", items, big: "", accent: "#E04E08" }) as Storyboard["scenes"][number]["motion"];
  const withSteps = (items: string[]) => {
    const scenes = goodScenes();
    scenes[3] = { ...scenes[3], source: "motion", source_id: "", motion: steps(items) };
    return problems({ ...goodBoard(), scenes });
  };

  it("목록 도식 항목이 1개면 장면표 에이전트가 고치게 잡는다", () => {
    assert.equal(withSteps(["발효"]).some((p) => p.includes("3번 장면의 목록 도식(steps) 항목이 1개")), true);
    // 빈 문자열 항목은 그리지 않으니 세지 않는다
    assert.equal(withSteps(["발효", "  "]).some((p) => p.includes("항목이 1개")), true);
  });

  it("항목이 2개 이상이면 통과하고, 모두 비면 값이 없다고 잡는다", () => {
    assert.equal(withSteps(["발효", "비타민 B12"]).some((p) => p.includes("3번 장면")), false);
    const empty = withSteps(["", " "]);
    assert.equal(empty.some((p) => p.includes("3번 장면에 도식 값이 없다")), true);
    assert.equal(empty.some((p) => p.includes("항목이 1개")), false);
  });
});

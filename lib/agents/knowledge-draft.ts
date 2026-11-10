import { z } from "zod";
import { cardMatches, factsHaystack } from "@/lib/agents/knowledge";
import type { ProductFacts } from "@/lib/agents/product-facts";
import { agentModel } from "@/lib/agents/runner";
import { getOpenAI } from "@/lib/openai";
import type { ProductKind } from "@/lib/products/shops";
import type { createServiceClient } from "@/lib/supabase/service";

// 상식 카드 · 우리 차이 초안 — AI가 믿을 만한 자료를 찾아 초안만 만든다. 영상에는 사람이 승인한 뒤에 들어간다.
// 인용문이 출처 페이지에 실제로 있는지 코드가 한 번 더 확인해 화면에 표시한다.

type Service = ReturnType<typeof createServiceClient>;

// 2026-11-10 사용자 결정(상식 카드 보강): 상품을 이해하는 상식만 찾으면 대본이 상품 설명서가 된다.
// 이 상품군을 사거나 쓰는 사람이 이미 원하거나 귀찮아하는 것(고르는 법 · 보관 · 먹는 법 · 쓰는 순서 · 흔한 오해 · 생활 습관)에 답하는
// 분야 상식도 출처와 함께 찾아 둔다. 각도는 시청자의 바람에서 출발하고, 이 카드가 그 출발점의 근거가 된다.

/** 상품에 맞는 카드가 이만큼 있으면 더 찾지 않는다 */
export const ENOUGH_CARDS = 6;
/** 이 상품으로 이 기간 안에 초안을 만들었으면 카드가 적어도 다시 찾지 않는다(찾을 자료가 적은 상품을 매번 다시 찾지 않게) */
export const REDRAFT_DAYS = 14;

const DOMAINS: Partial<Record<ProductKind, string[]>> = {
  COSMETIC: ["kcia.or.kr", "mfds.go.kr", "nedrug.mfds.go.kr", "ec.europa.eu", "aad.org", "ncbi.nlm.nih.gov", "fda.gov", "cir-safety.org"],
  HEALTH_FOOD: ["foodsafetykorea.go.kr", "mfds.go.kr", "ods.od.nih.gov", "ncbi.nlm.nih.gov", "rda.go.kr", "nongsaro.go.kr", "koreascience.kr", "health.kdca.go.kr", "kdca.go.kr"],
  FRUIT: ["nongsaro.go.kr", "rda.go.kr", "mafra.go.kr", "foodsafetykorea.go.kr", "citrusvariety.ucr.edu", "ucanr.edu", "usda.gov", "fao.org", "koreascience.kr"],
  CLOTHING: ["kats.go.kr", "ec.europa.eu"],
};

const draftSchema = z.object({
  cards: z.array(
    z.object({
      topic: z.string(),
      terms: z.array(z.string()),
      statement: z.string(),
      source_title: z.string(),
      source_url: z.string(),
      source_quote: z.string(),
    }),
  ),
  differences: z.array(
    z.object({
      difference: z.string(),
      compare_to: z.string(),
      evidence: z.string(),
    }),
  ),
});
export type KnowledgeDraft = z.infer<typeof draftSchema>;

const jsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cards", "differences"],
  properties: {
    cards: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["topic", "terms", "statement", "source_title", "source_url", "source_quote"],
        properties: {
          topic: { type: "string", description: "주제 이름. 예: PDRN, 카라카라, 후숙" },
          terms: { type: "array", items: { type: "string" }, description: "상품 자료에서 이 카드를 찾을 두 글자 이상의 낱말. 상품 자료에 실제로 나오는 말을 넣는다. 전성분 표기와 다른 이름, 분야 상식이면 상품군 낱말(예: 감귤, 수면)을 함께 쓴다" },
          statement: { type: "string", description: "영상에서 말해도 되는 사실 한 문장. 쉬운 한국어" },
          source_title: { type: "string" },
          source_url: { type: "string", description: "실제로 확인한 페이지 주소" },
          source_quote: { type: "string", description: "페이지에 적힌 문구를 글자 그대로 옮긴다" },
        },
      },
    },
    differences: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["difference", "compare_to", "evidence"],
        properties: {
          difference: { type: "string", description: "이 상품의 차이 한 문장" },
          compare_to: { type: "string", description: "비교 대상. 타사 이름 없이 일반적인 경우로 쓴다" },
          evidence: { type: "string", description: "상품 자료의 문구를 글자 그대로 옮긴다" },
        },
      },
    },
  },
} as const;

function kindRules(kind: ProductKind): string {
  if (kind === "COSMETIC")
    return "화장품: 성분의 정의 · 유래 · 분류 · 전성분 표기 이름, 그리고 바르는 순서 · 보관 · 흔한 오해 같은 피부 관리 일반 상식만 쓴다. 치료 · 재생 · 염증 · 미백 · 주름 개선 같은 효과와 연구 결과는 쓰지 않는다. 원료의 기능 분류를 제품 효과처럼 쓰지 않는다.";
  if (kind === "HEALTH_FOOD")
    return "식품 · 건강기능식품: 원료의 유래와 표시 읽는 법, 그리고 공공기관이 안내하는 생활 습관 상식(잠자리 습관 · 식사 습관 등)만 쓴다. 질병 · 건강 효과 · 기능성 설명은 쓰지 않고, 생활 습관 상식을 이 원료 · 제품의 효과처럼 잇지 않는다.";
  if (kind === "FRUIT") return "과일: 품종의 유래와 특징, 익는 원리, 고르는 법, 보관 원리, 손질 · 먹는 법, 먹는 시점만 쓴다. 일수 · 온도처럼 조건이 있는 값은 그 조건을 함께 쓴다. 건강 효과는 쓰지 않는다.";
  if (kind === "CLOTHING") return "의류: 소재의 특징, 고르는 법, 세탁 · 보관 같은 일반 상식만 쓴다. 효과는 단정하지 않는다.";
  return "상품 종류의 일반 상식만 쓰고 효과는 단정하지 않는다.";
}

/**
 * 웹 검색으로 초안을 만든다. 결과는 저장하지 않는다.
 * existing: 이 상품에 이미 맞는 카드 · 차이. 보강할 때 같은 주제를 다시 찾지 않고, 차이가 이미 있으면 차이는 찾지 않는다.
 */
export async function draftKnowledge(
  facts: ProductFacts,
  existing: { cardTopics: string[]; hasDifferences: boolean } = { cardTopics: [], hasDifferences: false },
): Promise<{ draft: KnowledgeDraft; tokens: { input: number; output: number } }> {
  const domains = DOMAINS[facts.kind] ?? [];
  const response = await getOpenAI().responses.create({
    model: agentModel(),
    tools: [{ type: "web_search", ...(domains.length ? { filters: { allowed_domains: domains } } : {}) }],
    instructions: `너는 쇼핑몰 릴스의 자료 조사 담당이다. 시청자가 궁금해할 상식의 근거를 찾아 초안을 낸다. 사람이 승인하기 전에는 영상에 들어가지 않는다.
- cards는 두 가지를 함께 낸다. 공식 사전 · 공공기관 · 대학 자료에서 찾은 내용만 쓴다. 찾지 못하면 적게 낸다. 지어내지 않는다.
  1. 상품 상식 2~4개: 이 상품을 이해하는 데 필요한 것(성분 · 원료 · 품종의 뜻과 유래 등).
  2. 분야 상식 3~6개: 이 상품군을 사거나 쓰는 평범한 사람이 이미 원하거나 귀찮아하는 것(더 맛있게, 실패 없이, 덜 귀찮게, 오래 두기 등)에 답하는 상식. 고르는 법, 보관, 손질 · 먹는 법, 쓰는 순서, 흔한 오해, 생활 습관처럼 상품 이야기 없이도 "아, 그렇구나" 할 내용이다. 이 상품만이 아니라 같은 상품군 어디에나 맞는 사실이어야 한다.
- ${kindRules(facts.kind)}
- 한 카드는 사실 하나. statement는 처음 듣는 사람이 알아듣는 말로 쓰고, source_quote는 페이지에 적힌 문구를 글자 그대로 옮긴다.
- terms에는 상품 자료(아래 상품 이름 · 상세페이지 원문)에 실제로 나오는 두 글자 이상의 낱말을 하나 이상 넣는다. 그래야 이 상품 대본에 카드가 붙는다.${existing.cardTopics.length ? `\n- 이미 있는 카드 주제와 겹치지 않게 다른 주제를 찾는다: ${existing.cardTopics.join(", ")}` : ""}
- differences: ${existing.hasDifferences ? "이미 정리된 차이가 있으니 빈 배열로 둔다." : '상품 자료 안에서 찾을 수 있는 차이 후보 0~3개. 비교 대상은 "일반적인 ○○"처럼 쓰고 타사 이름을 쓰지 않는다. 최고 · 유일 같은 단정을 쓰지 않는다. 근거가 없으면 빈 배열이다.'}`,
    input: `상품: ${facts.shop} ${facts.kindLabel} "${facts.name}"\n한 줄 소개: ${facts.oneLine ?? "없음"}\n상세 항목: ${JSON.stringify(facts.details)}\n확인된 특징: ${facts.claims.map((c) => `${c.claim} (${c.quote})`).join(" / ")}\n상세페이지 원문:\n${facts.sourceText.slice(0, 4000)}`,
    text: { format: { type: "json_schema", name: "knowledge_draft", strict: true, schema: jsonSchema as unknown as Record<string, unknown> } },
  });
  const parsed = draftSchema.parse(JSON.parse(response.output_text));
  const draft = existing.hasDifferences ? { ...parsed, differences: [] } : parsed;
  return { draft, tokens: { input: response.usage?.input_tokens ?? 0, output: response.usage?.output_tokens ?? 0 } };
}

/** 이 상품 자료에서 찾을 낱말이 없는 카드는 대본에 붙지 않으니 저장하지 않는다. 뺀 카드 주제를 함께 돌려준다. */
export function keepMatchingCards(draft: KnowledgeDraft, facts: ProductFacts): { draft: KnowledgeDraft; dropped: string[] } {
  const haystack = factsHaystack(facts);
  const cards = draft.cards.filter((c) => cardMatches(c, haystack));
  return { draft: { ...draft, cards }, dropped: draft.cards.filter((c) => !cards.includes(c)).map((c) => c.topic) };
}

const looseText = (t: string) => t.toLowerCase().replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/[^\p{L}\p{N}]+/gu, "");

/** 출처 페이지에 인용문이 실제로 있는지 본다. 페이지를 못 받으면 false로 두고 사람이 직접 확인한다. */
export async function quoteOnPage(url: string, quote: string): Promise<boolean> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "MCB-Knowledge/1.0" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return false;
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("text") && !type.includes("html")) return false;
    const want = looseText(quote);
    return want.length >= 4 && looseText(await res.text()).includes(want);
  } catch {
    return false;
  }
}

// 웹 검색 답은 문장 끝에 출처 링크를 붙이기도 한다. 영상에 쓸 문장에서는 지운다
export const cleanStatement = (t: string) => t.replace(/\s*\(?\[[^\]]*\]\([^)]*\)\)?/g, "").replace(/\s+/g, " ").trim();

const cleanUrl = (u: string) => u.replace(/([?&])utm_source=openai(&|$)/, (_, a: string, b: string) => (b ? a : "")).replace(/[?&]$/, "");

/** 초안을 DRAFT로 저장한다. 이미 있는 문장은 사람이 정한 상태를 건드리지 않는다. */
export async function saveKnowledgeDraft(service: Service, organizationId: string, facts: ProductFacts, draft: KnowledgeDraft): Promise<{ cards: number; differences: number }> {
  let cards = 0;
  for (const c of draft.cards) {
    const url = cleanUrl(c.source_url);
    if (!/^https?:\/\//.test(url) || !c.statement.trim() || !c.source_quote.trim()) continue;
    const { data, error } = await service
      .from("knowledge_cards")
      .upsert(
        {
          organization_id: organizationId,
          product_kind: facts.kind,
          topic: c.topic.trim().slice(0, 60),
          terms: c.terms.map((t) => t.trim()).filter(Boolean).slice(0, 12),
          statement: cleanStatement(c.statement).slice(0, 400),
          source_title: c.source_title.trim().slice(0, 200) || url.slice(0, 200),
          source_url: url,
          source_quote: cleanStatement(c.source_quote).slice(0, 500),
          source_checked: await quoteOnPage(url, cleanStatement(c.source_quote)),
          product_id: facts.id,
        },
        { onConflict: "organization_id,topic,statement", ignoreDuplicates: true },
      )
      .select("id");
    if (error) throw new Error(`상식 카드를 저장하지 못했어요: ${error.message}`);
    cards += data?.length ?? 0;
  }
  let differences = 0;
  for (const d of draft.differences) {
    if (!d.difference.trim() || !d.compare_to.trim() || !d.evidence.trim()) continue;
    const { data, error } = await service
      .from("product_differences")
      .upsert(
        {
          organization_id: organizationId,
          product_id: facts.id,
          difference: d.difference.trim().slice(0, 200),
          compare_to: d.compare_to.trim().slice(0, 200),
          evidence: d.evidence.trim().slice(0, 400),
        },
        { onConflict: "organization_id,product_id,difference", ignoreDuplicates: true },
      )
      .select("id");
    if (error) throw new Error(`우리 차이를 저장하지 못했어요: ${error.message}`);
    differences += data?.length ?? 0;
  }
  return { cards, differences };
}

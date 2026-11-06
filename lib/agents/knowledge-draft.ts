import { z } from "zod";
import type { ProductFacts } from "@/lib/agents/product-facts";
import { agentModel } from "@/lib/agents/runner";
import { getOpenAI } from "@/lib/openai";
import type { ProductKind } from "@/lib/products/shops";
import type { createServiceClient } from "@/lib/supabase/service";

// 상식 카드 · 우리 차이 초안 — AI가 믿을 만한 자료를 찾아 초안만 만든다. 영상에는 사람이 승인한 뒤에 들어간다.
// 인용문이 출처 페이지에 실제로 있는지 코드가 한 번 더 확인해 화면에 표시한다.

type Service = ReturnType<typeof createServiceClient>;

const DOMAINS: Partial<Record<ProductKind, string[]>> = {
  COSMETIC: ["kcia.or.kr", "mfds.go.kr", "nedrug.mfds.go.kr", "ec.europa.eu", "aad.org", "ncbi.nlm.nih.gov", "fda.gov", "cir-safety.org"],
  HEALTH_FOOD: ["foodsafetykorea.go.kr", "mfds.go.kr", "ods.od.nih.gov", "ncbi.nlm.nih.gov", "rda.go.kr", "nongsaro.go.kr", "koreascience.kr"],
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
          terms: { type: "array", items: { type: "string" }, description: "상품 자료에서 이 카드를 찾을 낱말. 전성분 표기와 다른 이름을 함께 쓴다" },
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
  if (kind === "COSMETIC") return "화장품: 성분의 정의 · 유래 · 분류 · 전성분 표기 이름만 쓴다. 치료 · 재생 · 염증 · 미백 · 주름 개선 같은 효과와 연구 결과는 쓰지 않는다. 원료의 기능 분류를 제품 효과처럼 쓰지 않는다.";
  if (kind === "HEALTH_FOOD") return "식품 · 건강기능식품: 원료의 유래와 표시 읽는 법만 쓴다. 질병 · 건강 효과 · 기능성 설명은 쓰지 않는다.";
  if (kind === "FRUIT") return "과일: 품종의 유래와 특징, 익는 원리, 보관 원리, 먹는 시점만 쓴다. 일수 · 온도처럼 조건이 있는 값은 그 조건을 함께 쓴다. 건강 효과는 쓰지 않는다.";
  return "상품 종류의 일반 상식만 쓰고 효과는 단정하지 않는다.";
}

/** 웹 검색으로 초안을 만든다. 결과는 저장하지 않는다. */
export async function draftKnowledge(facts: ProductFacts): Promise<{ draft: KnowledgeDraft; tokens: { input: number; output: number } }> {
  const domains = DOMAINS[facts.kind] ?? [];
  const response = await getOpenAI().responses.create({
    model: agentModel(),
    tools: [{ type: "web_search", ...(domains.length ? { filters: { allowed_domains: domains } } : {}) }],
    instructions: `너는 쇼핑몰 릴스의 자료 조사 담당이다. 시청자가 궁금해할 상식의 근거를 찾아 초안을 낸다. 사람이 승인하기 전에는 영상에 들어가지 않는다.
- cards: 이 상품을 이해하는 데 필요한 상식 3~6개. 공식 사전 · 공공기관 · 대학 자료에서 찾은 내용만 쓴다. 찾지 못하면 적게 낸다. 지어내지 않는다.
- ${kindRules(facts.kind)}
- 한 카드는 사실 하나. statement는 처음 듣는 사람이 알아듣는 말로 쓰고, source_quote는 페이지에 적힌 문구를 글자 그대로 옮긴다.
- differences: 상품 자료 안에서 찾을 수 있는 차이 후보 0~3개. 비교 대상은 "일반적인 ○○"처럼 쓰고 타사 이름을 쓰지 않는다. 최고 · 유일 같은 단정을 쓰지 않는다. 근거가 없으면 빈 배열이다.`,
    input: `상품: ${facts.shop} ${facts.kindLabel} "${facts.name}"\n한 줄 소개: ${facts.oneLine ?? "없음"}\n상세 항목: ${JSON.stringify(facts.details)}\n확인된 특징: ${facts.claims.map((c) => `${c.claim} (${c.quote})`).join(" / ")}\n상세페이지 원문:\n${facts.sourceText.slice(0, 4000)}`,
    text: { format: { type: "json_schema", name: "knowledge_draft", strict: true, schema: jsonSchema as unknown as Record<string, unknown> } },
  });
  const draft = draftSchema.parse(JSON.parse(response.output_text));
  return { draft, tokens: { input: response.usage?.input_tokens ?? 0, output: response.usage?.output_tokens ?? 0 } };
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

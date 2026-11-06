import type { ProductFacts } from "@/lib/agents/product-facts";
import type { createServiceClient } from "@/lib/supabase/service";

// 설명 영상의 근거 묶음 — 사람이 승인한 상식 카드와 담당자가 확정한 우리 차이.
// 상품 자료(ProductFacts)와 섞지 않고 대본 · 점검 에이전트에 따로 넘긴다. 어느 문장이 어디에서 왔는지 남기기 위해서다.

type Service = ReturnType<typeof createServiceClient>;

export interface KnowledgeCard {
  ref: string;
  id: string;
  topic: string;
  statement: string;
  sourceTitle: string;
  sourceUrl: string;
}

export interface ProductDifference {
  ref: string;
  id: string;
  difference: string;
  compareTo: string;
  evidence: string;
}

export interface VideoKnowledge {
  cards: KnowledgeCard[];
  differences: ProductDifference[];
}

export const EMPTY_KNOWLEDGE: VideoKnowledge = { cards: [], differences: [] };

const MAX_CARDS = 12;

const squash = (t: string) => t.toLowerCase().replace(/[\s·.,/()\-]+/g, "");

/** 상품 자료 전체를 찾기 쉬운 한 줄로 만든다. 전성분 · 품종은 details 안에 있다. */
export function factsHaystack(facts: ProductFacts): string {
  return squash([facts.name, facts.rawName, facts.oneLine ?? "", facts.usage ?? "", JSON.stringify(facts.details), facts.sourceText, ...facts.claims.flatMap((c) => [c.claim, c.quote])].join(" "));
}

/** 카드의 주제나 찾을 낱말이 상품 자료에 있으면 이 상품에 맞는 카드다. */
export function cardMatches(card: { topic: string; terms: string[] }, haystack: string): boolean {
  return [card.topic, ...card.terms].map(squash).some((t) => t.length >= 2 && haystack.includes(t));
}

/** 대본에 쓸 근거를 읽는다. includeDrafts는 저장하지 않는 시험에서만 켠다. */
export async function loadVideoKnowledge(service: Service, organizationId: string, facts: ProductFacts, opts: { includeDrafts?: boolean } = {}): Promise<VideoKnowledge> {
  const cardStatus = opts.includeDrafts ? ["APPROVED", "DRAFT"] : ["APPROVED"];
  const differenceStatus = opts.includeDrafts ? ["CONFIRMED", "DRAFT"] : ["CONFIRMED"];
  const [{ data: cardRows, error: cardError }, { data: differenceRows, error: differenceError }] = await Promise.all([
    service
      .from("knowledge_cards")
      .select("id, topic, terms, statement, source_title, source_url")
      .eq("organization_id", organizationId)
      .in("status", cardStatus)
      .in("product_kind", [facts.kind, "ALL"])
      .order("reviewed_at", { ascending: false, nullsFirst: false }),
    service
      .from("product_differences")
      .select("id, difference, compare_to, evidence")
      .eq("organization_id", organizationId)
      .eq("product_id", facts.id)
      .in("status", differenceStatus)
      .order("created_at"),
  ]);
  if (cardError) throw new Error(`상식 카드를 조회하지 못했어요: ${cardError.message}`);
  if (differenceError) throw new Error(`우리 차이를 조회하지 못했어요: ${differenceError.message}`);
  const haystack = factsHaystack(facts);
  const matched = (cardRows ?? []).filter((c) => cardMatches(c, haystack)).slice(0, MAX_CARDS);
  return {
    cards: matched.map((c, i) => ({ ref: `K${i + 1}`, id: c.id, topic: c.topic, statement: c.statement, sourceTitle: c.source_title, sourceUrl: c.source_url })),
    differences: (differenceRows ?? []).slice(0, 3).map((d, i) => ({ ref: `D${i + 1}`, id: d.id, difference: d.difference, compareTo: d.compare_to, evidence: d.evidence })),
  };
}

/** 에이전트에게 주는 근거 글. */
export function knowledgeBlock(k: VideoKnowledge): string {
  const cards = k.cards.length ? k.cards.map((c) => `- ${c.ref} [${c.topic}] ${c.statement} (출처: ${c.sourceTitle})`).join("\n") : "- 없음. 상품 자료에 있는 설명으로만 상식 구간을 쓴다";
  const differences = k.differences.length ? k.differences.map((d) => `- ${d.ref} ${d.difference} (비교 대상: ${d.compareTo} / 근거: ${d.evidence})`).join("\n") : "- 없음. 우리가 다르다는 말을 하지 않고, 상품의 특징까지만 말한다";
  return `승인된 상식 카드:\n${cards}\n\n담당자가 확정한 우리 차이:\n${differences}`;
}

/** 점검 에이전트의 근거에 함께 넣는 글. */
export function knowledgeEvidence(k: VideoKnowledge): string {
  if (!k.cards.length && !k.differences.length) return "";
  return `\n\n승인된 상식 카드(이 문장과 같은 뜻이면 근거가 있다):\n${k.cards.map((c) => `${c.ref}: ${c.statement}`).join("\n") || "없음"}\n\n담당자가 확정한 우리 차이(이 문장과 같은 뜻이면 근거가 있다):\n${k.differences.map((d) => `${d.ref}: ${d.difference} (비교 대상: ${d.compareTo})`).join("\n") || "없음"}`;
}

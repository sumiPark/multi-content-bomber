import type { ProductFacts } from "@/lib/agents/product-facts";
import type { createServiceClient } from "@/lib/supabase/service";

// 설명 영상의 근거 묶음 — 상식 카드와 담당자가 확정한 우리 차이.
// 상품 자료(ProductFacts)와 섞지 않고 대본 · 점검 에이전트에 따로 넘긴다. 어느 문장이 어디에서 왔는지 남기기 위해서다.
// 상식 카드 승인은 선택이다(2026-11-09 사용자 결정). 승인된 카드를 먼저 주고, 남는 자리에 출처가 확인된 승인 전 초안을 준다.
// 널리 알려진 일반 상식은 카드가 없어도 대본에 쓸 수 있고, 근거에는 "일반 상식"이라고 적는다.

type Service = ReturnType<typeof createServiceClient>;

export interface KnowledgeCard {
  ref: string;
  id: string;
  topic: string;
  statement: string;
  sourceTitle: string;
  sourceUrl: string;
  /** 사람이 승인한 카드인지. false면 AI 초안이다 */
  approved: boolean;
}

/** 장면 근거에 적는 일반 상식 표시. 카드 · 상품 자료 없이 널리 알려진 내용을 쓸 때 */
export const COMMON_KNOWLEDGE_REF = "일반 상식";

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

/**
 * 대본에 쓸 근거를 읽는다. 상식 카드는 승인 · 초안을 함께 읽고 승인된 카드를 앞에 둔다(거절한 카드는 뺀다).
 * includeDrafts는 저장하지 않는 시험에서만 켠다 — 확정 전 우리 차이 초안까지 넣는다.
 */
export async function loadVideoKnowledge(service: Service, organizationId: string, facts: ProductFacts, opts: { includeDrafts?: boolean } = {}): Promise<VideoKnowledge> {
  const differenceStatus = opts.includeDrafts ? ["CONFIRMED", "DRAFT"] : ["CONFIRMED"];
  const [{ data: cardRows, error: cardError }, { data: differenceRows, error: differenceError }] = await Promise.all([
    service
      .from("knowledge_cards")
      .select("id, topic, terms, statement, source_title, source_url, status, source_checked")
      .eq("organization_id", organizationId)
      .in("status", ["APPROVED", "DRAFT"])
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
  // 초안은 보조 근거라 출처 페이지에서 인용문이 확인된 카드만 쓴다(2026-11-10 사용자 결정). 승인된 카드는 사람이 확인했으니 그대로 쓴다
  const usable = (cardRows ?? []).filter((c) => c.status === "APPROVED" || c.source_checked);
  const matched = approvedFirst(usable.filter((c) => cardMatches(c, haystack))).slice(0, MAX_CARDS);
  return {
    cards: matched.map((c, i) => ({ ref: `K${i + 1}`, id: c.id, topic: c.topic, statement: c.statement, sourceTitle: c.source_title, sourceUrl: c.source_url, approved: c.status === "APPROVED" })),
    differences: (differenceRows ?? []).slice(0, 3).map((d, i) => ({ ref: `D${i + 1}`, id: d.id, difference: d.difference, compareTo: d.compare_to, evidence: d.evidence })),
  };
}

/** 승인된 카드를 앞에 둔다. 같은 상태 안에서는 받은 순서(최근 검토 순)를 지킨다. */
export function approvedFirst<T extends { status: string }>(rows: T[]): T[] {
  return [...rows.filter((r) => r.status === "APPROVED"), ...rows.filter((r) => r.status !== "APPROVED")];
}

/** 영상 하나가 실제로 쓴 근거 — 확인 화면에 승인 · 초안을 나눠 보여 준다. 장면 번호는 0부터(0 = 첫 장면) */
export interface UsedEvidence {
  cards: (KnowledgeCard & { scenes: number[] })[];
  differences: (ProductDifference & { scenes: number[] })[];
  /** 상품 자료(P)를 근거로 쓴 장면 수 */
  productScenes: number;
  /** 카드 없이 일반 상식으로 쓴 장면 수 */
  commonScenes: number;
}

/** 장면표의 근거 번호를 장면표를 쓸 때의 근거 묶음에 맞춰 푼다. 쓰지 않은 카드는 넣지 않는다 */
export function usedEvidence(scenes: { evidence?: string[] }[], k: VideoKnowledge): UsedEvidence {
  const at = new Map<string, number[]>();
  let productScenes = 0;
  let commonScenes = 0;
  scenes.forEach((s, i) => {
    const refs = new Set((s.evidence ?? []).map(evidenceRef));
    if (refs.has("P")) productScenes++;
    if (refs.has(COMMON_KNOWLEDGE_REF)) commonScenes++;
    for (const r of refs) at.set(r, [...(at.get(r) ?? []), i]);
  });
  return {
    cards: k.cards.filter((c) => at.has(c.ref)).map((c) => ({ ...c, scenes: at.get(c.ref)! })),
    differences: k.differences.filter((d) => at.has(d.ref)).map((d) => ({ ...d, scenes: at.get(d.ref)! })),
    productScenes,
    commonScenes,
  };
}

/** 장면 근거 칸의 값을 번호 하나로 줄인다. "P: 상세 문구"처럼 덧붙여도 번호만, "일반 상식 — ○○"는 "일반 상식"으로 본다. */
export function evidenceRef(raw: string): string {
  const t = raw.trim();
  if (t.startsWith(COMMON_KNOWLEDGE_REF)) return COMMON_KNOWLEDGE_REF;
  return t.split(/[\s:：]/)[0];
}

const cardLine = (c: KnowledgeCard) => `- ${c.ref}${c.approved ? "" : " (승인 전 초안)"} [${c.topic}] ${c.statement} (출처: ${c.sourceTitle})`;

/** 에이전트에게 주는 근거 글. */
export function knowledgeBlock(k: VideoKnowledge): string {
  const cards = k.cards.length
    ? `${k.cards.map(cardLine).join("\n")}\n- 승인된 카드가 있으면 그 카드를 먼저 쓴다. 승인 전 초안은 승인된 카드로 채울 수 없는 내용에만 쓴다`
    : "- 없음";
  const differences = k.differences.length ? k.differences.map((d) => `- ${d.ref} ${d.difference} (비교 대상: ${d.compareTo} / 근거: ${d.evidence})`).join("\n") : "- 없음. 우리가 다르다는 말을 하지 않고, 상품의 특징까지만 말한다";
  return `상식 카드:\n${cards}\n\n일반 상식: 원리 · 원료 일반 · 생활 상식처럼 널리 알려진 내용은 카드가 없어도 쓸 수 있다. 그 장면 근거(evidence)에 "${COMMON_KNOWLEDGE_REF}"이라고 적는다. 숫자 · 통계 · 의학적 효과는 일반 상식으로 쓰지 않는다.\n\n담당자가 확정한 우리 차이:\n${differences}`;
}

/** 점검 에이전트의 근거에 함께 넣는 글. */
export function knowledgeEvidence(k: VideoKnowledge): string {
  if (!k.cards.length && !k.differences.length) return "";
  return `\n\n상식 카드(이 문장과 같은 뜻이면 근거가 있다):\n${k.cards.map((c) => `${c.ref}: ${c.statement}`).join("\n") || "없음"}\n\n담당자가 확정한 우리 차이(이 문장과 같은 뜻이면 근거가 있다):\n${k.differences.map((d) => `${d.ref}: ${d.difference} (비교 대상: ${d.compareTo})`).join("\n") || "없음"}`;
}

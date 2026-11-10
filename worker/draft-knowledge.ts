import "./load-env";
import { loadVideoKnowledge } from "@/lib/agents/knowledge";
import { ENOUGH_CARDS, REDRAFT_DAYS, draftKnowledge, keepMatchingCards, saveKnowledgeDraft } from "@/lib/agents/knowledge-draft";
import { loadProductFacts } from "@/lib/agents/product-facts";
import { kstDate } from "@/lib/automation/time";
import { createServiceClient } from "@/lib/supabase/service";

// 상식 카드 · 우리 차이 초안 워커. 초안만 만들고, 영상에는 사람이 승인한 뒤에 들어간다.
//   기본: 다가오는 AI 자동 칸의 상품 중 맞는 카드가 ENOUGH_CARDS개 미만인 상품(최근 REDRAFT_DAYS일 안에 찾은 상품은 뺀다)
//   --product <id> [--org <id>]: 그 상품만 다시 찾는다(이미 있는 문장은 그대로 둔다)

const MAX_PRODUCTS = 12;

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const onlyProduct = arg(argv, "--product");
  const service = createServiceClient();

  const targets: { productId: string; organizationId: string }[] = [];
  if (onlyProduct) {
    let org = arg(argv, "--org");
    if (!org) {
      const { data, error } = await service.from("content_plans").select("organization_id").eq("product_id", onlyProduct).limit(1).maybeSingle();
      if (error) throw new Error(error.message);
      org = data?.organization_id;
    }
    if (!org) throw new Error("이 상품을 쓰는 칸이 없어 --org가 필요해요");
    targets.push({ productId: onlyProduct, organizationId: org });
  } else {
    const { data: plans, error } = await service
      .from("content_plans")
      .select("product_id, organization_id")
      .eq("track", "B")
      .gte("slot_date", kstDate(0))
      .in("status", ["PROPOSED", "CONFIRMED", "SCRIPTED"])
      .not("product_id", "is", null);
    if (error) throw new Error(error.message);
    const seen = new Set<string>();
    for (const p of plans ?? []) {
      if (!p.product_id || seen.has(p.product_id)) continue;
      seen.add(p.product_id);
      targets.push({ productId: p.product_id, organizationId: p.organization_id });
    }
    // 최근에 찾은 상품은 카드가 적어도 다시 찾지 않는다(찾을 자료가 적은 상품을 매번 다시 찾지 않게)
    const ids = targets.map((t) => t.productId);
    const since = new Date(Date.now() - REDRAFT_DAYS * 86_400_000).toISOString();
    const { data: recent, error: recentError } = await service
      .from("knowledge_cards")
      .select("product_id")
      .in("product_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"])
      .gte("created_at", since);
    if (recentError) throw new Error(recentError.message);
    const recentlyDrafted = new Set((recent ?? []).map((d) => d.product_id));
    targets.splice(0, targets.length, ...targets.filter((t) => !recentlyDrafted.has(t.productId)));
  }

  let failed = 0;
  let drafted = 0;
  for (const t of targets) {
    if (drafted >= MAX_PRODUCTS) break;
    try {
      const facts = await loadProductFacts(service, t.productId);
      // 다른 상품으로 찾은 같은 상품군 카드도 이 상품에 붙는다. 맞는 카드가 충분하면 찾지 않는다
      const have = await loadVideoKnowledge(service, t.organizationId, facts, { includeDrafts: true });
      if (!onlyProduct && have.cards.length >= ENOUGH_CARDS) continue;
      drafted++;
      const { draft, tokens } = await draftKnowledge(facts, { cardTopics: have.cards.map((c) => c.topic), hasDifferences: have.differences.length > 0 });
      const { draft: kept, dropped } = keepMatchingCards(draft, facts);
      if (dropped.length) console.log(`[knowledge] ${facts.name}: 상품 자료에 낱말이 없어 뺀 카드 ${dropped.join(", ")}`);
      const saved = await saveKnowledgeDraft(service, t.organizationId, facts, kept);
      console.log(`[knowledge] ${facts.name}: 있던 카드 ${have.cards.length}개 + 상식 ${saved.cards}개 · 차이 ${saved.differences}개 저장 (토큰 ${tokens.input}+${tokens.output})`);
    } catch (e) {
      failed++;
      console.error(`[knowledge] ${t.productId} 실패:`, e instanceof Error ? e.message : e);
    }
  }
  if (!drafted && !failed) console.log("[knowledge] 초안을 만들 상품 없음");
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

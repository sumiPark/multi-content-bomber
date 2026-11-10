import "./load-env";
import { draftedRecently, topUpKnowledge } from "@/lib/agents/knowledge-draft";
import { loadProductFacts } from "@/lib/agents/product-facts";
import { kstDate } from "@/lib/automation/time";
import { createServiceClient } from "@/lib/supabase/service";

// 상식 카드 · 우리 차이 초안 워커. 상품 제안(b-plan)이 끝나면 돈다. 영상 장면표를 쓰기 직전에도 같은 확인을 한 번 더 한다(lib/auto-video/make.ts).
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
    // 최근에 찾은 상품은 카드가 적어도 다시 찾지 않는다(찾을 자료가 적은 상품을 매번 다시 찾지 않게). 상품 자료를 읽기 전에 미리 뺀다
    const recent = await draftedRecently(service, targets.map((t) => t.productId));
    targets.splice(0, targets.length, ...targets.filter((t) => !recent.has(t.productId)));
  }

  let failed = 0;
  let drafted = 0;
  for (const t of targets) {
    if (drafted >= MAX_PRODUCTS) break;
    try {
      const facts = await loadProductFacts(service, t.productId);
      const r = await topUpKnowledge(service, t.organizationId, facts, { force: !!onlyProduct });
      if (!r.drafted) continue;
      drafted++;
      if (r.dropped.length) console.log(`[knowledge] ${facts.name}: 상품 자료에 낱말이 없어 뺀 카드 ${r.dropped.join(", ")}`);
      console.log(`[knowledge] ${facts.name}: 있던 카드 ${r.had}개 + 상식 ${r.saved.cards}개 · 차이 ${r.saved.differences}개 저장 (토큰 ${r.tokens.input}+${r.tokens.output})`);
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

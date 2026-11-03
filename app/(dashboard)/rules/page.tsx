import { redirect } from "next/navigation";
import {
  AddRuleForm,
  ClaimProductCard,
  PreviewCheck,
  RuleRow,
  SCOPE_LABEL,
  type ClaimProduct,
  type RuleRowData,
} from "@/components/rules/rules-client";
import { Badge } from "@/components/ui/badge";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { SHOPS, type ShopCode } from "@/lib/products/shops";

// 표현 규칙 — 금지 표현 · 꼭 넣을 문구, 건기식 심의 문구 확정 (콘텐츠 자동화 2단계, 0026).
// 사람만 고치는 잠긴 항목: 에이전트 피드백(자동 승인 포함)으로는 바뀌지 않는다.

export default async function RulesPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");
  const canManage = profile.role === "ADMIN" || profile.role === "MANAGER";

  const supabase = await getServerSupabase();
  const [{ data: ruleRows }, { data: analyses }, { data: approvals }] = await Promise.all([
    supabase
      .from("content_rules")
      .select("id, scope, rule_type, phrase, match_type, reason, suggestion, active")
      .order("created_at", { ascending: true }),
    // 건강기능식품으로 판정된 상품 (일반 식품은 기능성 표현 자체를 못 쓴다)
    supabase
      .from("product_analyses")
      .select("product_id, functional_claims, products!inner(id, name, shop_code, stock_status, excluded)")
      .eq("health_functional", true),
    supabase.from("product_claim_approvals").select("id, product_id, claim, source"),
  ]);

  const rules: RuleRowData[] = (ruleRows ?? []).map((r) => ({
    id: r.id,
    scope: r.scope,
    ruleType: r.rule_type as RuleRowData["ruleType"],
    phrase: r.phrase,
    matchType: r.match_type as RuleRowData["matchType"],
    reason: r.reason,
    suggestion: r.suggestion,
    active: r.active,
  }));

  const approvedBy = new Map<string, ClaimProduct["approved"]>();
  for (const a of approvals ?? []) {
    const list = approvedBy.get(a.product_id) ?? [];
    list.push({ id: a.id, claim: a.claim, source: a.source });
    approvedBy.set(a.product_id, list);
  }
  const claimProducts: ClaimProduct[] = (analyses ?? [])
    .filter((a) => !a.products.excluded)
    .map((a) => ({
      id: a.product_id,
      name: a.products.name,
      shopName: SHOPS[a.products.shop_code as ShopCode]?.name ?? a.products.shop_code,
      candidates: a.functional_claims,
      approved: approvedBy.get(a.product_id) ?? [],
    }))
    // 확정 안 된 것 먼저
    .sort((x, y) => Number(x.approved.length > 0) - Number(y.approved.length > 0));
  const unconfirmed = claimProducts.filter((p) => p.approved.length === 0).length;

  const scopes = Object.keys(SCOPE_LABEL);

  return (
    <main className="space-y-8 p-4 sm:p-6">
      <header>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold tracking-[-0.01em]">광고 문구 규칙</h1>
          <Badge variant="outline">사람만 수정</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          AI 자동 업로드 영상은 사람이 보지 않고 올라가서, 올리기 전에 이 규칙으로 자동 검사하고 걸리면 멈춥니다. AI가
          스스로 이 규칙을 바꾸지는 못해요.
        </p>
      </header>

      <PreviewCheck />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">금지 표현 · 꼭 넣을 문구</h2>
        {canManage && <AddRuleForm />}
        <div className="grid gap-3 md:grid-cols-2">
          {scopes.map((scope) => {
            const list = rules.filter((r) => r.scope === scope);
            if (list.length === 0) return null;
            return (
              <div key={scope} className="rounded-lg border">
                <h3 className="border-b bg-muted/30 px-3 py-2 text-sm font-semibold">
                  {SCOPE_LABEL[scope]}
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                    금지 {list.filter((r) => r.ruleType === "BANNED").length} · 필수{" "}
                    {list.filter((r) => r.ruleType === "REQUIRED").length}
                  </span>
                </h3>
                <ul className="divide-y">
                  {list.map((r) => (
                    <RuleRow key={r.id} rule={r} canManage={canManage} />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">건기식 심의 문구</h2>
          <p className="text-sm text-muted-foreground">
            상세페이지 분석이 건강기능식품으로 판정한 상품입니다. 확정한 기능성 문구만 영상 · 캡션에 쓰고, 확정 문구가
            없는 상품은 AI 자동 업로드 후보에서 뺍니다.
            {unconfirmed > 0 && (
              <>
                {" "}
                <b className="text-foreground">{unconfirmed}개 상품</b>이 확정 전이에요.
              </>
            )}
          </p>
        </div>
        {claimProducts.length === 0 ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            아직 건강기능식품으로 판정된 상품이 없어요. 상품 분석이 끝나면 여기에 나타납니다.
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {claimProducts.map((p) => (
              <ClaimProductCard key={p.id} product={p} canManage={canManage} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

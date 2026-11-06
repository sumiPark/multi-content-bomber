import { redirect } from "next/navigation";
import { KnowledgeManager, type CardRow, type DifferenceRow, type ProductRow } from "@/components/auto/knowledge-manager";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { kstDate } from "@/lib/automation/time";
import { KIND_LABEL, type ProductKind } from "@/lib/products/shops";

// 상식 · 차이 자료 — AI 자동 설명 영상의 근거. 승인한 상식 카드와 확정한 우리 차이만 대본에 들어간다.

export const metadata = { title: "상식 · 차이 자료 | MCB" };

export default async function KnowledgePage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");
  const canManage = profile.role === "ADMIN" || profile.role === "MANAGER";
  const supabase = await getServerSupabase();

  const [{ data: cards }, { data: differences }, { data: plans }] = await Promise.all([
    supabase.from("knowledge_cards").select("id, product_kind, topic, terms, statement, source_title, source_url, source_quote, source_checked, status, origin, created_at").order("created_at", { ascending: false }).limit(300),
    supabase.from("product_differences").select("id, product_id, difference, compare_to, evidence, status, origin").order("created_at"),
    supabase.from("content_plans").select("product_id, slot_date, status").eq("track", "B").gte("slot_date", kstDate(0)).in("status", ["PROPOSED", "CONFIRMED", "SCRIPTED", "RENDERED", "BLOCKED"]).not("product_id", "is", null),
  ]);

  // 다가오는 칸의 상품을 앞에, 차이가 이미 있는 상품을 뒤에 둔다
  const upcoming = [...new Set((plans ?? []).map((p) => p.product_id as string))];
  const ids = [...new Set([...upcoming, ...(differences ?? []).map((d) => d.product_id)])];
  const { data: productRows } = ids.length ? await supabase.from("products").select("id, name, kind").in("id", ids) : { data: [] };
  const products: ProductRow[] = (productRows ?? [])
    .map((p) => ({ id: p.id, name: p.name, kindLabel: KIND_LABEL[(p.kind ?? "OTHER") as ProductKind], upcoming: upcoming.includes(p.id) }))
    .sort((a, b) => Number(b.upcoming) - Number(a.upcoming) || a.name.localeCompare(b.name, "ko"));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold tracking-[-0.01em]">상식 · 차이 자료</h1>
        <p className="mt-1 text-sm text-ink-2">AI 자동 영상의 설명 근거예요. 승인한 상식과 확정한 차이만 대본에 들어가고, AI 초안은 영상에 쓰이지 않아요.</p>
      </div>
      <KnowledgeManager cards={(cards ?? []) as CardRow[]} differences={(differences ?? []) as DifferenceRow[]} products={products} canManage={canManage} />
    </div>
  );
}

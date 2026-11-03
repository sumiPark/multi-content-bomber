import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { CategoryRow, type CategoryItem } from "@/components/products/category-row";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { SHOPS, SHOP_CODES, type ProductKind } from "@/lib/products/shops";

// 수집 카테고리 — 몰마다 어떤 카테고리 상품을 받을지, 어떤 종류(분석 스키마)로 볼지.
// 기본값은 lib/products/shops.ts (2026-11-03 사용자 확정). 바꾸면 다음 수집부터 반영된다.

export default async function ProductCategoriesPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");
  const canManage = profile.role === "ADMIN" || profile.role === "MANAGER";

  const supabase = await getServerSupabase();
  const { data } = await supabase
    .from("shop_categories")
    .select("shop_code, category_id, parent_id, name, collect, kind")
    .order("category_id", { ascending: true });
  const rows = data ?? [];

  // 트리 순서(부모 → 자식)로 펼친다.
  function ordered(shop: string): (CategoryItem & { depth: number })[] {
    const mine = rows.filter((r) => r.shop_code === shop);
    const out: (CategoryItem & { depth: number })[] = [];
    const walk = (parent: number | null, depth: number) => {
      for (const r of mine.filter((m) => m.parent_id === parent)) {
        out.push({
          shopCode: r.shop_code as CategoryItem["shopCode"],
          categoryId: r.category_id,
          name: r.name,
          collect: r.collect,
          kind: r.kind as ProductKind | null,
          depth,
        });
        walk(r.category_id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }

  return (
    <main className="space-y-6 p-4 sm:p-6">
      <Link href="/products" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> 상품 분석
      </Link>
      <header>
        <h1 className="text-xl font-bold tracking-[-0.01em]">수집 카테고리</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          켠 카테고리의 상품만 받아 옵니다. 하위 카테고리는 따로 끌 수 있고, 종류에 따라 상세페이지를 읽는
          항목(과일: 산지 · 당도 / 화장품: 성분 / 건기식: 기능성 문구 / 의류: 소재 · 사이즈)이 달라져요.
        </p>
      </header>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          첫 수집 뒤에 카테고리가 나타나요.
        </p>
      ) : (
        SHOP_CODES.map((code) => (
          <section key={code} className="rounded-lg border">
            <h2 className="border-b bg-muted/30 px-3 py-2 text-sm font-semibold">{SHOPS[code].name}</h2>
            <ul className="divide-y">
              {ordered(code).map((c) => (
                <CategoryRow key={c.categoryId} item={c} depth={c.depth} canManage={canManage} />
              ))}
            </ul>
          </section>
        ))
      )}
    </main>
  );
}

import { redirect } from "next/navigation";
import { MoaListPage, type MoaAccountRow } from "@/components/moa/moa-list-page";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { productKey } from "@/lib/moa/load";
import { publicUrl } from "@/lib/moa/slug";
import { pageTotals, rangeStart, rollupToday } from "@/lib/moa/stats";
import { STATUS_FAIL_ALERT } from "@/lib/moa/status";
import { createServiceClient } from "@/lib/supabase/service";

export const metadata = { title: "모아링크 | MCB" };

// 모아링크 목록 — 연결된 계정마다 페이지 한 개. 공개 상태 · 주소 · 최근 7일 방문 · 클릭 · 확인할 것을 한 줄씩.

export default async function Page() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");
  const canManage = profile.role === "ADMIN" || profile.role === "MANAGER";

  const supabase = await getServerSupabase();
  const [{ data: accounts }, { data: pages }] = await Promise.all([
    supabase
      .from("social_accounts")
      .select("id, platform, display_name, avatar_url, is_active")
      .is("disconnected_at", null)
      .order("created_at", { ascending: true }),
    supabase.from("moa_pages").select("id, social_account_id, slug, title, status, avatar_url, updated_at"),
  ]);

  const service = createServiceClient();
  const pageIds = (pages ?? []).map((p) => p.id);
  await rollupToday(service);
  const totals = await pageTotals(service, pageIds, rangeStart(7)).catch(() => new Map());

  // 확인할 것 — 판매 상태 때문에 회색 · 숨김이 된 상품, 조회가 계속 실패한 상품
  const issues = new Map<string, { gray: number; deleted: number; failing: number }>();
  if (pageIds.length > 0) {
    const { data: blocks } = await supabase
      .from("moa_blocks")
      .select("page_id, shop_code, shop_product_id, enabled")
      .in("page_id", pageIds)
      .is("deleted_at", null)
      .not("shop_code", "is", null);
    const { data: statuses } = await supabase.from("moa_product_status").select("shop_code, shop_product_id, landing_status, fail_count");
    const st = new Map((statuses ?? []).map((s) => [productKey(s.shop_code, s.shop_product_id), s]));
    for (const b of blocks ?? []) {
      if (!b.enabled || !b.shop_code || b.shop_product_id == null) continue;
      const s = st.get(productKey(b.shop_code, b.shop_product_id));
      const i = issues.get(b.page_id) ?? { gray: 0, deleted: 0, failing: 0 };
      if (s?.landing_status === "deleted") i.deleted++;
      else if (s && ["sold_out", "suspended", "sale_ended", "not_open"].includes(s.landing_status ?? "")) i.gray++;
      if ((s?.fail_count ?? 0) >= STATUS_FAIL_ALERT) i.failing++;
      issues.set(b.page_id, i);
    }
  }

  const byAccount = new Map((pages ?? []).filter((p) => p.social_account_id).map((p) => [p.social_account_id!, p]));
  const rows: MoaAccountRow[] = (accounts ?? [])
    .map((a) => {
      const p = byAccount.get(a.id);
      return {
        accountId: a.id,
        platform: a.platform,
        accountName: a.display_name ?? "(이름 없음)",
        accountAvatar: a.avatar_url,
        page: p
          ? {
              id: p.id,
              slug: p.slug,
              url: publicUrl(p.slug),
              title: p.title,
              status: p.status,
              totals: totals.get(p.id) ?? { views: 0, visits: 0, clicks: 0, clickVisits: 0 },
              issues: issues.get(p.id) ?? { gray: 0, deleted: 0, failing: 0 },
            }
          : null,
      };
    })
    // 인스타 계정 먼저, 페이지가 있는 계정 먼저
    .sort((x, y) => Number(y.platform === "INSTAGRAM") - Number(x.platform === "INSTAGRAM") || Number(!!y.page) - Number(!!x.page));

  return <MoaListPage rows={rows} canManage={canManage} />;
}

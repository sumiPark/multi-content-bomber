import { notFound, redirect } from "next/navigation";
import { MoaEditor, type MoaStatsView } from "@/components/moa/moa-editor";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { loadPageView } from "@/lib/moa/load";
import { publicUrl } from "@/lib/moa/slug";
import { pageDetailStats, rangeStart, rollupToday } from "@/lib/moa/stats";
import { createServiceClient } from "@/lib/supabase/service";

export const metadata = { title: "모아링크 꾸미기 | MCB" };

const TABS = ["blocks", "design", "settings", "stats"] as const;
type Tab = (typeof TABS)[number];
const RANGES = [1, 7, 30, 90] as const;

interface Props {
  params: Promise<{ pageId: string }>;
  searchParams: Promise<{ tab?: string; days?: string }>;
}

export default async function Page({ params, searchParams }: Props) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");
  const canManage = profile.role === "ADMIN" || profile.role === "MANAGER";

  const { pageId } = await params;
  const sp = await searchParams;
  const tab: Tab = (TABS as readonly string[]).includes(sp.tab ?? "") ? (sp.tab as Tab) : "blocks";
  const days = (RANGES as readonly number[]).includes(Number(sp.days)) ? Number(sp.days) : 7;

  if (!/^[0-9a-f-]{36}$/i.test(pageId)) notFound();
  const supabase = await getServerSupabase();
  // RLS로 조직 범위 확인 — 다른 조직 페이지면 못 읽는다
  const { data: row } = await supabase.from("moa_pages").select("*").eq("id", pageId).maybeSingle();
  if (!row) notFound();

  const service = createServiceClient();
  const [page, { data: account }, { data: others }] = await Promise.all([
    loadPageView(service, row),
    row.social_account_id
      ? supabase.from("social_accounts").select("platform, display_name").eq("id", row.social_account_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("moa_pages").select("id, slug, title").neq("id", row.id).order("created_at", { ascending: true }),
  ]);

  let stats: MoaStatsView | null = null;
  if (tab === "stats") {
    // 지운 블록의 지난 성과도 보여 주려고 지운 블록 이름까지 읽는다
    await rollupToday(service);
    const [detail, { data: allBlocks }] = await Promise.all([
      pageDetailStats(service, row.id, rangeStart(days)),
      service.from("moa_blocks").select("id, kind, title, shop_code, shop_product_id, in_auto_section, deleted_at").eq("page_id", row.id),
    ]);
    const nameOf = new Map(page.blocks.map((b) => [b.id, b.title || b.product?.name || ""]));
    stats = {
      days,
      totals: detail.totals,
      daily: detail.days,
      sources: detail.sources,
      blocks: detail.blocks,
      blockMeta: (allBlocks ?? []).map((b) => ({
        id: b.id,
        kind: b.kind,
        name: nameOf.get(b.id) || b.title || (b.shop_product_id ? `상품 ${b.shop_product_id}` : ""),
        inAutoSection: b.in_auto_section,
        deleted: !!b.deleted_at,
      })),
    };
  }

  return (
    <MoaEditor
      key={`${page.id}:${tab}`}
      page={page}
      tab={tab}
      url={publicUrl(page.slug)}
      accountName={account?.display_name ?? null}
      organizationId={profile.organization_id}
      canManage={canManage}
      otherPages={(others ?? []).map((o) => ({ id: o.id, label: o.title || o.slug }))}
      stats={stats}
    />
  );
}

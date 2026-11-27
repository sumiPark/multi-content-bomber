import { redirect } from "next/navigation";
import { PostAutomationsPage } from "@/components/post-automations/post-automations-page";
import type {
  AccountView,
  AutomationSource,
  AutomationStats,
  AutomationStatus,
  AutomationView,
  FirstCommentStatus,
  PausedReason,
  ProductView,
  TemplateView,
} from "@/components/post-automations/types";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { configSchema, defaultConfig, type AutomationConfig } from "@/lib/post-automations/config";
import { createServiceClient } from "@/lib/supabase/service";

export const metadata = {
  title: "댓글 · DM 자동화 | MCB",
};

// 처음 열면 보여 줄 계정 — 게시물 댓글 · DM 자동화는 fruit_cuma부터 쓴다(2026-11-27 기획).
// display_name으로 찾고, 없으면 첫 번째 쓸 수 있는 계정.
const DEFAULT_ACCOUNT_NAME = "fruit_cuma";
const isDefaultAccount = (name: string | null) => name?.replace(/^@/, "").toLowerCase() === DEFAULT_ACCOUNT_NAME;

// 집계용 기록은 1,000행씩 나눠 읽는다(PostgREST 한 번 응답 상한).
const EVENT_PAGE = 1000;
const EVENT_MAX_PAGES = 50;

const LIVE: AutomationStatus[] = ["ACTIVE", "PAUSED", "WAITING"];

function parseConfigSafe(json: unknown): AutomationConfig {
  const r = configSchema.safeParse(json);
  return r.success ? r.data : defaultConfig("INSTAGRAM");
}

const emptyStats = (): AutomationStats => ({ target: 0, dmSent: 0, replySent: 0, unknown: 0, failed: 0, skipped: 0, clicks: 0 });

interface PageProps {
  searchParams: Promise<{ account?: string }>;
}

export default async function Page({ searchParams }: PageProps) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const params = await searchParams;
  const supabase = await getServerSupabase();

  // RLS가 조직 범위를 건다(같은 조직 SELECT). 계정 · 설정 · 템플릿을 한 번에 읽고 고른 계정 것만 거른다.
  const [profile, { data: accountRows }, { data: automationRows }, { data: templateRows }] = await Promise.all([
    getCurrentProfile(),
    supabase
      .from("social_accounts")
      .select("id, display_name, is_active")
      .eq("platform", "INSTAGRAM")
      .is("disconnected_at", null)
      .order("created_at", { ascending: true }),
    supabase
      .from("post_automations")
      .select(
        "id, social_account_id, status, paused_reason, platform_post_id, post_permalink, post_caption, post_posted_at, starts_at, ends_at, created_at, product_id, publish_job_id, content_id, source, config, first_comment_status, first_comment_at, first_comment_error",
      )
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
    supabase
      .from("post_automation_templates")
      .select("id, name, config, created_at")
      .is("deleted_at", null)
      .order("created_at", { ascending: true }),
  ]);

  if (!profile?.organization_id) redirect("/onboarding");
  const canManage = profile.role === "ADMIN" || profile.role === "MANAGER";

  const liveCountByAccount = new Map<string, number>();
  for (const a of automationRows ?? []) {
    if (LIVE.includes(a.status as AutomationStatus)) {
      liveCountByAccount.set(a.social_account_id, (liveCountByAccount.get(a.social_account_id) ?? 0) + 1);
    }
  }

  // 기본 계정을 맨 앞, 그다음 쓸 수 있는 계정, 다시 연결이 필요한 계정은 뒤로.
  const accounts: AccountView[] = (accountRows ?? [])
    .map((a) => ({ id: a.id, name: a.display_name, isActive: a.is_active, liveCount: liveCountByAccount.get(a.id) ?? 0 }))
    .sort((x, y) => Number(isDefaultAccount(y.name)) - Number(isDefaultAccount(x.name)) || Number(y.isActive) - Number(x.isActive));

  const selected =
    accounts.find((a) => a.id === params.account) ??
    accounts.find((a) => isDefaultAccount(a.name)) ??
    accounts.find((a) => a.isActive) ??
    accounts[0] ??
    null;

  const templates: TemplateView[] = (templateRows ?? []).map((t) => ({ id: t.id, name: t.name, config: parseConfigSafe(t.config) }));

  if (!selected) {
    return <PostAutomationsPage accounts={[]} selectedAccountId={null} canManage={canManage} automations={[]} templates={templates} products={{}} />;
  }

  const rows = (automationRows ?? []).filter((a) => a.social_account_id === selected.id);
  const ids = rows.map((a) => a.id);
  const stats = new Map<string, AutomationStats>(ids.map((id) => [id, emptyStats()]));

  if (ids.length) {
    // 기록 집계 — 설정별 DM · 답글 · 확인 필요 · 실패 · 건너뜀
    for (let page = 0; page < EVENT_MAX_PAGES; page++) {
      const from = page * EVENT_PAGE;
      const { data: events } = await supabase
        .from("post_automation_events")
        .select("id, automation_id, dm_status, reply_status, step2_status, skip_reason")
        .in("automation_id", ids)
        .order("id", { ascending: true })
        .range(from, from + EVENT_PAGE - 1);
      for (const e of events ?? []) {
        const s = stats.get(e.automation_id);
        if (!s) continue;
        if (!e.skip_reason) s.target += 1;
        if (e.skip_reason || e.dm_status === "SKIPPED") s.skipped += 1;
        if (e.dm_status === "SENT") s.dmSent += 1;
        if (e.reply_status === "SENT") s.replySent += 1;
        if (e.dm_status === "UNKNOWN") s.unknown += 1;
        if (e.dm_status === "FAILED" || e.reply_status === "FAILED" || e.step2_status === "FAILED") s.failed += 1;
      }
      if (!events || events.length < EVENT_PAGE) break;
    }

    // 버튼 클릭 합계
    const { data: links } = await supabase.from("post_automation_links").select("automation_id, clicks").in("automation_id", ids);
    for (const l of links ?? []) {
      const s = stats.get(l.automation_id);
      if (s) s.clicks += l.clicks;
    }
  }

  // 연결 상품 — products는 로그인한 조직 사용자에게 열려 있다(0025). 그래도 안 읽히면 service로(읽기 전용).
  const productIds = [...new Set(rows.map((a) => a.product_id).filter((x): x is string => !!x))];
  const products: Record<string, ProductView> = {};
  if (productIds.length) {
    const select = "id, name, url, stock_status, represent_image_url";
    let { data: productRows } = await supabase.from("products").select(select).in("id", productIds);
    if (!productRows?.length) {
      ({ data: productRows } = await createServiceClient().from("products").select(select).in("id", productIds));
    }
    for (const p of productRows ?? []) {
      products[p.id] = { id: p.id, name: p.name, url: p.url, soldOut: p.stock_status !== "available", image: p.represent_image_url };
    }
  }

  const automations: AutomationView[] = rows.map((a) => ({
    id: a.id,
    status: a.status as AutomationStatus,
    pausedReason: (a.paused_reason as PausedReason | null) ?? null,
    platformPostId: a.platform_post_id,
    permalink: a.post_permalink,
    caption: a.post_caption,
    postedAt: a.post_posted_at,
    startsAt: a.starts_at,
    endsAt: a.ends_at,
    createdAt: a.created_at,
    productId: a.product_id,
    publishJobId: a.publish_job_id,
    contentId: a.content_id,
    source: a.source as AutomationSource,
    config: parseConfigSafe(a.config),
    firstStatus: a.first_comment_status as FirstCommentStatus,
    firstAt: a.first_comment_at,
    firstError: a.first_comment_error,
    stats: stats.get(a.id) ?? emptyStats(),
  }));

  return (
    <PostAutomationsPage
      accounts={accounts}
      selectedAccountId={selected.id}
      canManage={canManage}
      automations={automations}
      templates={templates}
      products={products}
    />
  );
}

import type { getServerSupabase } from "@/lib/auth";
import { checkText, type ContentRule } from "@/lib/rules/check";
import { firstLine, HIT_MULTIPLE } from "./discovery";
import type { InsightSummary, ReelStyle, StyleSource, StyleStats } from "./style-stats";

// 분석 · 다른 계정 비교 화면 데이터 (0037).

type Supabase = Awaited<ReturnType<typeof getServerSupabase>>;

// 이 기간 안의 릴스만 "잘된 릴스"로 본다 — 오래된 공식은 지금 안 먹힐 수 있다.
const HIT_WINDOW_DAYS = 180;
const HIT_LIST = 12;
// 한 계정이 목록을 독차지하지 않게 (2026-11-04 실측: 12개 중 11개가 한 계정)
const HIT_PER_ACCOUNT = 3;
// 평소의 이 배수를 넘으면 공식보다 광고 · 유명인 캠페인일 가능성이 커서 뒤로 보낸다.
// 좋아요가 많으면 광고 의심 필터에 안 걸린다 (실측: 평소의 717배, 1,474만 회에 좋아요 30만).
const CAMPAIGN_MULTIPLE = 30;

export type GroupType = "SAME" | "ADJACENT" | "LARGE";

export interface BenchmarkRow {
  linkId: string;
  accountId: string;
  username: string;
  displayName: string | null;
  biography: string | null;
  groupType: GroupType;
  reason: string | null;
  source: "SUGGESTED" | "MANUAL";
  status: string;
  error: string | null;
  followers: number | null;
  medianViews: number | null;
  reels30d: number | null;
  lastPostAt: string | null;
  lastCollectedAt: string | null;
  hits: number;
  adSuspected: number;
}

export interface BenchmarkHit {
  id: string;
  username: string;
  permalink: string | null;
  thumbnailUrl: string | null;
  hook: string;
  postedAt: string | null;
  views: number;
  likes: number | null;
  comments: number | null;
  multiple: number;
  formula: string | null;
  // 평소와 차이가 너무 커서 광고 · 유명인 영상일 수 있음
  campaign: boolean;
  // 그대로 따라 쓰면 광고 문구 규칙에 걸리는 표현
  bannedPhrases: string[];
  style: ReelStyle | null;
  styleSource: StyleSource | null;
}

export interface BenchmarkInsight {
  createdAt: string;
  stats: StyleStats;
  summary: InsightSummary;
}

export interface BenchmarkOwn {
  username: string;
  followers: number | null;
  medianViews: number | null;
  hits: number;
}

export interface BenchmarkData {
  own: BenchmarkOwn | null;
  rows: BenchmarkRow[];
  hits: BenchmarkHit[];
  insight: BenchmarkInsight | null;
}

export async function loadBenchmark(supabase: Supabase, socialAccountId: string, now: number): Promise<BenchmarkData> {
  const { data: links } = await supabase
    .from("benchmark_links")
    .select("id, group_type, reason, source, benchmark_account_id, benchmark_accounts(id, username, display_name, biography, status, error, followers_count, median_views, reels_30d, last_post_at, last_collected_at)")
    .eq("social_account_id", socialAccountId)
    .order("created_at", { ascending: true });

  const { data: ownRow } = await supabase
    .from("benchmark_accounts")
    .select("id, username, followers_count, median_views")
    .eq("own_account_id", socialAccountId)
    .maybeSingle();

  const accountIds = (links ?? []).map((l) => l.benchmark_account_id);
  const allIds = ownRow ? [...accountIds, ownRow.id] : accountIds;
  const since = new Date(now - HIT_WINDOW_DAYS * 86_400_000).toISOString();
  const { data: posts } = allIds.length
    ? await supabase
        .from("benchmark_posts")
        .select("id, benchmark_account_id, permalink, thumbnail_url, caption, posted_at, view_count, like_count, comments_count, multiple, ad_suspected, formula, style, style_source")
        .in("benchmark_account_id", allIds)
        .eq("media_product_type", "REELS")
        .gte("multiple", HIT_MULTIPLE)
        .gte("posted_at", since)
        .order("multiple", { ascending: false })
        .limit(500)
    : { data: [] };

  const hitCount = new Map<string, number>();
  const adCount = new Map<string, number>();
  for (const p of posts ?? []) {
    const m = p.ad_suspected ? adCount : hitCount;
    m.set(p.benchmark_account_id, (m.get(p.benchmark_account_id) ?? 0) + 1);
  }

  const rows: BenchmarkRow[] = (links ?? []).flatMap((l) => {
    const a = l.benchmark_accounts as unknown as {
      id: string; username: string; display_name: string | null; biography: string | null; status: string; error: string | null;
      followers_count: number | null; median_views: number | null; reels_30d: number | null; last_post_at: string | null; last_collected_at: string | null;
    } | null;
    if (!a) return [];
    return [{
      linkId: l.id,
      accountId: a.id,
      username: a.username,
      displayName: a.display_name,
      biography: a.biography,
      groupType: l.group_type as GroupType,
      reason: l.reason,
      source: l.source as BenchmarkRow["source"],
      status: a.status,
      error: a.error,
      followers: a.followers_count,
      medianViews: a.median_views,
      reels30d: a.reels_30d,
      lastPostAt: a.last_post_at,
      lastCollectedAt: a.last_collected_at,
      hits: hitCount.get(a.id) ?? 0,
      adSuspected: adCount.get(a.id) ?? 0,
    }];
  });

  // 광고 문구 규칙 — 다른 계정의 상품 종류는 모르므로 모든 규칙을 본다
  const { data: ruleRows } = await supabase
    .from("content_rules")
    .select("id, rule_type, phrase, match_type, reason, suggestion")
    .eq("active", true)
    .eq("rule_type", "BANNED");
  const rules: ContentRule[] = (ruleRows ?? []).map((r) => ({
    id: r.id,
    scope: "ALL",
    ruleType: "BANNED",
    phrase: r.phrase,
    matchType: r.match_type as ContentRule["matchType"],
    reason: r.reason,
    suggestion: r.suggestion,
  }));

  const usernameOf = new Map(rows.map((r) => [r.accountId, r.username]));
  const perAccount = new Map<string, number>();
  const usable = (posts ?? []).filter((p) => !p.ad_suspected && usernameOf.has(p.benchmark_account_id));
  // 배수 순(쿼리 순서) 그대로, 캠페인으로 보이는 것만 뒤로
  const ordered = [
    ...usable.filter((p) => Number(p.multiple) < CAMPAIGN_MULTIPLE),
    ...usable.filter((p) => Number(p.multiple) >= CAMPAIGN_MULTIPLE),
  ];
  const hits: BenchmarkHit[] = ordered
    .filter((p) => {
      const n = perAccount.get(p.benchmark_account_id) ?? 0;
      if (n >= HIT_PER_ACCOUNT) return false;
      perAccount.set(p.benchmark_account_id, n + 1);
      return true;
    })
    .slice(0, HIT_LIST)
    .map((p) => {
      const hook = firstLine(p.caption);
      return {
        id: p.id,
        username: usernameOf.get(p.benchmark_account_id) as string,
        permalink: p.permalink,
        thumbnailUrl: p.thumbnail_url,
        hook,
        postedAt: p.posted_at,
        views: p.view_count ?? 0,
        likes: p.like_count,
        comments: p.comments_count,
        multiple: Number(p.multiple),
        formula: p.formula,
        campaign: Number(p.multiple) >= CAMPAIGN_MULTIPLE,
        bannedPhrases: [...new Set(checkText(hook, "OTHER", rules).flatMap((h) => (h.matched ? [h.matched] : [])))],
        style: (p.style ?? null) as unknown as ReelStyle | null,
        styleSource: p.style_source as StyleSource | null,
      };
    });

  const { data: analysis } = await supabase
    .from("benchmark_analyses")
    .select("created_at, stats, summary")
    .eq("social_account_id", socialAccountId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    insight: analysis ? { createdAt: analysis.created_at, stats: analysis.stats as unknown as StyleStats, summary: analysis.summary as unknown as InsightSummary } : null,
    own: ownRow
      ? { username: ownRow.username, followers: ownRow.followers_count, medianViews: ownRow.median_views, hits: hitCount.get(ownRow.id) ?? 0 }
      : null,
    rows,
    hits,
  };
}

import type { getServerSupabase } from "@/lib/auth";
import { firstLine } from "@/lib/benchmark/discovery";
import { formatOf, isCtaLike, isEventLike, type ReelRow } from "./stats";

// 분석 · 게시물 성과 화면 데이터 — 워커(sync-post-history)가 쌓은 값만 읽는다. 인스타를 부르지 않는다.
// 고른 기간의 게시물만 읽는다. 전체 기간은 게시물이 수천 개인 계정이 있어 화면이 느려진다.
// 조회수가 없는 게시물은 비교할 수 없어 목록에서 뺀다.

type Supabase = Awaited<ReturnType<typeof getServerSupabase>>;

const PAGE = 1000;
const SIGN_BATCH = 200;
const SIGN_MAX = 800;

export interface PerfRow extends ReelRow {
  eventLike: boolean;
  ctaLike: boolean;
}

export interface PerfFinding {
  title: string;
  // 2026-11-04 이전 분석에는 없다
  stat?: string;
  detail: string;
  caveat: string;
}

export interface PerfAction {
  label: string;
  text: string;
}

export interface PostAnalysis {
  headline: string | null;
  findings: PerfFinding[];
  actions: PerfAction[];
  createdAt: string;
  reels: number;
}

export interface PostPerformanceData {
  rows: PerfRow[];
  listed: boolean;
  // 기간과 상관없는 계정 전체 숫자 — 첫 수집 진행 안내용
  total: number;
  read: number;
  pending: number;
  // 인스타가 조회수를 주지 않아 읽지 않은 2024년 이전 피드 게시물
  skipped: number;
  analysis: PostAnalysis | null;
}

export async function loadPostPerformance(supabase: Supabase, socialAccountId: string, from: number): Promise<PostPerformanceData> {
  type Row = {
    post_id: string; platform_media_id: string; media_type: string | null; media_product_type: string | null; permalink: string | null; caption: string | null; thumb_path: string | null;
    posted_at: string | null; views: number | null; reach: number | null; likes: number | null;
    comments: number | null; saved: number | null; shares: number | null; avg_watch_time_ms: number | null;
  };
  const raw: Row[] = [];
  for (let start = 0; ; start += PAGE) {
    let q = supabase
      .from("account_post_stats")
      .select("post_id, platform_media_id, media_type, media_product_type, permalink, caption, thumb_path, posted_at, views, reach, likes, comments, saved, shares, avg_watch_time_ms")
      .eq("social_account_id", socialAccountId)
      .not("views", "is", null);
    if (from) q = q.gte("posted_at", new Date(from).toISOString());
    const { data } = await q.order("posted_at", { ascending: false }).range(start, start + PAGE - 1);
    raw.push(...((data ?? []) as Row[]));
    if (!data || data.length < PAGE) break;
  }

  const counted = () => supabase.from("account_post_stats").select("post_id", { count: "exact", head: true }).eq("social_account_id", socialAccountId);
  const [{ count: total }, { count: pending }] = await Promise.all([counted(), counted().is("views", null).is("insights_checked_at", null)]);

  // 공개 조회수 — 다른 계정 비교 수집이 읽은 최근 릴스만 있다
  const { data: own } = await supabase.from("benchmark_accounts").select("id").eq("own_account_id", socialAccountId).maybeSingle();
  const { data: pub } = own
    ? await supabase.from("benchmark_posts").select("platform_media_id, view_count").eq("benchmark_account_id", own.id).not("view_count", "is", null)
    : { data: [] };
  const publicViews = new Map((pub ?? []).map((p) => [p.platform_media_id, p.view_count as number]));

  // 보관한 표지 — 비공개 저장소라 서명 주소
  const paths = raw.flatMap((r) => (r.thumb_path ? [r.thumb_path] : [])).slice(0, SIGN_MAX);
  const signed = new Map<string, string>();
  for (let i = 0; i < paths.length; i += SIGN_BATCH) {
    const { data } = await supabase.storage.from("media").createSignedUrls(paths.slice(i, i + SIGN_BATCH), 3600);
    for (const s of data ?? []) if (s.path && s.signedUrl) signed.set(s.path, s.signedUrl);
  }

  const rows: PerfRow[] = raw.map((r) => {
    const caption = r.caption ?? "";
    const format = formatOf(r.media_product_type, r.media_type);
    return {
      id: r.post_id,
      format,
      mediaId: r.platform_media_id,
      postedAt: r.posted_at,
      url: r.permalink,
      title: firstLine(caption) || "(캡션 없음)",
      views: r.views,
      publicViews: format === "REELS" ? publicViews.get(r.platform_media_id) ?? null : null,
      reach: r.reach,
      likes: r.likes,
      comments: r.comments,
      shares: r.shares,
      saved: r.saved,
      watchSec: r.avg_watch_time_ms != null ? r.avg_watch_time_ms / 1000 : null,
      thumb: r.thumb_path ? signed.get(r.thumb_path) ?? null : null,
      eventLike: isEventLike(caption),
      ctaLike: isCtaLike(caption),
    };
  });

  const { data: sync } = await supabase.from("post_history_sync").select("all_listed_at, media_listed").eq("social_account_id", socialAccountId).maybeSingle();
  const { data: analysis } = await supabase
    .from("post_analyses")
    .select("headline, findings, actions, created_at, reels_count")
    .eq("social_account_id", socialAccountId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    rows,
    listed: !!sync?.all_listed_at,
    total: total ?? rows.length,
    read: (total ?? rows.length) - (pending ?? 0),
    pending: pending ?? 0,
    skipped: sync?.all_listed_at ? Math.max(0, (sync.media_listed ?? 0) - (total ?? 0)) : 0,
    analysis: analysis
      ? {
          headline: analysis.headline,
          findings: (analysis.findings ?? []) as unknown as PerfFinding[],
          actions: (analysis.actions ?? []) as unknown as PerfAction[],
          createdAt: analysis.created_at,
          reels: analysis.reels_count,
        }
      : null,
  };
}

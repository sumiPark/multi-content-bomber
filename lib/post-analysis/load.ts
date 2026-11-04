import type { getServerSupabase } from "@/lib/auth";
import { firstLine } from "@/lib/benchmark/discovery";
import { isCtaLike, isEventLike, type ReelRow } from "./stats";

// 분석 · 게시물 성과 화면 데이터 — 워커(sync-post-history)가 쌓은 값만 읽는다. 인스타를 부르지 않는다.
// 고른 기간의 릴스만 읽는다. 전체 기간은 릴스가 1,000개 넘는 계정이 있어 화면이 느려진다(2026-11-04 fruit_cuma 1,151개).

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
  analysis: PostAnalysis | null;
}

export async function loadPostPerformance(supabase: Supabase, socialAccountId: string, from: number): Promise<PostPerformanceData> {
  type Row = {
    post_id: string; platform_media_id: string; permalink: string | null; caption: string | null; thumb_path: string | null;
    posted_at: string | null; views: number | null; reach: number | null; likes: number | null;
    comments: number | null; saved: number | null; shares: number | null; avg_watch_time_ms: number | null;
  };
  const raw: Row[] = [];
  for (let start = 0; ; start += PAGE) {
    let q = supabase
      .from("account_reel_stats")
      .select("post_id, platform_media_id, permalink, caption, thumb_path, posted_at, views, reach, likes, comments, saved, shares, avg_watch_time_ms")
      .eq("social_account_id", socialAccountId);
    if (from) q = q.gte("posted_at", new Date(from).toISOString());
    const { data } = await q.order("posted_at", { ascending: false }).range(start, start + PAGE - 1);
    raw.push(...((data ?? []) as Row[]));
    if (!data || data.length < PAGE) break;
  }

  const counted = () => supabase.from("account_reel_stats").select("post_id", { count: "exact", head: true }).eq("social_account_id", socialAccountId);
  const [{ count: total }, { count: read }, { count: pending }] = await Promise.all([
    counted(),
    counted().not("views", "is", null),
    counted().is("views", null).is("insights_checked_at", null),
  ]);

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
    return {
      id: r.post_id,
      mediaId: r.platform_media_id,
      postedAt: r.posted_at,
      url: r.permalink,
      title: firstLine(caption) || "(캡션 없음)",
      views: r.views,
      publicViews: publicViews.get(r.platform_media_id) ?? null,
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

  const { data: sync } = await supabase.from("post_history_sync").select("listed_at").eq("social_account_id", socialAccountId).maybeSingle();
  const { data: analysis } = await supabase
    .from("post_analyses")
    .select("headline, findings, actions, created_at, reels_count")
    .eq("social_account_id", socialAccountId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    rows,
    listed: !!sync?.listed_at,
    total: total ?? rows.length,
    read: read ?? 0,
    pending: pending ?? 0,
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

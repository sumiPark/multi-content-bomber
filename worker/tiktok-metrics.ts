import { decryptToken } from "@/lib/crypto";
import {
  getBusinessAccount,
  listVideos,
  TikTokBusinessError,
  VIDEO_BASIC_FIELDS,
  VIDEO_INSIGHT_FIELDS,
  type TikTokBusinessAccount,
  type TikTokDailyMetric,
  type TikTokVideo,
} from "@/lib/platforms/tiktok-business";
import { RateLimitedError, TokenExpiredError } from "@/lib/platforms/types";
import { warnIfError } from "@/lib/supabase/result";
import type { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// ─────────────────────────────────────────────────────────────────────────────
// TikTok 성과 수집 — collect-metrics.ts가 인스타 다음에 부른다(2026-11-13).
// 인스타와 같은 표에 쌓는다: account_daily(오늘 날짜 행) · social_posts · post_metrics(오늘 날짜 행).
// 분석 화면 · 대시보드는 아직 인스타만 보여 준다 — TikTok은 수집만(화면은 따로 확인 후).
//
//   · 계정 숫자: /business/get/ (팔로워 · 팔로잉 · 영상 수 · 받은 좋아요)
//   · 하루 성과: /business/get/의 metrics[] (TikTok 쪽 집계가 24~48시간 늦어 어제 값이 비어 있을 수 있다)
//   · 게시물: /business/video/list/ — 조회 · 도달 · 좋아요 · 댓글 · 공유 · 저장(favorites) · 시청 시간
// 성과 권한(user.insights · video.insights)이 없으면 TikTok이 호출 전체를 40130으로 거절해,
// 그때는 기본 숫자만 다시 읽는다.
// ─────────────────────────────────────────────────────────────────────────────

type Service = ReturnType<typeof createServiceClient>;

export type TikTokAccountRow = {
  id: string;
  organization_id: string;
  display_name: string | null;
  platform_account_id: string;
  access_token_encrypted: string | null;
};

export type TikTokAccountResult = {
  account: string;
  status: "ok" | "token_expired" | "rate_limited" | "error";
  insights: boolean;
  posts: number;
  message?: string;
};

const DAY_MS = 24 * 60 * 60_000;
const TRACK_DAYS = 30;
const MIN_RECENT_POSTS = 30;
const MAX_POSTS = 150;
const SCOPE_MISSING = 40130;

const PROFILE_FIELDS = ["username", "display_name", "followers_count", "following_count", "videos_count", "total_likes"];
const DAY_FIELDS = [
  "video_views",
  "unique_video_views",
  "profile_views",
  "likes",
  "comments",
  "shares",
  "followers_count",
  "daily_new_followers",
  "daily_lost_followers",
];

function isScopeMissing(err: unknown): boolean {
  return err instanceof TikTokBusinessError && err.code === SCOPE_MISSING;
}

function toInt(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

function sum(...vals: unknown[]): number | null {
  const nums = vals.map(toInt);
  return nums.some((n) => n !== null) ? nums.reduce<number>((a, n) => a + (n ?? 0), 0) : null;
}

/** 초 단위 시청 시간 → ms */
function secToMs(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1000) : null;
}

function utcDate(offsetDays: number, now = Date.now()): string {
  return new Date(now + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

function pickTracked(videos: TikTokVideo[], now = Date.now()): TikTokVideo[] {
  const cutoff = (now - TRACK_DAYS * DAY_MS) / 1000;
  return videos.filter((v, i) => i < MIN_RECENT_POSTS || (typeof v.create_time === "number" && v.create_time >= cutoff));
}

export async function collectTikTokAccount(
  service: Service,
  account: TikTokAccountRow,
  today: string,
): Promise<TikTokAccountResult> {
  const label = `${account.display_name ?? account.id} (TikTok)`;
  if (!account.access_token_encrypted) {
    return { account: label, status: "error", insights: false, posts: 0, message: "토큰 없음" };
  }
  const token = decryptToken(account.access_token_encrypted);
  const businessId = account.platform_account_id;

  try {
    // 1. 계정 숫자 + 하루 성과
    let profile: TikTokBusinessAccount;
    try {
      profile = await getBusinessAccount(token, businessId, PROFILE_FIELDS);
    } catch (err) {
      if (!isScopeMissing(err)) throw err;
      profile = await getBusinessAccount(token, businessId, ["username", "display_name"]);
    }

    let insights = true;
    let day: TikTokDailyMetric | null = null;
    try {
      // 어제(UTC) 하루. 집계가 늦으면 행이 없을 수 있다 — 그때는 비워 둔다.
      const yesterday = utcDate(-1);
      const data = await getBusinessAccount(token, businessId, DAY_FIELDS, { startDate: yesterday, endDate: yesterday });
      day = (data.metrics ?? []).find((m) => m.date === yesterday) ?? data.metrics?.[0] ?? null;
    } catch (err) {
      if (!isScopeMissing(err)) throw err;
      insights = false;
    }

    const { error: dailyErr } = await service.from("account_daily").upsert(
      {
        social_account_id: account.id,
        day: today,
        organization_id: account.organization_id,
        followers_count: toInt(profile.followers_count),
        follows_count: toInt(profile.following_count),
        media_count: toInt(profile.videos_count),
        reach: null,
        views: toInt(day?.video_views),
        accounts_engaged: null,
        total_interactions: day ? sum(day.likes, day.comments, day.shares) : null,
        raw: { platform: "TIKTOK", profile, day, insights } as unknown as Json,
        collected_at: new Date().toISOString(),
      },
      { onConflict: "social_account_id,day" },
    );
    if (dailyErr) throw new Error(`account_daily 저장 실패: ${dailyErr.message}`);

    // 2. 최근 게시물(성과 포함). 성과 권한이 없으면 기본 숫자만.
    let videos: TikTokVideo[];
    try {
      videos = await listVideos(token, businessId, [...VIDEO_BASIC_FIELDS, ...VIDEO_INSIGHT_FIELDS], MAX_POSTS);
    } catch (err) {
      if (!isScopeMissing(err)) throw err;
      insights = false;
      videos = await listVideos(token, businessId, VIDEO_BASIC_FIELDS, MAX_POSTS);
    }
    videos = pickTracked(videos);
    if (videos.length === 0) return { account: label, status: "ok", insights, posts: 0 };

    // MCB로 올린 게시물이면 발행 작업과 연결 (publish_jobs.platform_post_id = TikTok 게시물 id).
    const { data: jobs } = await service
      .from("publish_jobs")
      .select("id, platform_post_id")
      .eq("social_account_id", account.id)
      .in("platform_post_id", videos.map((v) => v.item_id));
    const jobByItem = new Map((jobs ?? []).map((j) => [j.platform_post_id as string, j.id]));

    const { data: posts, error: postErr } = await service
      .from("social_posts")
      .upsert(
        videos.map((v) => ({
          organization_id: account.organization_id,
          social_account_id: account.id,
          platform_media_id: v.item_id,
          publish_job_id: jobByItem.get(v.item_id) ?? null,
          media_type: v.media_type ?? "VIDEO",
          media_product_type: "TIKTOK",
          permalink: v.share_url ?? null,
          caption: v.caption ? Array.from(v.caption).slice(0, 2000).join("") : null,
          thumbnail_url: v.thumbnail_url ?? null,
          posted_at: typeof v.create_time === "number" ? new Date(v.create_time * 1000).toISOString() : null,
        })),
        { onConflict: "social_account_id,platform_media_id" },
      )
      .select("id, platform_media_id");
    if (postErr) throw new Error(`social_posts 저장 실패: ${postErr.message}`);
    const postIdByItem = new Map((posts ?? []).map((p) => [p.platform_media_id, p.id]));

    // 3. 게시물 성과 — 목록 응답에 같이 온 값(누적)을 오늘 날짜 행으로.
    const rows = videos.flatMap((v) => {
      const postId = postIdByItem.get(v.item_id);
      if (!postId) return [];
      return [
        {
          post_id: postId,
          collected_on: today,
          views: toInt(v.video_views),
          reach: toInt(v.reach),
          likes: toInt(v.likes),
          comments: toInt(v.comments),
          saved: toInt(v.favorites),
          shares: toInt(v.shares),
          total_interactions: sum(v.likes, v.comments, v.shares, v.favorites),
          avg_watch_time_ms: secToMs(v.average_time_watched),
          total_watch_time_ms: secToMs(v.total_time_watched),
          raw: v as unknown as Json,
          collected_at: new Date().toISOString(),
        },
      ];
    });
    const { error: metricErr } = await service.from("post_metrics").upsert(rows, { onConflict: "post_id,collected_on" });
    if (metricErr) throw new Error(`post_metrics 저장 실패: ${metricErr.message}`);

    return { account: label, status: "ok", insights, posts: rows.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof TokenExpiredError) {
      // 발행 워커와 같은 정책 — 비활성으로 표시해 계정 연동 화면에서 재연결을 유도한다.
      warnIfError(
        await service
          .from("social_accounts")
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq("id", account.id),
        `계정 비활성 표시 (id=${account.id})`,
      );
      return { account: label, status: "token_expired", insights: false, posts: 0, message };
    }
    if (err instanceof RateLimitedError) {
      return { account: label, status: "rate_limited", insights: false, posts: 0, message };
    }
    return { account: label, status: "error", insights: false, posts: 0, message };
  }
}

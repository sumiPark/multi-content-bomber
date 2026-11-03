// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions에선 no-op).
import "./load-env";

import { decryptToken } from "@/lib/crypto";
import { InstagramApiError } from "@/lib/platforms/instagram-comments";
import {
  getAccountDayInsights,
  getMediaInsights,
  getProfile,
  isPermissionError,
  listRecentMedia,
  type InstagramMedia,
  type MetricValues,
} from "@/lib/platforms/instagram-insights";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// ─────────────────────────────────────────────────────────────────────────────
// 성과 수집 워커 — 성과 분석 에이전트(6)의 수집 부분. "한 번 실행하고 종료"하는 배치.
//
// .github/workflows/metrics.yml이 깨운다:
//   · schedule 매일 04시(KST)   → 하루 스냅샷
//   · repository_dispatch       → 분석 화면의 "지금 수집" 버튼
//
// 계정마다:
//   1. 프로필 숫자(팔로워 · 팔로잉 · 게시물 수) + 전날 하루 성과 → account_daily (오늘 날짜 행)
//   2. 최근 게시물 → social_posts (MCB로 올린 건 publish_jobs와 연결)
//   3. 게시물 성과 → post_metrics (오늘 날짜 행) — 같은 날 다시 돌면 덮어쓴다
//
// 성과 권한(instagram_business_manage_insights)이 없는 계정은 1의 프로필 숫자와 게시물
// 좋아요 · 댓글 수만 쌓는다(기본 권한으로 읽힘). 다시 연결하면 다음 수집부터 전부 채워진다.
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60_000;
const KST_OFFSET_MS = 9 * 60 * 60_000;
// 최근 이 기간에 올린 게시물은 매일 다시 잰다(성장 곡선). 그보다 오래된 건 최근 N개 안에 들 때만.
const TRACK_DAYS = 30;
const MIN_RECENT_POSTS = 30;
// 하루 4개 운영이면 30일 ≈ 120개.
const MAX_POSTS = 150;

type Service = ReturnType<typeof createServiceClient>;

type AccountRow = {
  id: string;
  organization_id: string;
  display_name: string | null;
  access_token_encrypted: string | null;
};

type AccountResult = {
  account: string;
  status: "ok" | "token_expired" | "rate_limited" | "error";
  insights: boolean;
  posts: number;
  message?: string;
};

/** KST 기준 오늘 날짜(YYYY-MM-DD)와 전날 하루 구간 [since, until) (unix 초). */
function kstWindow(now = Date.now()) {
  const kstNow = now + KST_OFFSET_MS;
  const todayStartKst = Math.floor(kstNow / DAY_MS) * DAY_MS; // KST 자정 (KST 시계 기준)
  const todayStartUtc = todayStartKst - KST_OFFSET_MS;
  return {
    today: new Date(todayStartKst).toISOString().slice(0, 10),
    since: Math.floor((todayStartUtc - DAY_MS) / 1000),
    until: Math.floor(todayStartUtc / 1000),
  };
}

function toInt(v: number | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

function pickTracked(media: InstagramMedia[], now = Date.now()): InstagramMedia[] {
  const cutoff = now - TRACK_DAYS * DAY_MS;
  return media.filter((m, i) => {
    if (i < MIN_RECENT_POSTS) return true;
    const t = m.timestamp ? Date.parse(m.timestamp) : NaN;
    return Number.isFinite(t) && t >= cutoff;
  });
}

async function collectAccount(
  service: Service,
  account: AccountRow,
  win: ReturnType<typeof kstWindow>,
): Promise<AccountResult> {
  const label = account.display_name ?? account.id;
  if (!account.access_token_encrypted) {
    return { account: label, status: "error", insights: false, posts: 0, message: "토큰 없음" };
  }
  const token = decryptToken(account.access_token_encrypted);

  try {
    // 1. 프로필 + 전날 하루 성과
    const profile = await getProfile(token);
    let insights = true;
    let day: MetricValues = {};
    try {
      day = await getAccountDayInsights(token, win.since, win.until);
    } catch (err) {
      if (!isPermissionError(err)) throw err;
      insights = false;
    }

    const { error: dailyErr } = await service.from("account_daily").upsert(
      {
        social_account_id: account.id,
        day: win.today,
        organization_id: account.organization_id,
        followers_count: profile.followersCount,
        follows_count: profile.followsCount,
        media_count: profile.mediaCount,
        reach: toInt(day.reach),
        views: toInt(day.views),
        accounts_engaged: toInt(day.accounts_engaged),
        total_interactions: toInt(day.total_interactions),
        raw: { profile, day, insights } as unknown as Json,
        collected_at: new Date().toISOString(),
      },
      { onConflict: "social_account_id,day" },
    );
    if (dailyErr) throw new Error(`account_daily 저장 실패: ${dailyErr.message}`);

    // 2. 최근 게시물
    const media = pickTracked(await listRecentMedia(token, MAX_POSTS));
    if (media.length === 0) {
      return { account: label, status: "ok", insights, posts: 0 };
    }

    // MCB로 올린 게시물이면 발행 작업과 연결 (publish_jobs.platform_post_id = 인스타 media id).
    const { data: jobs } = await service
      .from("publish_jobs")
      .select("id, platform_post_id")
      .eq("social_account_id", account.id)
      .in(
        "platform_post_id",
        media.map((m) => m.id),
      );
    const jobByMedia = new Map(
      (jobs ?? []).map((j) => [j.platform_post_id as string, j.id]),
    );

    const { data: posts, error: postErr } = await service
      .from("social_posts")
      .upsert(
        media.map((m) => ({
          organization_id: account.organization_id,
          social_account_id: account.id,
          platform_media_id: m.id,
          publish_job_id: jobByMedia.get(m.id) ?? null,
          media_type: m.mediaType,
          media_product_type: m.mediaProductType,
          permalink: m.permalink,
          caption: m.caption?.slice(0, 2000) ?? null,
          thumbnail_url: m.thumbnailUrl,
          posted_at: m.timestamp,
        })),
        { onConflict: "social_account_id,platform_media_id" },
      )
      .select("id, platform_media_id");
    if (postErr) throw new Error(`social_posts 저장 실패: ${postErr.message}`);
    const postIdByMedia = new Map(
      (posts ?? []).map((p) => [p.platform_media_id, p.id]),
    );

    // 3. 게시물 성과 — 권한이 없으면 좋아요 · 댓글 수(기본 권한)만.
    const rows = [];
    for (const m of media) {
      const postId = postIdByMedia.get(m.id);
      if (!postId) continue;
      let v: MetricValues = {};
      if (insights) {
        try {
          v = await getMediaInsights(token, m);
        } catch (err) {
          if (!isPermissionError(err)) throw err;
          insights = false;
        }
      }
      rows.push({
        post_id: postId,
        collected_on: win.today,
        views: toInt(v.views),
        reach: toInt(v.reach),
        likes: toInt(v.likes) ?? m.likeCount,
        comments: toInt(v.comments) ?? m.commentsCount,
        saved: toInt(v.saved),
        shares: toInt(v.shares),
        total_interactions: toInt(v.total_interactions),
        avg_watch_time_ms: toInt(v.ig_reels_avg_watch_time),
        total_watch_time_ms: toInt(v.ig_reels_video_view_total_time),
        raw: v as unknown as Json,
        collected_at: new Date().toISOString(),
      });
    }
    const { error: metricErr } = await service
      .from("post_metrics")
      .upsert(rows, { onConflict: "post_id,collected_on" });
    if (metricErr) throw new Error(`post_metrics 저장 실패: ${metricErr.message}`);

    return { account: label, status: "ok", insights, posts: rows.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof InstagramApiError && err.kind === "TOKEN") {
      // 발행 워커와 같은 정책 — 비활성으로 표시해 계정 연동 화면에서 재연결을 유도한다.
      await service
        .from("social_accounts")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("id", account.id);
      return { account: label, status: "token_expired", insights: false, posts: 0, message };
    }
    if (err instanceof InstagramApiError && err.kind === "RATE_LIMIT") {
      return { account: label, status: "rate_limited", insights: false, posts: 0, message };
    }
    return { account: label, status: "error", insights: false, posts: 0, message };
  }
}

async function main() {
  const service = createServiceClient();
  const startedAt = Date.now();
  const win = kstWindow(startedAt);

  const { data, error } = await service
    .from("social_accounts")
    .select("id, organization_id, display_name, access_token_encrypted")
    .eq("platform", "INSTAGRAM")
    .eq("is_active", true)
    .is("disconnected_at", null)
    .not("access_token_encrypted", "is", null);
  if (error) {
    console.error("[collect-metrics] 계정 조회 실패:", error.message);
    process.exitCode = 1;
    return;
  }
  const accounts = (data ?? []) as AccountRow[];
  if (accounts.length === 0) {
    console.log("[collect-metrics] 수집할 인스타 계정 없음");
    return;
  }

  // 계정이 4개라 순서대로 — 계정마다 호출 한도가 따로라 병렬의 이득이 작고, 로그가 읽기 쉽다.
  const results: AccountResult[] = [];
  for (const account of accounts) {
    const r = await collectAccount(service, account, win);
    console.log(
      `[collect-metrics] ${r.account}: ${r.status} | 게시물 ${r.posts}개 | 성과 권한 ${r.insights ? "있음" : "없음"}` +
        (r.message ? ` | ${r.message}` : ""),
    );
    results.push(r);
  }

  if (results.every((r) => r.status !== "ok")) process.exitCode = 1;
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[collect-metrics] 완료 day=${win.today} | ${elapsed}s`);
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("[collect-metrics] 치명적 오류:", err);
    process.exit(1);
  });

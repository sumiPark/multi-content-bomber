import "./server-guard";
import { InstagramApiError, instagramRequest } from "./instagram-comments";

// 계정 분석용 인스타 성과 API (Instagram 로그인, graph.instagram.com).
//
// 권한:
//   - 프로필 숫자(팔로워 · 팔로잉 · 게시물 수), 게시물 목록, 좋아요 · 댓글 수
//       → instagram_business_basic (이미 있음)
//   - 게시물 성과(조회 · 도달 · 저장 · 공유 · 시청 시간), 계정 하루 성과
//       → instagram_business_manage_insights (0024에서 추가 — 다시 연결해야 생김)
//   성과 권한이 없으면 insights 호출만 실패하고 프로필 · 목록은 그대로 수집된다.
//
// 지표 이름 (v22부터 impressions · plays가 빠지고 views로 통일):
//   게시물: views, reach, likes, comments, saved, shares, total_interactions
//           릴스는 + ig_reels_avg_watch_time, ig_reels_video_view_total_time (ms)
//   계정:   reach, views, accounts_engaged, total_interactions (period=day, total_value)
// 계정 전환 전에 올린 게시물 등은 일부 지표가 "지원 안 함(100)"으로 거절된다 — 그때는
// 지표를 하나씩 다시 물어 되는 것만 받는다.
//
// 비즈니스 시스템 사용자 토큰(IG_DISCOVERY_TOKEN, 비즈니스 설정의 mcb): 계정마다 다시 연결하지 않아도
// 할당된 인스타 계정의 성과를 읽는다(graph.facebook.com). 2026-11-04 실측 — 같은 게시물 ID · 같은 지표
// 이름으로 읽히고, fruit_cuma 83개 연속 호출에도 사용량 1%. 인스타 ID가 Instagram 로그인의 ID와
// 달라서(17841…) 계정은 아이디(username)로 맞춘다. 게시 · 댓글 권한이 없는 읽기 전용 키다.

const GRAPH_API_BASE = "https://graph.instagram.com/v23.0";
const SYSTEM_API_BASE = "https://graph.facebook.com/v26.0";

const MEDIA_METRICS = [
  "views",
  "reach",
  "likes",
  "comments",
  "saved",
  "shares",
  "total_interactions",
] as const;
const REELS_EXTRA_METRICS = [
  "ig_reels_avg_watch_time",
  "ig_reels_video_view_total_time",
] as const;
const ACCOUNT_METRICS = [
  "reach",
  "views",
  "accounts_engaged",
  "total_interactions",
] as const;

export interface InstagramProfile {
  id: string;
  username: string;
  followersCount: number | null;
  followsCount: number | null;
  mediaCount: number | null;
  profilePictureUrl: string | null;
}

export interface InstagramMedia {
  id: string;
  caption: string | null;
  mediaType: string | null; // IMAGE / VIDEO / CAROUSEL_ALBUM
  mediaProductType: string | null; // FEED / REELS
  permalink: string | null;
  thumbnailUrl: string | null;
  timestamp: string | null;
  likeCount: number | null;
  commentsCount: number | null;
}

// 지표 이름 → 값. 받지 못한 지표는 키가 없다.
export type MetricValues = Record<string, number>;

function graphUrl(path: string, token: string, params: Record<string, string>, base = GRAPH_API_BASE) {
  const url = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", token);
  return url.toString();
}

export async function getProfile(token: string): Promise<InstagramProfile> {
  const me = await instagramRequest<{
    user_id?: string;
    id: string;
    username: string;
    followers_count?: number;
    follows_count?: number;
    media_count?: number;
    profile_picture_url?: string;
  }>(
    graphUrl("/me", token, {
      fields:
        "user_id,username,followers_count,follows_count,media_count,profile_picture_url",
    }),
  );
  return {
    id: String(me.user_id ?? me.id),
    username: me.username,
    followersCount: me.followers_count ?? null,
    followsCount: me.follows_count ?? null,
    mediaCount: me.media_count ?? null,
    profilePictureUrl: me.profile_picture_url ?? null,
  };
}

/** 최근 게시물 (최신순). 스토리는 이 목록에 나오지 않는다. */
export async function listRecentMedia(
  token: string,
  limit: number,
): Promise<InstagramMedia[]> {
  type Row = {
    id: string;
    caption?: string;
    media_type?: string;
    media_product_type?: string;
    permalink?: string;
    thumbnail_url?: string;
    media_url?: string;
    timestamp?: string;
    like_count?: number;
    comments_count?: number;
  };
  const out: InstagramMedia[] = [];
  let next: string | null = graphUrl("/me/media", token, {
    fields:
      "id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count",
    limit: String(Math.min(limit, 50)),
  });
  while (next && out.length < limit) {
    const page: { data: Row[]; paging?: { next?: string } } =
      await instagramRequest(next);
    for (const m of page.data) {
      out.push({
        id: m.id,
        caption: m.caption ?? null,
        mediaType: m.media_type ?? null,
        mediaProductType: m.media_product_type ?? null,
        permalink: m.permalink ?? null,
        // 영상은 thumbnail_url, 이미지 · 캐러셀(첫 장)은 media_url이 미리보기.
        thumbnailUrl:
          m.thumbnail_url ?? (m.media_type !== "VIDEO" ? m.media_url ?? null : null),
        timestamp: m.timestamp ?? null,
        likeCount: m.like_count ?? null,
        commentsCount: m.comments_count ?? null,
      });
    }
    next = page.paging?.next ?? null;
  }
  return out.slice(0, limit);
}

type InsightRow = {
  name: string;
  values?: { value: number }[];
  total_value?: { value: number };
};

function readInsights(rows: InsightRow[]): MetricValues {
  const out: MetricValues = {};
  for (const r of rows) {
    const v = r.total_value?.value ?? r.values?.[0]?.value;
    if (typeof v === "number") out[r.name] = v;
  }
  return out;
}

/** 성과 권한이 없을 때의 에러 (10 = 권한 거부, 200 = 권한 없음). */
export function isPermissionError(err: unknown): boolean {
  return (
    err instanceof InstagramApiError &&
    (err.code === 10 || err.code === 200 || err.status === 403)
  );
}

// 다시 물어볼 만한 에러 — "이 게시물은 이 지표를 지원 안 함" 같은 것.
// 토큰 · 호출 한도 · 권한 에러는 그대로 던진다(그 계정 수집을 멈춰야 하는 신호).
function isRetryablePerMetric(err: unknown): boolean {
  return (
    err instanceof InstagramApiError &&
    err.kind === "OTHER" &&
    !isPermissionError(err)
  );
}

// 지표 묶음 요청이 "지원 안 하는 지표" 하나 때문에 통째로 거절되면 하나씩 다시 묻는다.
async function fetchInsights(
  path: string,
  token: string,
  metrics: readonly string[],
  extra: Record<string, string> = {},
  base = GRAPH_API_BASE,
): Promise<MetricValues> {
  try {
    const res = await instagramRequest<{ data: InsightRow[] }>(
      graphUrl(path, token, { metric: metrics.join(","), ...extra }, base),
    );
    return readInsights(res.data);
  } catch (err) {
    if (!isRetryablePerMetric(err)) throw err;
    if (metrics.length === 1) return {};
    const out: MetricValues = {};
    for (const m of metrics) {
      try {
        const res = await instagramRequest<{ data: InsightRow[] }>(
          graphUrl(path, token, { metric: m, ...extra }, base),
        );
        Object.assign(out, readInsights(res.data));
      } catch (e) {
        if (!isRetryablePerMetric(e)) throw e;
      }
    }
    return out;
  }
}

function mediaMetrics(media: Pick<InstagramMedia, "mediaProductType">): string[] {
  return media.mediaProductType === "REELS"
    ? [...MEDIA_METRICS, ...REELS_EXTRA_METRICS]
    : [...MEDIA_METRICS];
}

export async function getMediaInsights(
  token: string,
  media: Pick<InstagramMedia, "id" | "mediaProductType">,
): Promise<MetricValues> {
  return fetchInsights(`/${media.id}/insights`, token, mediaMetrics(media));
}

/** 시스템 사용자 토큰으로 읽을 수 있는 인스타 계정 — 소문자 아이디 → 인스타 ID. */
export async function listSystemAccounts(token: string): Promise<Map<string, string>> {
  type Page = { data: { id: string; username?: string }[]; paging?: { next?: string } };
  const out = new Map<string, string>();
  let next: string | null = graphUrl(
    "/me/assigned_instagram_accounts",
    token,
    { fields: "id,username", limit: "100" },
    SYSTEM_API_BASE,
  );
  while (next) {
    const page: Page = await instagramRequest<Page>(next);
    for (const a of page.data) if (a.username) out.set(a.username.toLowerCase(), a.id);
    next = page.paging?.next ?? null;
  }
  return out;
}

/** 시스템 사용자 토큰으로 게시물 성과 — 지표는 getMediaInsights와 같다. */
export async function getMediaInsightsBySystem(
  token: string,
  media: Pick<InstagramMedia, "id" | "mediaProductType">,
): Promise<MetricValues> {
  return fetchInsights(`/${media.id}/insights`, token, mediaMetrics(media), {}, SYSTEM_API_BASE);
}

/** 시스템 사용자 토큰으로 계정 하루 성과 — [since, until) 구간 합계 (unix 초). */
export async function getAccountDayInsightsBySystem(
  token: string,
  igUserId: string,
  since: number,
  until: number,
): Promise<MetricValues> {
  return fetchInsights(
    `/${igUserId}/insights`,
    token,
    ACCOUNT_METRICS,
    { period: "day", metric_type: "total_value", since: String(since), until: String(until) },
    SYSTEM_API_BASE,
  );
}

/** 계정 하루 성과 — [since, until) 구간 합계 (unix 초). */
export async function getAccountDayInsights(
  token: string,
  since: number,
  until: number,
): Promise<MetricValues> {
  return fetchInsights("/me/insights", token, ACCOUNT_METRICS, {
    period: "day",
    metric_type: "total_value",
    since: String(since),
    until: String(until),
  });
}

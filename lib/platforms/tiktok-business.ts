import "./server-guard";
import {
  MediaError,
  PublishError,
  RateLimitedError,
  TokenExpiredError,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// TikTok API for Business v1.3 — "TikTok 계정"(일반 게시물) 호출 모음.
// 어댑터(tiktok.ts) · 토큰 갱신 · 성과 수집 워커가 같이 쓴다.
//
// 공식 SDK에는 이 경로들이 없어서 다음 코드로 요청 · 응답 모양을 맞췄다(2026-11-13 조사):
//   sns-sdks/python-tiktok(business_account_api.py · 실제 응답 예시), Postiz tiktok.business.provider.ts,
//   Nango tiktok-accounts, bububa/tiktok-business(필드 주석이 공식 문서 번역).
//
// 공통 규칙
//   · 모든 응답은 { code, message, request_id, data }. code === 0이 성공이고, 실패도 HTTP 200으로 온다.
//   · /business/* 호출은 헤더 `Access-Token: <토큰>`(Bearer 아님). /tt_user/oauth2/*는 헤더 없이 JSON 본문.
//   · GET의 fields · filters는 JSON 문자열로 보낸다.
//   · business_id = 토큰 교환 응답의 open_id.
//   · 게시물 id(item_id · post_ids)는 2^53을 넘는 19자리 숫자 — JSON.parse 전에 문자열로 바꾼다.
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = "https://business-api.tiktok.com/open_api/v1.3";
export const TIKTOK_AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/";

// 앱에서 고른 "TikTok 계정" 권한(사용자 정보 · 게시물 목록과 성과 · 게시). 앱 설정과 다르면 TIKTOK_SCOPES로 덮어쓴다.
const DEFAULT_SCOPES = [
  "user.info.basic",
  "user.info.username",
  "user.info.stats",
  "user.insights",
  "video.list",
  "video.insights",
  "video.publish",
];

export function tiktokScopes(): string {
  const env = process.env.TIKTOK_SCOPES?.trim();
  return env ? env : DEFAULT_SCOPES.join(",");
}

export function tiktokAppCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET 환경변수 없음");
  }
  return { clientId, clientSecret };
}

// ─────────────────────────────────────────────────────────────────────────────
// 오류
// ─────────────────────────────────────────────────────────────────────────────

/** TikTok이 code ≠ 0으로 거절한 호출. 성과 수집이 권한 부족(40130)을 따로 다룰 때 쓴다. */
export class TikTokBusinessError extends PublishError {
  readonly code: number;
  readonly requestId: string | null;
  constructor(code: number, message: string, requestId: string | null) {
    super(`TikTok API 오류 ${code}: ${message}${requestId ? ` (request_id=${requestId})` : ""}`);
    this.name = "TikTokBusinessError";
    this.code = code;
    this.requestId = requestId;
  }
}

// 토큰이 무효 · 만료 · 해지된 경우. 코드 표는 공개 자료가 제3자 스펙뿐이라 메시지 문구도 같이 본다(Postiz와 같은 기준).
const TOKEN_CODES = new Set([40104, 40105]);
const TOKEN_MESSAGES = [
  "access_token_invalid",
  "access token has expired",
  "the access token is invalid",
  "auth_removed",
  "refresh_token",
];
const RATE_LIMIT_CODES = new Set([40100]);
// 영상 주소를 TikTok이 못 가져온 경우(도메인 인증 · 주소 만료 등) — 다음 시도에 새 주소로 다시 해 볼 가치가 있다.
const MEDIA_MESSAGES = ["url_ownership_unverified", "video_pull_failed", "invalid_url", "domain"];

function classify(code: number, message: string, requestId: string | null): never {
  const lower = message.toLowerCase();
  const detail = `${code}: ${message}`;
  if (TOKEN_CODES.has(code) || TOKEN_MESSAGES.some((m) => lower.includes(m))) {
    throw new TokenExpiredError(`TikTok 토큰 무효 (${detail})`);
  }
  if (RATE_LIMIT_CODES.has(code) || lower.includes("rate limit") || lower.includes("too many")) {
    throw new RateLimitedError(`TikTok 호출 한도를 넘었어요 (${detail})`);
  }
  if (MEDIA_MESSAGES.some((m) => lower.includes(m))) {
    throw new MediaError(`TikTok이 영상 주소를 가져오지 못했어요 (${detail})`);
  }
  throw new TikTokBusinessError(code, message, requestId);
}

// 16자리 이상 정수를 문자열로 감싼다 — item_id · post_ids가 Number로 바뀌며 끝자리가 틀어지는 것을 막는다.
function parseJsonKeepingBigInts(text: string): unknown {
  return JSON.parse(text.replace(/([:[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, '$1"$2"'));
}

interface Envelope<T> {
  code?: number;
  message?: string;
  request_id?: string;
  data?: T;
}

async function call<T>(
  path: string,
  init: { method: "GET" | "POST"; accessToken?: string; query?: Record<string, string | number | undefined>; body?: unknown },
): Promise<T> {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = {};
  if (init.accessToken) headers["Access-Token"] = init.accessToken;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method: init.method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (res.status === 429) throw new RateLimitedError(`TikTok 호출 한도를 넘었어요 (HTTP 429)`);

  let body: Envelope<T>;
  try {
    body = parseJsonKeepingBigInts(text) as Envelope<T>;
  } catch {
    throw new PublishError(`TikTok 응답을 읽지 못했어요 (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  const code = typeof body.code === "number" ? body.code : res.ok ? 0 : -1;
  if (code !== 0) classify(code, body.message ?? `HTTP ${res.status}`, body.request_id ?? null);
  return (body.data ?? {}) as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// 인증
// ─────────────────────────────────────────────────────────────────────────────

export interface TikTokTokenData {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  open_id?: string;
  scope?: string;
}

export function exchangeAuthCode(code: string, redirectUri: string): Promise<TikTokTokenData> {
  const { clientId, clientSecret } = tiktokAppCredentials();
  return call<TikTokTokenData>("/tt_user/oauth2/token/", {
    method: "POST",
    body: {
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      auth_code: code,
      redirect_uri: redirectUri,
    },
  });
}

export async function refreshAccessToken(refreshToken: string): Promise<TikTokTokenData> {
  const { clientId, clientSecret } = tiktokAppCredentials();
  try {
    return await call<TikTokTokenData>("/tt_user/oauth2/refresh_token/", {
      method: "POST",
      body: { client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken },
    });
  } catch (err) {
    // 갱신 토큰이 거절되면(만료 · 해지 · 다른 앱에서 받은 토큰) 다시 연결해야 한다.
    if (err instanceof TikTokBusinessError) {
      throw new TokenExpiredError(`TikTok 갱신 토큰이 거절됐어요 (${err.message}) — 계정을 다시 연결해 주세요`);
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 계정 정보 · 하루 성과
// ─────────────────────────────────────────────────────────────────────────────

export interface TikTokDailyMetric {
  date?: string;
  followers_count?: number;
  video_views?: number;
  unique_video_views?: number;
  profile_views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  daily_new_followers?: number;
  daily_lost_followers?: number;
  [key: string]: unknown;
}

export interface TikTokBusinessAccount {
  username?: string;
  display_name?: string;
  profile_image?: string;
  followers_count?: number;
  following_count?: number;
  total_likes?: number;
  videos_count?: number;
  metrics?: TikTokDailyMetric[];
  [key: string]: unknown;
}

export function getBusinessAccount(
  accessToken: string,
  businessId: string,
  fields: string[],
  range?: { startDate: string; endDate: string },
): Promise<TikTokBusinessAccount> {
  return call<TikTokBusinessAccount>("/business/get/", {
    method: "GET",
    accessToken,
    query: {
      business_id: businessId,
      fields: JSON.stringify(fields),
      start_date: range?.startDate,
      end_date: range?.endDate,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 게시물 목록 · 성과
// ─────────────────────────────────────────────────────────────────────────────

export interface TikTokVideo {
  item_id: string;
  media_type?: string;
  create_time?: number; // epoch 초
  thumbnail_url?: string;
  share_url?: string;
  caption?: string;
  video_duration?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  favorites?: number;
  reach?: number;
  video_views?: number;
  total_time_watched?: number; // 초
  average_time_watched?: number; // 초
  full_video_watched_rate?: number;
  [key: string]: unknown;
}

export const VIDEO_BASIC_FIELDS = [
  "item_id",
  "media_type",
  "create_time",
  "thumbnail_url",
  "share_url",
  "caption",
  "video_duration",
  "likes",
  "comments",
  "shares",
];
// video.insights 권한이 있어야 읽힌다. 권한이 없으면 호출 전체가 40130으로 거절된다.
export const VIDEO_INSIGHT_FIELDS = [
  "favorites",
  "reach",
  "video_views",
  "total_time_watched",
  "average_time_watched",
  "full_video_watched_rate",
  "new_followers",
  "profile_views",
];

/** 최신순으로 최대 `limit`개. 한 번에 20개까지라 cursor(밀리초)로 이어 읽는다. */
export async function listVideos(
  accessToken: string,
  businessId: string,
  fields: string[],
  limit: number,
): Promise<TikTokVideo[]> {
  const out: TikTokVideo[] = [];
  let cursor: number | undefined;
  for (let page = 0; page < 20 && out.length < limit; page++) {
    const data = await call<{ videos?: TikTokVideo[]; cursor?: number | string; has_more?: boolean }>("/business/video/list/", {
      method: "GET",
      accessToken,
      query: { business_id: businessId, fields: JSON.stringify(fields), max_count: 20, cursor },
    });
    const videos = data.videos ?? [];
    out.push(...videos.map((v) => ({ ...v, item_id: String(v.item_id) })));
    const next = data.cursor === undefined ? undefined : Number(data.cursor);
    if (!data.has_more || next === undefined || !Number.isFinite(next) || next === cursor) break;
    cursor = next;
  }
  return out.slice(0, limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// 게시
// ─────────────────────────────────────────────────────────────────────────────

export interface TikTokPostInfo {
  caption?: string;
  disable_comment?: boolean;
  disable_duet?: boolean;
  disable_stitch?: boolean;
  thumbnail_offset?: number; // ms
  is_ai_generated?: boolean;
  is_brand_organic?: boolean;
  is_branded_content?: boolean;
}

/**
 * 영상을 주소로 게시한다(전체 공개 — 이 API에는 비공개 옵션이 없다).
 * video_url은 TikTok에 소유 인증된 주소(URL property)여야 한다 — tiktokMediaUrl()로 만든다.
 * 돌려주는 share_id는 게시물 id가 아니라 상태 확인용 publish_id다.
 */
export async function publishVideo(
  accessToken: string,
  businessId: string,
  videoUrl: string,
  postInfo: TikTokPostInfo,
): Promise<string> {
  const data = await call<{ share_id?: string }>("/business/video/publish/", {
    method: "POST",
    accessToken,
    body: { business_id: businessId, video_url: videoUrl, post_info: postInfo },
  });
  if (!data.share_id) throw new PublishError("TikTok 게시 응답에 share_id가 없어요");
  return String(data.share_id);
}

export type TikTokPublishStatus =
  | "PROCESSING_DOWNLOAD"
  | "PROCESSING_UPLOAD"
  | "PUBLISH_COMPLETE"
  | "SEND_TO_USER_INBOX"
  | "FAILED";

export async function getPublishStatus(
  accessToken: string,
  businessId: string,
  publishId: string,
): Promise<{ status?: TikTokPublishStatus; post_ids?: string[]; reason?: string }> {
  const data = await call<{ status?: TikTokPublishStatus; post_ids?: (string | number)[]; reason?: string }>(
    "/business/publish/status/",
    { method: "GET", accessToken, query: { business_id: businessId, publish_id: publishId } },
  );
  return { ...data, post_ids: data.post_ids?.map(String) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 영상 주소 — TikTok은 소유 인증한 주소에서만 영상을 가져간다.
// Supabase 서명 주소(<ref>.supabase.co)는 인증할 수 없어서, 우리 도메인의 /tiktok-media/로 바꿔 준다.
// next.config.ts의 rewrite가 같은 경로 · token을 Supabase 서명 주소로 그대로 넘긴다(리다이렉트가 아니라 대신 받아 전달).
// 도메인 인증은 scripts/tiktok-url-property.ts로 한다.
// ─────────────────────────────────────────────────────────────────────────────

const SIGN_PATH = "/storage/v1/object/sign/";

export function tiktokMediaUrl(signedUrl: string): string {
  const base = (process.env.TIKTOK_MEDIA_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL || "").replace(/\/$/, "");
  if (!base) throw new MediaError("TikTok 영상 주소를 만들 도메인이 없어요 (NEXT_PUBLIC_SITE_URL)");
  const u = new URL(signedUrl);
  const token = u.searchParams.get("token");
  if (!u.pathname.startsWith(SIGN_PATH) || !token) {
    throw new MediaError(`TikTok 영상 주소로 바꿀 수 없는 서명 주소예요: ${u.pathname.slice(0, 80)}`);
  }
  return `${base}/tiktok-media/${u.pathname.slice(SIGN_PATH.length)}?token=${encodeURIComponent(token)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 주소 소유 인증(URL property) — 앱 단위(app_id + secret). 스크립트에서만 쓴다.
// property_type 1 = 도메인(DNS TXT), 2 = 주소 앞부분(https://호스트/경로/, 서명 파일을 그 아래에 둔다).
// ─────────────────────────────────────────────────────────────────────────────

export interface TikTokUrlProperty {
  property_type?: number;
  url?: string;
  property_status?: number; // 1 = 인증됨, 2 = 인증 실패
  signature?: string;
  file_name?: string;
}

export async function addUrlProperty(propertyType: 1 | 2, url: string): Promise<TikTokUrlProperty> {
  const { clientId, clientSecret } = tiktokAppCredentials();
  const data = await call<{ url_property_info?: TikTokUrlProperty }>("/business/property/add/", {
    method: "POST",
    body: { app_id: clientId, secret: clientSecret, url_property_meta: { property_type: propertyType, url } },
  });
  return data.url_property_info ?? {};
}

export async function verifyUrlProperty(propertyType: 1 | 2, url: string): Promise<TikTokUrlProperty> {
  const { clientId, clientSecret } = tiktokAppCredentials();
  const data = await call<{ url_property_info?: TikTokUrlProperty }>("/business/property/verify/", {
    method: "POST",
    body: { app_id: clientId, secret: clientSecret, url_property_meta: { property_type: propertyType, url } },
  });
  return data.url_property_info ?? {};
}

export async function listUrlProperties(): Promise<TikTokUrlProperty[]> {
  const { clientId, clientSecret } = tiktokAppCredentials();
  const data = await call<{ url_property_info_list?: TikTokUrlProperty[] }>("/business/property/list/", {
    method: "GET",
    query: { app_id: clientId, secret: clientSecret },
  });
  return data.url_property_info_list ?? [];
}

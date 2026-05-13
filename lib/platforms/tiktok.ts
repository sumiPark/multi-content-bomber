import "./server-guard";
import {
  MediaError,
  PublishError,
  RateLimitedError,
  TokenExpiredError,
  type OAuthTokens,
  type PlatformAdapter,
  type PublishContext,
  type PublishResult,
  type RefreshedTokens,
} from "./types";

// TikTok Login Kit + Content Posting API. https://developers.tiktok.com
// Content Posting API는 별도 승인 필요(승인 난이도 높음).
const SCOPES = ["user.info.basic", "video.publish", "video.upload"].join(",");

const AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const USER_INFO_URL =
  "https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name";

// Content Posting API
const VIDEO_INIT_URL = "https://open.tiktokapis.com/v2/post/publish/video/init/";
const STATUS_FETCH_URL =
  "https://open.tiktokapis.com/v2/post/publish/status/fetch/";

// 폴링: 영상 다운로드 + 인코딩이 PULL_FROM_URL 경로에서 자체 처리되므로 길어질 수 있다.
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 60; // 약 3분

// ─────────────────────────────────────────────────────────────────────────────
// TikTok API 응답 표준: { data, error: { code, message, log_id } }
// code === "ok" 또는 빈 문자열이 성공.
// ─────────────────────────────────────────────────────────────────────────────
interface TikTokErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    log_id?: string;
  };
}

function isErrorEnvelope(body: unknown): body is TikTokErrorEnvelope {
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in (body as Record<string, unknown>)
  );
}

function mapTikTokError(httpStatus: number, body: unknown): never {
  let code: string | undefined;
  let message: string | undefined;
  if (isErrorEnvelope(body)) {
    code = body.error?.code;
    message = body.error?.message;
  }
  const detail = `${code ?? "?"}: ${message ?? "no detail"}`;

  // 토큰 관련 — TikTok이 정의한 표준 코드들.
  if (
    httpStatus === 401 ||
    code === "access_token_invalid" ||
    code === "access_token_expired" ||
    code === "scope_not_authorized"
  ) {
    throw new TokenExpiredError(`TikTok 토큰 무효: ${detail}`);
  }
  if (httpStatus === 429 || code === "rate_limit_exceeded") {
    throw new RateLimitedError(`TikTok rate limit: ${detail}`);
  }
  if (
    code === "url_ownership_unverified" ||
    code === "video_pull_failed" ||
    code === "invalid_url"
  ) {
    // 도메인 verify 안 됐거나 TikTok이 video_url을 못 가져옴. 보통 영구 — 다만
    // MediaError로 분류해서 워커가 재시도 자체는 시도하도록 (서명 URL 만료 케이스 대비).
    throw new MediaError(`TikTok 미디어 fetch 실패: ${detail}`);
  }
  throw new PublishError(`TikTok API 오류 (${httpStatus}): ${detail}`);
}

async function callTikTokApi(
  url: string,
  init: RequestInit & { jsonBody?: unknown } = {},
): Promise<unknown> {
  const { jsonBody, headers: headersInit, ...rest } = init;
  const headers = new Headers(headersInit);
  if (jsonBody !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=UTF-8");
  }
  const res = await fetch(url, {
    ...rest,
    headers,
    body: jsonBody !== undefined ? JSON.stringify(jsonBody) : rest.body,
  });
  // TikTok은 HTTP 200이어도 error.code가 비어있지 않으면 실패. 본문을 항상 parse.
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = await res.text();
  }
  const code =
    isErrorEnvelope(body) && body.error?.code ? body.error.code : "";
  if (!res.ok || (code && code !== "ok")) {
    mapTikTokError(res.status, body);
  }
  return body;
}

// 캡션은 본문 + 해시태그 인라인. caption-generator의 postProcessTiktok이 이미
// 본문 안에 #태그를 넣어주지만, hashtags 배열로 별도 들어온 경우도 합쳐서 처리.
function buildTikTokCaption(ctx: PublishContext): string {
  const tagLine = ctx.hashtags
    .map((t) => (t.startsWith("#") ? t : `#${t}`))
    .join(" ");
  const parts: string[] = [];
  if (ctx.caption?.trim()) parts.push(ctx.caption.trim());
  if (tagLine && !ctx.caption?.includes(tagLine)) parts.push(tagLine);
  return parts.join(" ");
}

export const tiktok: PlatformAdapter = {
  buildAuthUrl(state, redirectUri) {
    const clientKey = process.env.TIKTOK_CLIENT_KEY;
    if (!clientKey) throw new Error("TIKTOK_CLIENT_KEY 환경변수 없음");
    const params = new URLSearchParams({
      client_key: clientKey,
      redirect_uri: redirectUri,
      scope: SCOPES,
      response_type: "code",
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  },

  async exchangeCode(code, redirectUri): Promise<OAuthTokens> {
    const clientKey = process.env.TIKTOK_CLIENT_KEY;
    const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
    if (!clientKey || !clientSecret) {
      throw new Error("TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET 환경변수 없음");
    }

    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      throw new Error(
        `TikTok 토큰 교환 실패 (${tokenRes.status}): ${text.slice(0, 200)}`,
      );
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      open_id?: string;
      scope?: string;
    };

    const userRes = await fetch(USER_INFO_URL, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    let displayName: string | null = null;
    let avatarUrl: string | null = null;
    let openId: string | null = tokenData.open_id ?? null;
    if (userRes.ok) {
      const userData = (await userRes.json()) as {
        data?: {
          user?: {
            open_id?: string;
            display_name?: string;
            avatar_url?: string;
          };
        };
      };
      displayName = userData.data?.user?.display_name ?? null;
      avatarUrl = userData.data?.user?.avatar_url ?? null;
      openId = userData.data?.user?.open_id ?? openId;
    }

    if (!openId) {
      throw new Error("TikTok user open_id를 가져오지 못했습니다.");
    }

    return {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token ?? null,
      expiresAt: tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000)
        : null,
      accountInfo: {
        platformAccountId: openId,
        displayName,
        avatarUrl,
      },
    };
  },

  // ───────────────────────────────────────────────────────────────────────────
  // TikTok Content Posting API — PULL_FROM_URL 흐름:
  //   1. POST /v2/post/publish/video/init/   → publish_id 반환
  //      TikTok이 video_url을 자기 서버로 가져가 인코딩/검증. 호출 즉시 반환.
  //   2. POST /v2/post/publish/status/fetch/ → 폴링, PUBLISH_COMPLETE 대기
  //   3. publicly_available_post_id로 URL 조립
  //
  // ⚠️ 중요: TikTok 개발자 콘솔의 "URL Properties"에서 video_url 호스트(예:
  // `<project>.supabase.co`)를 verify해야 PULL_FROM_URL이 동작한다. 미verify면
  // `url_ownership_unverified` 코드로 fail — MediaError로 분류.
  //
  // privacy_level: SELF_ONLY로 시작 (앱 테스트 단계 기본). Production에서 PUBLIC_TO_EVERYONE
  // 가려면 콘솔 승인 필요. 후속 슬라이스에서 사용자 설정으로 노출.
  // ───────────────────────────────────────────────────────────────────────────
  async publish(ctx, accessToken): Promise<PublishResult> {
    if (ctx.mediaType !== "VIDEO") {
      throw new PublishError(
        `TikTok publish는 동영상만 지원합니다 (received: ${ctx.mediaType}). 이미지 게시는 별도 PHOTO 엔드포인트 필요.`,
      );
    }
    const signedUrl = ctx.mediaSignedUrls[0];
    if (!signedUrl) {
      throw new MediaError("TikTok publish: 미디어 서명 URL이 비어있습니다");
    }

    const caption = buildTikTokCaption(ctx);

    // 1. init — publish_id 발급
    const initBody = {
      post_info: {
        title: caption.slice(0, 2200), // 제목/캡션 통합, 최대 2200자
        privacy_level: "SELF_ONLY" as const,
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
        video_cover_timestamp_ms: 1000,
      },
      source_info: {
        source: "PULL_FROM_URL" as const,
        video_url: signedUrl,
      },
    };

    const initResp = (await callTikTokApi(VIDEO_INIT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      jsonBody: initBody,
    })) as { data?: { publish_id?: string } };

    const publishId = initResp.data?.publish_id;
    if (!publishId) {
      throw new PublishError("TikTok init 응답에 publish_id 없음");
    }

    // 2. 상태 폴링
    const finalStatus = await pollTikTokStatus(publishId, accessToken);

    // 3. URL 조립. publicly_available_post_id가 없으면(비공개/광고 정책 등) post_id만 반환.
    const postId = finalStatus.publicly_available_post_id?.[0] ?? publishId;
    const url = finalStatus.publicly_available_post_id?.[0]
      ? `https://www.tiktok.com/video/${finalStatus.publicly_available_post_id[0]}`
      : `https://www.tiktok.com/`;

    return {
      platformPostId: postId,
      platformPostUrl: url,
    };
  },

  async refreshToken(refreshTokenPlain): Promise<RefreshedTokens> {
    const clientKey = process.env.TIKTOK_CLIENT_KEY;
    const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
    if (!clientKey || !clientSecret) {
      throw new Error("TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET 환경변수 없음");
    }

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshTokenPlain,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      // invalid_grant 또는 refresh_token 만료(refresh_expires_in 지남) → 영구 실패.
      if (
        res.status === 400 ||
        text.includes("invalid_grant") ||
        text.includes("invalid_request")
      ) {
        throw new TokenExpiredError(
          `TikTok refresh_token revoke됨: ${text.slice(0, 200)}`,
        );
      }
      throw new PublishError(
        `TikTok refresh 실패 (${res.status}): ${text.slice(0, 200)}`,
      );
    }

    const data = (await res.json()) as {
      access_token: string;
      expires_in?: number;
      refresh_token?: string;
      refresh_expires_in?: number;
    };

    return {
      accessToken: data.access_token,
      // TikTok은 refresh_token rotation. 응답에 새 refresh_token이 오면 그것을 다음 sweep 입력으로 저장.
      refreshToken: data.refresh_token ?? null,
      expiresAt: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000)
        : null,
    };
  },
};

interface TikTokStatusData {
  status?:
    | "PROCESSING_DOWNLOAD"
    | "PROCESSING_UPLOAD"
    | "SEND_TO_USER_INBOX"
    | "PUBLISH_COMPLETE"
    | "FAILED";
  fail_reason?: string;
  publicly_available_post_id?: string[];
  uploaded_bytes?: number;
}

async function pollTikTokStatus(
  publishId: string,
  accessToken: string,
): Promise<TikTokStatusData> {
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    const resp = (await callTikTokApi(STATUS_FETCH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      jsonBody: { publish_id: publishId },
    })) as { data?: TikTokStatusData };

    const data = resp.data ?? {};
    switch (data.status) {
      case "PUBLISH_COMPLETE":
      case "SEND_TO_USER_INBOX":
        // INBOX는 사용자 inbox로 draft가 전달된 케이스(PRIVATE 모드에서 흔함).
        // 발행은 아니지만 워커가 더 할 일은 없으므로 성공으로 처리.
        return data;
      case "FAILED":
        throw new PublishError(
          `TikTok publish FAILED: ${data.fail_reason ?? "(no reason)"}`,
        );
      case "PROCESSING_DOWNLOAD":
      case "PROCESSING_UPLOAD":
      default:
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
  throw new PublishError(
    `TikTok 상태 폴링 타임아웃 (${POLL_MAX_ATTEMPTS}회 * ${POLL_INTERVAL_MS}ms)`,
  );
}

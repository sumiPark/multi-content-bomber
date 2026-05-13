import "./server-guard";
import { randomUUID } from "crypto";
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

// YouTube Data API v3 + Google OAuth 2.0.
// Google Cloud Console에서 OAuth 2.0 클라이언트(웹 애플리케이션) 생성 후
// "YouTube Data API v3"를 활성화해야 함.
//
// access_type=offline + prompt=consent 둘 다 있어야 refresh_token이 발급됨.
// 한 번 동의한 사용자는 prompt 없으면 refresh_token이 안 와서 만료 후 재연동 필요.
const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
].join(" ");

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CHANNEL_URL =
  "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true";
const VIDEOS_INSERT_URL =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status";

// YouTube videos.insert에 multipart/related로 보낼 때 사용하는 boundary 접두사.
// 매 요청마다 랜덤 suffix를 붙여 body 안의 문자열과 충돌하지 않게 한다.
function makeBoundary(): string {
  return `mcb-yt-${randomUUID()}`;
}

// Google API JSON 에러 형태. error.code(HTTP), error.errors[].reason으로
// 토큰 만료(invalidCredentials) / 쿼터 초과(quotaExceeded) 등을 분기.
interface GoogleApiError {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ reason?: string; message?: string }>;
  };
}

// HTTP 응답 + 본문을 우리 에러 타입으로 매핑. 워커가 instanceof로 분기.
function mapYoutubeError(status: number, body: string): never {
  let parsed: GoogleApiError | null = null;
  try {
    parsed = JSON.parse(body) as GoogleApiError;
  } catch {
    // body가 JSON 아니면 그대로 흘림
  }
  const reasons =
    parsed?.error?.errors?.map((e) => e.reason).filter(Boolean) ?? [];
  const message = parsed?.error?.message ?? body.slice(0, 300);

  if (status === 401 || reasons.includes("authError")) {
    throw new TokenExpiredError(`YouTube access_token 만료/무효: ${message}`);
  }
  if (status === 429 || reasons.includes("rateLimitExceeded")) {
    throw new RateLimitedError(`YouTube rate limit: ${message}`);
  }
  if (status === 403 && reasons.includes("quotaExceeded")) {
    // 일일 쿼터(10k units/day) 초과. 시간 지나야 회복 — rate limit 카테고리.
    throw new RateLimitedError(`YouTube 일일 쿼터 초과: ${message}`);
  }
  throw new PublishError(`YouTube API 오류 (${status}): ${message}`);
}

export const youtube: PlatformAdapter = {
  buildAuthUrl(state, redirectUri) {
    const clientId = process.env.YOUTUBE_CLIENT_ID;
    if (!clientId) throw new Error("YOUTUBE_CLIENT_ID 환경변수 없음");
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: SCOPES,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  },

  async exchangeCode(code, redirectUri): Promise<OAuthTokens> {
    const clientId = process.env.YOUTUBE_CLIENT_ID;
    const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET 환경변수 없음");
    }

    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      throw new Error(
        `YouTube 토큰 교환 실패 (${tokenRes.status}): ${text.slice(0, 200)}`,
      );
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      token_type?: string;
    };

    const channelRes = await fetch(CHANNEL_URL, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!channelRes.ok) {
      const text = await channelRes.text();
      throw new Error(
        `YouTube 채널 조회 실패 (${channelRes.status}): ${text.slice(0, 200)}`,
      );
    }
    const channelData = (await channelRes.json()) as {
      items?: Array<{
        id: string;
        snippet?: {
          title?: string;
          thumbnails?: { default?: { url?: string } };
        };
      }>;
    };

    const channel = channelData.items?.[0];
    if (!channel) {
      throw new Error(
        "연결된 YouTube 채널이 없습니다. 채널을 먼저 생성한 뒤 다시 시도하세요.",
      );
    }

    return {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token ?? null,
      expiresAt: tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000)
        : null,
      accountInfo: {
        platformAccountId: channel.id,
        displayName: channel.snippet?.title ?? null,
        avatarUrl: channel.snippet?.thumbnails?.default?.url ?? null,
      },
    };
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 4b ④: YouTube Data API v3 videos.insert (multipart upload).
  // 큰 파일은 resumable upload가 정석이지만 1차 슬라이스에선 멀티파트로 단순화.
  // Shorts 60초 / ~100MB 정도는 안정. 대용량으로 가면 resumable로 교체 필요.
  //
  // 캡션 매핑:
  //   title       → snippet.title (필수)
  //   description → snippet.description (선택, hashtags 본문에 부착)
  //   hashtags    → snippet.tags 그리고 description 끝에 #tag 형태로 추가
  //                 (YouTube는 description의 #태그가 검색에 반영됨)
  //
  // 공개 범위는 일단 PUBLIC. 추후 사용자 설정으로 빼야 함.
  // ───────────────────────────────────────────────────────────────────────────
  async publish(ctx, accessToken): Promise<PublishResult> {
    if (ctx.mediaType !== "VIDEO") {
      throw new PublishError(
        `YouTube는 동영상만 지원합니다 (received: ${ctx.mediaType})`,
      );
    }
    const signedUrl = ctx.mediaSignedUrls[0];
    if (!signedUrl) {
      throw new MediaError("YouTube publish: 미디어 서명 URL이 비어있습니다");
    }
    if (!ctx.title) {
      throw new PublishError("YouTube publish: title 누락");
    }

    // 1. Storage에서 비디오 바이너리 fetch
    const videoRes = await fetch(signedUrl);
    if (!videoRes.ok) {
      throw new MediaError(
        `YouTube publish: 미디어 fetch 실패 (${videoRes.status})`,
      );
    }
    const videoBytes = Buffer.from(await videoRes.arrayBuffer());
    const videoContentType =
      videoRes.headers.get("content-type") ?? "video/mp4";

    // 2. snippet/status JSON 조립
    const hashtagText = ctx.hashtags.length > 0 ? ctx.hashtags.join(" ") : "";
    const description = [ctx.description, hashtagText]
      .filter((s) => s && s.trim())
      .join("\n\n");

    const meta = {
      snippet: {
        title: ctx.title,
        description,
        // YouTube tags는 # 없이 키워드만. hashtags는 사용자가 #포함으로 저장하므로 strip.
        tags: ctx.hashtags.map((t) => t.replace(/^#/, "")).slice(0, 15),
      },
      status: {
        privacyStatus: "public" as const,
        selfDeclaredMadeForKids: false,
      },
    };

    // 3. multipart/related body 직접 조립.
    //    fetch가 Buffer를 그대로 받으므로 Content-Length 자동.
    const boundary = makeBoundary();
    const metaPart = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
      "utf8",
    );
    const videoHeader = Buffer.from(
      `--${boundary}\r\nContent-Type: ${videoContentType}\r\n\r\n`,
      "utf8",
    );
    const videoFooter = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    const body = Buffer.concat([metaPart, videoHeader, videoBytes, videoFooter]);

    // 4. videos.insert 호출
    const uploadRes = await fetch(VIDEOS_INSERT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    });

    if (!uploadRes.ok) {
      mapYoutubeError(uploadRes.status, await uploadRes.text());
    }

    const uploaded = (await uploadRes.json()) as {
      id?: string;
      snippet?: { channelId?: string };
    };
    if (!uploaded.id) {
      throw new PublishError("YouTube 응답에 video id가 없습니다");
    }

    return {
      platformPostId: uploaded.id,
      platformPostUrl: `https://www.youtube.com/watch?v=${uploaded.id}`,
    };
  },

  async refreshToken(refreshTokenPlain): Promise<RefreshedTokens> {
    const clientId = process.env.YOUTUBE_CLIENT_ID;
    const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET 환경변수 없음");
    }

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshTokenPlain,
        grant_type: "refresh_token",
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      // Google: refresh_token이 revoke되면 400 + "invalid_grant". 영구 실패.
      if (
        res.status === 400 &&
        (text.includes("invalid_grant") || text.includes("invalid_token"))
      ) {
        throw new TokenExpiredError(
          `YouTube refresh_token revoke됨: ${text.slice(0, 200)}`,
        );
      }
      throw new PublishError(
        `YouTube refresh 실패 (${res.status}): ${text.slice(0, 200)}`,
      );
    }

    const data = (await res.json()) as {
      access_token: string;
      expires_in?: number;
      refresh_token?: string;
    };

    return {
      accessToken: data.access_token,
      // Google은 보통 refresh_token을 재발급하지 않음 (있으면 사용).
      refreshToken: data.refresh_token ?? null,
      expiresAt: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000)
        : null,
    };
  },
};

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

// Instagram Login (Instagram Graph API용). Meta 개발자 콘솔에서 앱 생성 후
// "Instagram > API setup with Instagram login" 흐름을 따름.
// Required scopes: 콘텐츠 게시는 instagram_business_content_publish 필수.
const SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_comments",
].join(",");

const AUTH_URL = "https://www.instagram.com/oauth/authorize";
const TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const ME_URL = "https://graph.instagram.com/me";
const LONG_LIVED_URL = "https://graph.instagram.com/access_token";
const REFRESH_URL = "https://graph.instagram.com/refresh_access_token";
const GRAPH_API_BASE = "https://graph.instagram.com/v23.0";

// Container 상태 폴링 — 영상 업로드는 IG 서버가 처리하는 데 시간이 걸린다.
// 60초(30회)로는 릴스 인코딩이 자주 못 끝나서 실제 발행 대부분이 타임아웃 → RETRYING으로
// 떨어지고 재시도 3회 중 1~2회를 그냥 소모했다. 3분으로 늘린다. (워커는 GitHub Actions
// 러너라 Vercel 60초 제한과 무관하고, job timeout은 50분.)
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 90; // 약 3분

// Meta Graph API 에러 응답.
//   { error: { message, type, code, error_subcode, fbtrace_id } }
// code/subcode 매핑: https://developers.facebook.com/docs/graph-api/guides/error-handling/
interface GraphApiError {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
  };
}

function mapInstagramError(status: number, body: string): never {
  let parsed: GraphApiError | null = null;
  try {
    parsed = JSON.parse(body) as GraphApiError;
  } catch {
    // 그대로
  }
  const errCode = parsed?.error?.code;
  const subCode = parsed?.error?.error_subcode;
  const message = parsed?.error?.message ?? body.slice(0, 300);

  // 190 = OAuthException invalid access token (subcode로 만료 종류 세분화)
  // 102 = session invalidated
  if (status === 401 || errCode === 190 || errCode === 102) {
    throw new TokenExpiredError(`Instagram access_token 무효: ${message}`);
  }
  // 4 = application request limit, 17 = user request limit, 32 = page level rate, 613 = too many calls
  if (status === 429 || [4, 17, 32, 613].includes(errCode ?? -1)) {
    throw new RateLimitedError(`Instagram rate limit: ${message}`);
  }
  // 100 = invalid parameter (포맷 문제), 200 = permissions
  if (status === 403 || errCode === 200) {
    throw new PublishError(`Instagram 권한/정책 오류: ${message}`);
  }
  // 9007 = media format unsupported 등 미디어 문제
  if (subCode === 2207026 || subCode === 9007) {
    throw new MediaError(`Instagram 미디어 거부: ${message}`);
  }
  throw new PublishError(`Instagram API 오류 (${status}): ${message}`);
}

async function callGraphApi(
  url: string,
  init?: RequestInit,
): Promise<unknown> {
  const res = await fetch(url, init);
  if (!res.ok) {
    mapInstagramError(res.status, await res.text());
  }
  return res.json();
}

function buildInstagramCaption(ctx: PublishContext): string {
  // Instagram은 caption 본문 안의 #해시태그가 검색에 잡힌다. 본문 + 해시태그를 합쳐 한 문자열로.
  const tagLine = ctx.hashtags
    .map((t) => (t.startsWith("#") ? t : `#${t}`))
    .join(" ");
  const parts: string[] = [];
  if (ctx.caption?.trim()) parts.push(ctx.caption.trim());
  if (tagLine) parts.push(tagLine);
  return parts.join("\n\n");
}

export const instagram: PlatformAdapter = {
  buildAuthUrl(state, redirectUri) {
    const clientId = process.env.INSTAGRAM_APP_ID;
    if (!clientId) throw new Error("INSTAGRAM_APP_ID 환경변수 없음");
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: SCOPES,
      response_type: "code",
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  },

  async exchangeCode(code, redirectUri): Promise<OAuthTokens> {
    const clientId = process.env.INSTAGRAM_APP_ID;
    const clientSecret = process.env.INSTAGRAM_APP_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET 환경변수 없음");
    }

    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code,
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      throw new Error(
        `Instagram 토큰 교환 실패 (${tokenRes.status}): ${text.slice(0, 200)}`,
      );
    }

    // Instagram API with Instagram Login은 short-lived 응답을 { data: [ {...} ] }로
    // 감싸서 보낸다(구 Basic Display는 최상위). 둘 다 안전하게 꺼낸다. 잘못 꺼내면
    // access_token이 undefined로 long-lived URL에 실려, Graph가 노드를 못 찾고
    // "Unsupported request - method type: get" (code 100) 일반 에러를 뱉는다.
    type ShortLivedToken = {
      access_token: string;
      user_id?: string | number;
      permissions?: string | string[];
    };
    const tokenData = (await tokenRes.json()) as
      | ShortLivedToken
      | { data: ShortLivedToken[] };
    const shortLived: ShortLivedToken | undefined =
      "data" in tokenData && Array.isArray(tokenData.data)
        ? tokenData.data[0]
        : (tokenData as ShortLivedToken);
    if (!shortLived?.access_token) {
      throw new Error(
        `Instagram short-lived 토큰 파싱 실패 — 응답에 access_token 없음: ${JSON.stringify(tokenData).slice(0, 200)}`,
      );
    }

    // ⭐ 1차 응답은 short-lived(1시간). publish/refresh가 의미를 가지려면 long-lived(60일)로
    // 즉시 교환. 한 번 long-lived가 되면 그 토큰을 ig_refresh_token grant로 무한 연장 가능.
    const longLivedUrl = new URL(LONG_LIVED_URL);
    longLivedUrl.searchParams.set("grant_type", "ig_exchange_token");
    longLivedUrl.searchParams.set("client_secret", clientSecret);
    longLivedUrl.searchParams.set("access_token", shortLived.access_token);
    const longRes = await fetch(longLivedUrl);
    if (!longRes.ok) {
      const text = await longRes.text();
      throw new Error(
        `Instagram long-lived 교환 실패 (${longRes.status}): ${text.slice(0, 200)}`,
      );
    }
    const longData = (await longRes.json()) as {
      access_token: string;
      token_type?: string;
      expires_in?: number; // 5184000 (60일)
    };

    // 본인 정보 (long-lived 토큰으로)
    const meRes = await fetch(
      `${ME_URL}?fields=id,username&access_token=${encodeURIComponent(longData.access_token)}`,
    );
    if (!meRes.ok) {
      throw new Error(`Instagram 사용자 정보 조회 실패 (${meRes.status})`);
    }
    const me = (await meRes.json()) as {
      id: string;
      username: string;
    };

    return {
      // long-lived가 publish/refresh가 통하는 유일한 토큰. short-lived는 버린다.
      accessToken: longData.access_token,
      // Instagram은 별도 refresh_token이 없고, long-lived 토큰 자체가 ig_refresh_token grant의
      // 입력이다. social_accounts.refresh_token_encrypted에 같은 값을 채워야 Phase 4c sweep의
      // `refresh_token_encrypted IS NOT NULL` 필터에 잡힌다. 워커가 갱신 시점에 두 컬럼을
      // 같은 새 값으로 같이 업데이트.
      refreshToken: longData.access_token,
      expiresAt: longData.expires_in
        ? new Date(Date.now() + longData.expires_in * 1000)
        : null,
      accountInfo: {
        platformAccountId: String(me.id),
        displayName: me.username,
        avatarUrl: null,
      },
    };
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Instagram Graph API 게시 흐름 (single-media):
  //   1. POST /{ig-user-id}/media   → container 생성 (image_url or video_url)
  //   2. GET  /{container-id}?fields=status_code  → FINISHED 될 때까지 폴링
  //   3. POST /{ig-user-id}/media_publish?creation_id=...  → 발행, media-id 반환
  //   4. GET  /{media-id}?fields=permalink  → 게시 URL
  //
  // 캐러셀(여러 이미지 한 포스트)은 미지원 — 후속에서 carousel_container로 확장.
  // ───────────────────────────────────────────────────────────────────────────
  async publish(ctx, accessToken): Promise<PublishResult> {
    if (!ctx.platformAccountId) {
      throw new PublishError("Instagram publish: platformAccountId(IG user id) 누락");
    }
    const signedUrl = ctx.mediaSignedUrls[0];
    if (!signedUrl) {
      throw new MediaError("Instagram publish: 미디어 서명 URL이 비어있습니다");
    }
    if (ctx.mediaSignedUrls.length > 1) {
      // 후속 캐러셀 슬라이스에서 처리
      console.warn(
        "[instagram] 첫 미디어만 사용 — 캐러셀 미지원 (현재 슬라이스).",
      );
    }

    const caption = buildInstagramCaption(ctx);

    // 1. Container 생성
    const containerUrl = new URL(`${GRAPH_API_BASE}/${ctx.platformAccountId}/media`);
    if (ctx.mediaType === "VIDEO") {
      containerUrl.searchParams.set("media_type", "REELS");
      containerUrl.searchParams.set("video_url", signedUrl);
      // 커버 프레임: 사용자가 고른 시점(ms)을 thumb_offset으로 전달. Reels는 영상
      // 내 한 프레임을 커버로 지정 가능(별도 이미지 업로드 없이). 미지정이면 IG 기본.
      if (ctx.coverTimestampMs != null) {
        containerUrl.searchParams.set(
          "thumb_offset",
          String(ctx.coverTimestampMs),
        );
      }
    } else {
      containerUrl.searchParams.set("image_url", signedUrl);
    }
    if (caption) containerUrl.searchParams.set("caption", caption);
    containerUrl.searchParams.set("access_token", accessToken);

    const containerRes = (await callGraphApi(containerUrl.toString(), {
      method: "POST",
    })) as { id?: string };

    if (!containerRes.id) {
      throw new PublishError("Instagram container 응답에 id 없음");
    }
    const containerId = containerRes.id;

    // 2. Container 상태 폴링
    await pollContainerReady(containerId, accessToken);

    // 3. Publish
    const publishUrl = new URL(
      `${GRAPH_API_BASE}/${ctx.platformAccountId}/media_publish`,
    );
    publishUrl.searchParams.set("creation_id", containerId);
    publishUrl.searchParams.set("access_token", accessToken);

    const publishRes = (await callGraphApi(publishUrl.toString(), {
      method: "POST",
    })) as { id?: string };

    if (!publishRes.id) {
      throw new PublishError("Instagram media_publish 응답에 id 없음");
    }
    const mediaId = publishRes.id;

    // 4. Permalink 조회 — 실패해도 게시는 이미 끝났으므로 fallback URL만 채우고 throw 안 함.
    let permalink: string | null = null;
    try {
      const permRes = (await callGraphApi(
        `${GRAPH_API_BASE}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(accessToken)}`,
      )) as { permalink?: string };
      permalink = permRes.permalink ?? null;
    } catch (err) {
      console.warn(
        `[instagram] permalink 조회 실패 (media_id=${mediaId}):`,
        err instanceof Error ? err.message : err,
      );
    }

    return {
      platformPostId: mediaId,
      platformPostUrl: permalink ?? `https://www.instagram.com/`,
    };
  },

  // Instagram long-lived 토큰은 별도 refresh_token이 없고, 토큰 자신을 갱신한다.
  // ig_refresh_token grant는 발급 후 24시간 이상 지난 long-lived 토큰만 받음 — 새 토큰엔
  // 통하지 않는다는 점 주의 (Phase 4c sweep이 1h 임계로 도므로 신규 토큰엔 발화 안 함).
  async refreshToken(currentLongLivedToken): Promise<RefreshedTokens> {
    const url = new URL(REFRESH_URL);
    url.searchParams.set("grant_type", "ig_refresh_token");
    url.searchParams.set("access_token", currentLongLivedToken);

    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      // 토큰 자체가 invalid면 영구 실패.
      if (
        res.status === 400 ||
        text.includes("OAuthException") ||
        text.includes("invalid")
      ) {
        throw new TokenExpiredError(
          `Instagram refresh 실패: ${text.slice(0, 200)}`,
        );
      }
      throw new PublishError(
        `Instagram refresh 오류 (${res.status}): ${text.slice(0, 200)}`,
      );
    }

    const data = (await res.json()) as {
      access_token: string;
      token_type?: string;
      expires_in?: number;
    };

    return {
      accessToken: data.access_token,
      // long-lived 토큰 자체가 refresh의 입력 → 다음번엔 갱신된 토큰을 입력으로.
      // Phase 4c worker가 access_token_encrypted를 새 값으로 덮어쓰지만,
      // refresh_token_encrypted 컬럼에는 같은 값이 들어가 있어야 다음 sweep이 동작한다.
      refreshToken: data.access_token,
      expiresAt: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000)
        : null,
    };
  },
};

async function pollContainerReady(
  containerId: string,
  accessToken: string,
): Promise<void> {
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    const url = new URL(`${GRAPH_API_BASE}/${containerId}`);
    url.searchParams.set("fields", "status_code,status");
    url.searchParams.set("access_token", accessToken);

    const res = (await callGraphApi(url.toString())) as {
      status_code?: string;
      status?: string;
    };

    switch (res.status_code) {
      case "FINISHED":
        return;
      case "ERROR":
        throw new PublishError(
          `Instagram container ERROR: ${res.status ?? "(no detail)"}`,
        );
      case "EXPIRED":
        throw new MediaError(
          `Instagram container EXPIRED — 서명 URL이 IG가 fetch하기 전 만료됨`,
        );
      case "IN_PROGRESS":
      case "PUBLISHED":
      default:
        // PUBLISHED는 비정상(이미 발행됨)이지만 어쨌든 ready. 그대로 진행.
        if (res.status_code === "PUBLISHED") return;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
  throw new PublishError(
    `Instagram container 폴링 타임아웃 (${POLL_MAX_ATTEMPTS}회 * ${POLL_INTERVAL_MS}ms)`,
  );
}

import "./server-guard";
import { createHash } from "crypto";
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
import { INSTAGRAM_MAX_VIDEO_BYTES } from "@/lib/upload/validation";
import type { Json } from "@/types/database";

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

// Container 상태 폴링 — 영상은 IG 서버가 원본을 받아가 자기 쪽에서 인코딩하므로
// 시간이 걸린다. 상한은 파일 크기에 비례: 기본 10분 + 100MB당 5분, 최대 40분.
// (10분 고정이던 시절 818MB·10분짜리 60fps HEVC 릴스가 두 시도 연속 타임아웃 —
// IG가 818MB를 받고 인코딩을 끝내는 데 그보다 오래 걸린다.) 워커는 GitHub Actions
// 러너라 Vercel 60초 제한과 무관하고, run 전체 예산은 ctx.deadlineAt으로 따로 들어온다.
//
// 상한을 넘겨도 컨테이너는 버리지 않는다 — id를 resume_state에 남겨 다음 시도가
// 이어서 폴링한다(IG 컨테이너는 24시간 유효). 시도마다 새 컨테이너를 만들면 앞
// 시도의 진행분이 버려지고, IG 쪽엔 같은 영상 컨테이너가 시도 수만큼 쌓여 서로 느려진다.
const POLL_INTERVAL_MS = 2000;
const POLL_BASE_MS = 10 * 60_000;
const POLL_PER_100MB_MS = 5 * 60_000;
const POLL_MAX_MS = 40 * 60_000;

// 캐러셀 자식(이미지) 컨테이너는 인코딩이 없어 보통 몇 초 내 FINISHED. 여기에 영상
// 상한을 그대로 쓰면 10장 × 10분이라 서명 URL TTL을 넘겨버린다.
const CHILD_POLL_MAX_MS = 30_000;

// 캐러셀 1포스트당 아이템 수 제한 (Instagram 규격: 2~10장).
// 업로드 마법사(lib/upload/validation.ts)도 10장에서 막지만, 워커는 DB를 직접 읽으므로
// 어댑터에서도 방어한다.
const CAROUSEL_MIN_ITEMS = 2;
const CAROUSEL_MAX_ITEMS = 10;

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
  // 캐러셀(이미지 2~10장 한 포스트)은 1단계가 2겹으로 늘어난다:
  //   1a. 장마다 POST /media (image_url + is_carousel_item=true) → 자식 container N개
  //       ⚠️ 자식엔 caption을 넣지 않는다. 캡션은 부모 컨테이너에만.
  //   1b. 자식이 전부 FINISHED 된 뒤 POST /media (media_type=CAROUSEL&children=id,id,...)
  //       → 부모 container. 이후 2~4단계는 single-media와 동일.
  // ───────────────────────────────────────────────────────────────────────────
  async publish(ctx, accessToken): Promise<PublishResult> {
    if (!ctx.platformAccountId) {
      throw new PublishError("Instagram publish: platformAccountId(IG user id) 누락");
    }
    const signedUrls = ctx.mediaSignedUrls;
    const signedUrl = signedUrls[0];
    if (!signedUrl) {
      throw new MediaError("Instagram publish: 미디어 서명 URL이 비어있습니다");
    }

    const caption = buildInstagramCaption(ctx);
    // 영상은 media_urls가 항상 1개(DB 제약). 2장 이상 이미지 = 캐러셀.
    const isCarousel = ctx.mediaType !== "VIDEO" && signedUrls.length > 1;
    const fingerprint = buildFingerprint(ctx, caption);

    // 0. 크기 확인 — 너무 큰 영상은 IG가 ERROR도 안 주고 컨테이너를 IN_PROGRESS에
    //    몇 시간씩 붙잡아 둔다. 한도를 넘으면 기다리지 않고 컨테이너를 만들기 전에 거른다.
    //    (이어받을 컨테이너가 있어도 마찬가지 — 재시도를 남기지 않고 바로 FAILED.)
    const sizeBytes =
      ctx.mediaType === "VIDEO" ? await probeContentLength(signedUrl) : null;
    if (sizeBytes && sizeBytes > INSTAGRAM_MAX_VIDEO_BYTES) {
      const mb = (n: number) => Math.round(n / (1024 * 1024));
      throw new PublishError(
        `Instagram 릴스 파일이 너무 큽니다 (${mb(sizeBytes)}MB, 최대 ${mb(INSTAGRAM_MAX_VIDEO_BYTES)}MB) — 인스타가 처리를 끝내지 못합니다. 해상도·fps·비트레이트를 낮춰 다시 인코딩한 뒤 올려주세요.`,
        { permanent: true },
      );
    }

    // 1. Container 확보 — 이전 시도가 남긴 컨테이너가 살아있으면 이어받고, 아니면
    //    새로 만든 뒤 즉시 resume_state에 남긴다(이번 시도가 타임아웃돼도 다음이 이어받게).
    let containerId = await resumePreviousContainer(
      ctx,
      accessToken,
      fingerprint,
    );
    if (!containerId) {
      containerId = isCarousel
        ? await createCarouselContainer(
            ctx.platformAccountId,
            accessToken,
            signedUrls,
            caption,
            ctx.deadlineAt,
          )
        : await createMediaContainer(ctx.platformAccountId, accessToken, {
            ...(ctx.mediaType === "VIDEO"
              ? {
                  media_type: "REELS",
                  video_url: signedUrl,
                  // 커버 프레임: 사용자가 고른 시점(ms)을 thumb_offset으로 전달. Reels는 영상
                  // 내 한 프레임을 커버로 지정 가능(별도 이미지 업로드 없이). 미지정이면 IG 기본.
                  ...(ctx.coverTimestampMs != null
                    ? { thumb_offset: String(ctx.coverTimestampMs) }
                    : {}),
                }
              : { image_url: signedUrl }),
            ...(caption ? { caption } : {}),
          });
      await ctx.saveResumeState({
        containerId,
        fingerprint,
        createdAt: new Date().toISOString(),
      });
    }

    // 2. Container 상태 폴링 — 상한은 파일 크기 비례(영상만; 이미지는 인코딩이 없다).
    await pollContainerReady(containerId, accessToken, {
      maxWaitMs: pollBudgetMs(sizeBytes),
      deadlineAt: ctx.deadlineAt,
    });

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

// POST /{ig-user-id}/media — 파라미터만 다르고 형태는 항상 같아서 한 곳으로 모은다.
// (자식/부모/단일 컨테이너 모두 이 엔드포인트)
async function createMediaContainer(
  igUserId: string,
  accessToken: string,
  params: Record<string, string>,
): Promise<string> {
  const url = new URL(`${GRAPH_API_BASE}/${igUserId}/media`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("access_token", accessToken);

  const res = (await callGraphApi(url.toString(), { method: "POST" })) as {
    id?: string;
  };
  if (!res.id) {
    throw new PublishError("Instagram container 응답에 id 없음");
  }
  return res.id;
}

// 캐러셀: 자식 컨테이너 N개 → 전부 준비될 때까지 대기 → 부모 컨테이너 id 반환.
// 자식 생성을 병렬로 던지지 않는 이유: IG는 계정 단위 호출 한도(code 4/17/32)가 빡세서
// 10장을 동시에 쏘면 rate limit에 걸리기 쉽다. 순차 생성해도 자식은 이미지라 금방 끝난다.
async function createCarouselContainer(
  igUserId: string,
  accessToken: string,
  signedUrls: string[],
  caption: string,
  deadlineAt: number | null,
): Promise<string> {
  if (signedUrls.length > CAROUSEL_MAX_ITEMS) {
    throw new MediaError(
      `Instagram 캐러셀은 최대 ${CAROUSEL_MAX_ITEMS}장까지 가능합니다 (현재 ${signedUrls.length}장)`,
    );
  }
  if (signedUrls.length < CAROUSEL_MIN_ITEMS) {
    throw new MediaError(
      `Instagram 캐러셀은 최소 ${CAROUSEL_MIN_ITEMS}장이 필요합니다 (현재 ${signedUrls.length}장)`,
    );
  }

  const childIds: string[] = [];
  for (const url of signedUrls) {
    childIds.push(
      await createMediaContainer(igUserId, accessToken, {
        image_url: url,
        is_carousel_item: "true",
      }),
    );
  }

  // 자식이 FINISHED가 아닌 채로 부모를 만들면 IG가 부모 컨테이너를 ERROR로 떨군다.
  for (const childId of childIds) {
    await pollContainerReady(childId, accessToken, {
      maxWaitMs: CHILD_POLL_MAX_MS,
      deadlineAt,
    });
  }

  // children 순서 = 캐러셀 슬라이드 순서. media_urls 배열 순서를 그대로 유지한다
  // (마법사의 드래그 정렬 결과가 그대로 반영되도록).
  return await createMediaContainer(igUserId, accessToken, {
    media_type: "CAROUSEL",
    children: childIds.join(","),
    ...(caption ? { caption } : {}),
  });
}

interface ContainerStatus {
  status_code?: string;
  status?: string;
}

async function getContainerStatus(
  containerId: string,
  accessToken: string,
): Promise<ContainerStatus> {
  const url = new URL(`${GRAPH_API_BASE}/${containerId}`);
  url.searchParams.set("fields", "status_code,status");
  url.searchParams.set("access_token", accessToken);
  return (await callGraphApi(url.toString())) as ContainerStatus;
}

// FINISHED 될 때까지 대기. maxWaitMs와 deadlineAt 중 이른 쪽까지 못 끝나면
// PublishError — 컨테이너 자체는 IG에 살아있으므로 호출측이 resume_state로 남긴
// id를 다음 시도가 이어받는다.
async function pollContainerReady(
  containerId: string,
  accessToken: string,
  opts: { maxWaitMs: number; deadlineAt: number | null },
): Promise<void> {
  const startedAt = Date.now();
  const giveUpAt = Math.min(
    startedAt + opts.maxWaitMs,
    opts.deadlineAt ?? Number.POSITIVE_INFINITY,
  );
  let last: ContainerStatus = {};
  let lastLoggedAt = startedAt;

  for (;;) {
    last = await getContainerStatus(containerId, accessToken);

    switch (last.status_code) {
      case "FINISHED":
      // PUBLISHED는 비정상(이미 발행됨)이지만 어쨌든 ready. 그대로 진행.
      case "PUBLISHED":
        return;
      case "ERROR":
        throw new PublishError(
          `Instagram container ERROR: ${last.status ?? "(no detail)"}`,
        );
      case "EXPIRED":
        throw new MediaError(
          `Instagram container EXPIRED — 서명 URL이 IG가 fetch하기 전 만료됨`,
        );
      default:
        // IN_PROGRESS (또는 모르는 값) — 계속 대기.
        break;
    }

    const now = Date.now();
    if (now + POLL_INTERVAL_MS > giveUpAt) break;
    // 긴 대기 중엔 1분마다 한 줄씩 — Actions 로그에서 진행을 볼 수 있게.
    if (now - lastLoggedAt >= 60_000) {
      console.log(
        `[instagram] container ${containerId} 대기 중 ${Math.round((now - startedAt) / 60_000)}분 — ${last.status_code ?? "?"}: ${last.status ?? "-"}`,
      );
      lastLoggedAt = now;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  const waitedMin = Math.round((Date.now() - startedAt) / 60_000);
  const why =
    opts.deadlineAt !== null && giveUpAt === opts.deadlineAt
      ? "워커 run 시간 예산 소진"
      : `상한 ${Math.round(opts.maxWaitMs / 60_000)}분`;
  throw new PublishError(
    `Instagram container 처리 대기 타임아웃 (${waitedMin}분 대기, ${why}; 마지막 상태 ${last.status_code ?? "?"}: ${last.status ?? "-"}) — 컨테이너 id=${containerId}는 다음 시도에서 이어서 확인`,
  );
}

// 폴링 상한 — 영상 크기에 비례. 크기를 모르면 기본값.
function pollBudgetMs(sizeBytes: number | null): number {
  if (!sizeBytes) return POLL_BASE_MS;
  const extra = (sizeBytes / (100 * 1024 * 1024)) * POLL_PER_100MB_MS;
  return Math.min(POLL_BASE_MS + extra, POLL_MAX_MS);
}

// 서명 URL에 HEAD로 파일 크기를 묻는다 (폴링 상한 산정용). 실패하면 null → 기본 상한.
async function probeContentLength(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    const len = Number(res.headers.get("content-length"));
    return res.ok && Number.isFinite(len) && len > 0 ? len : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 재시도 이어받기 (publish_jobs.resume_state).
//   { containerId, fingerprint, createdAt }
// fingerprint는 "같은 콘텐츠·캡션·커버로 만든 컨테이너인지" 확인용 — 컨테이너에는
// 캡션이 박혀 있어서, 시도 사이에 캡션을 고쳤으면 옛 컨테이너를 버리고 새로 만든다.
// ─────────────────────────────────────────────────────────────────────────────

function buildFingerprint(ctx: PublishContext, caption: string): string {
  return createHash("sha1")
    .update(
      JSON.stringify([
        ctx.contentId,
        ctx.mediaType,
        ctx.mediaSignedUrls.length,
        caption,
        ctx.coverTimestampMs,
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}

function parseResumeState(
  raw: Json | null,
): { containerId: string; fingerprint: string; createdAt: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.containerId !== "string" || typeof r.fingerprint !== "string") {
    return null;
  }
  return {
    containerId: r.containerId,
    fingerprint: r.fingerprint,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : "?",
  };
}

// 이전 시도가 남긴 컨테이너가 아직 쓸 만하면 그 id를, 아니면 null(새로 만든다).
async function resumePreviousContainer(
  ctx: PublishContext,
  accessToken: string,
  fingerprint: string,
): Promise<string | null> {
  const prev = parseResumeState(ctx.resumeState);
  if (!prev) return null;

  if (prev.fingerprint !== fingerprint) {
    console.warn(
      `[instagram] 이전 컨테이너(id=${prev.containerId})는 캡션/커버가 달라져 버림 — 새로 생성`,
    );
    return null;
  }

  let st: ContainerStatus;
  try {
    st = await getContainerStatus(prev.containerId, accessToken);
  } catch (err) {
    if (err instanceof TokenExpiredError || err instanceof RateLimitedError) {
      throw err;
    }
    // 컨테이너가 IG에서 사라졌거나(24시간 만료) 조회 불가 — 새로 만든다.
    console.warn(
      `[instagram] 이전 컨테이너(id=${prev.containerId}) 조회 실패 — 새로 생성: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }

  if (st.status_code === "ERROR" || st.status_code === "EXPIRED") {
    console.warn(
      `[instagram] 이전 컨테이너(id=${prev.containerId}) ${st.status_code}: ${st.status ?? "-"} — 새로 생성`,
    );
    return null;
  }

  console.log(
    `[instagram] 이전 시도 컨테이너 이어받음 (id=${prev.containerId}, 생성 ${prev.createdAt}, 상태 ${st.status_code ?? "?"})`,
  );
  return prev.containerId;
}

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
import type { Json } from "@/types/database";

// 스레드(Threads) API. 인스타 발행 API에는 스레드 공유 옵션이 없어 따로 연결한다(0056).
// Meta 앱의 "Threads API" 사용 사례에서 받은 THREADS_APP_ID / THREADS_APP_SECRET을 쓴다
// (인스타 로그인 앱 id와 다르다). 권한은 기본 정보와 게시 두 개만.
const SCOPES = ["threads_basic", "threads_content_publish"];

const AUTH_URL = "https://threads.net/oauth/authorize";
const TOKEN_URL = "https://graph.threads.net/oauth/access_token";
const LONG_LIVED_URL = "https://graph.threads.net/access_token";
const REFRESH_URL = "https://graph.threads.net/refresh_access_token";
const API_BASE = "https://graph.threads.net/v1.0";

// 스레드 규격: 글 500자, 캐러셀 2~20장, 주제 태그 1개.
const MAX_TEXT = 500;
const CAROUSEL_MIN_ITEMS = 2;
const CAROUSEL_MAX_ITEMS = 20;

// 컨테이너 처리 대기. 사진은 몇 초, 영상은 몇 분. 넘기면 컨테이너 id를 남겨 다음 시도가 잇는다.
const POLL_INTERVAL_MS = 3000;
const IMAGE_POLL_MAX_MS = 60_000;
const VIDEO_POLL_MAX_MS = 10 * 60_000;

interface GraphApiError {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number };
}

function mapThreadsError(status: number, body: string): never {
  let parsed: GraphApiError | null = null;
  try {
    parsed = JSON.parse(body) as GraphApiError;
  } catch {
    // 그대로
  }
  const code = parsed?.error?.code;
  const message = parsed?.error?.message ?? body.slice(0, 300);
  if (status === 401 || code === 190 || code === 102) {
    throw new TokenExpiredError(`스레드 access_token 무효: ${message}`);
  }
  if (status === 429 || [4, 17, 32, 613].includes(code ?? -1)) {
    throw new RateLimitedError(`스레드 요청 한도를 넘었어요: ${message}`);
  }
  if (status === 403 || code === 10 || code === 200) {
    throw new PublishError(`스레드 권한 · 정책 오류: ${message}`);
  }
  throw new PublishError(`스레드 API 오류 (${status}): ${message}`);
}

async function callApi(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  if (!res.ok) mapThreadsError(res.status, await res.text());
  return res.json();
}

function appCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.THREADS_APP_ID;
  const clientSecret = process.env.THREADS_APP_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("THREADS_APP_ID / THREADS_APP_SECRET 환경변수 없음");
  }
  return { clientId, clientSecret };
}

// 스레드 주제 태그 — 1~50자, 마침표 · & 불가. 인스타 해시태그 중 첫 번째로 쓸 수 있는 것.
function pickTopicTag(hashtags: string[]): string | null {
  for (const raw of hashtags) {
    const tag = raw.replace(/^#+/, "").trim();
    if (tag && tag.length <= 50 && !/[.&\s]/.test(tag)) return tag;
  }
  return null;
}

// 인스타 캡션을 스레드 500자에 맞춘다. 본문 안의 #해시태그는 스레드가 첫 하나만 태그로
// 쓰고 나머지는 글자로 남아 지저분하니 지우고, 태그는 topic_tag로 하나만 보낸다.
// 넘치면 문장 · 줄 경계에서 자르고 말줄임표를 붙인다.
export function buildThreadsText(caption: string | null): string {
  const body = (caption ?? "")
    .replace(/(^|\s)#[^\s#]+/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (body.length <= MAX_TEXT) return body;
  const room = MAX_TEXT - 1;
  const cut = body.slice(0, room);
  const boundary = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "));
  const head = boundary > room * 0.6 ? cut.slice(0, boundary + 1) : cut;
  return `${head.trimEnd()}…`;
}

export const threads: PlatformAdapter = {
  buildAuthUrl(state, redirectUri) {
    const clientId = process.env.THREADS_APP_ID;
    if (!clientId) throw new Error("THREADS_APP_ID 환경변수 없음");
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: SCOPES.join(","),
      response_type: "code",
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  },

  async exchangeCode(rawCode, redirectUri): Promise<OAuthTokens> {
    const { clientId, clientSecret } = appCredentials();
    // 스레드는 code 끝에 "#_"를 붙여 보낼 때가 있다.
    const code = rawCode.replace(/#_$/, "");

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
      throw new Error(`스레드 토큰 교환 실패 (${tokenRes.status}): ${text.slice(0, 200)}`);
    }
    const shortLived = (await tokenRes.json()) as { access_token?: string; user_id?: string | number };
    if (!shortLived.access_token) {
      throw new Error("스레드 short-lived 토큰 응답에 access_token 없음");
    }

    // 1시간짜리를 바로 60일짜리로 바꾼다 — 발행 · 갱신은 60일 토큰으로만 된다.
    const longUrl = new URL(LONG_LIVED_URL);
    longUrl.searchParams.set("grant_type", "th_exchange_token");
    longUrl.searchParams.set("client_secret", clientSecret);
    longUrl.searchParams.set("access_token", shortLived.access_token);
    const longRes = await fetch(longUrl);
    if (!longRes.ok) {
      const text = await longRes.text();
      throw new Error(`스레드 60일 토큰 교환 실패 (${longRes.status}): ${text.slice(0, 200)}`);
    }
    const longData = (await longRes.json()) as { access_token: string; expires_in?: number };

    const me = (await callApi(
      `${API_BASE}/me?fields=id,username,threads_profile_picture_url&access_token=${encodeURIComponent(longData.access_token)}`,
    )) as { id: string; username?: string; threads_profile_picture_url?: string };

    return {
      accessToken: longData.access_token,
      // 인스타처럼 별도 refresh_token이 없고 60일 토큰 자신을 갱신한다. 갱신 sweep이
      // refresh_token_encrypted IS NOT NULL로 고르므로 같은 값을 넣는다.
      refreshToken: longData.access_token,
      expiresAt: longData.expires_in ? new Date(Date.now() + longData.expires_in * 1000) : null,
      accountInfo: {
        platformAccountId: String(me.id),
        displayName: me.username ?? null,
        avatarUrl: me.threads_profile_picture_url ?? null,
      },
      grantedScopes: SCOPES,
    };
  },

  // ───────────────────────────────────────────────────────────────────────────
  // 게시 흐름 (인스타와 같은 컨테이너 방식):
  //   1. POST /{user-id}/threads  (media_type=IMAGE|VIDEO, text, topic_tag) → 컨테이너
  //      캐러셀은 장마다 is_carousel_item=true 자식 → 부모(media_type=CAROUSEL, children)
  //   2. GET  /{container-id}?fields=status,error_message → FINISHED까지 대기
  //   3. POST /{user-id}/threads_publish?creation_id=... → 게시 id
  //   4. GET  /{media-id}?fields=permalink
  // ───────────────────────────────────────────────────────────────────────────
  async publish(ctx, accessToken): Promise<PublishResult> {
    if (!ctx.platformAccountId) throw new PublishError("스레드 발행: 계정 id 누락");
    const urls = ctx.mediaSignedUrls;
    if (urls.length === 0) throw new MediaError("스레드 발행: 미디어 서명 URL이 비어 있어요");

    const text = buildThreadsText(ctx.caption);
    const topicTag = pickTopicTag(ctx.hashtags);
    const kinds = urls.map((_, i) => ctx.mediaItemKinds?.[i] ?? ctx.mediaType);
    const isCarousel = urls.length > 1;
    if (isCarousel && urls.length > CAROUSEL_MAX_ITEMS) {
      throw new PublishError(`스레드 캐러셀은 최대 ${CAROUSEL_MAX_ITEMS}장이에요 (${urls.length}장)`, { permanent: true });
    }
    const hasVideo = kinds.includes("VIDEO");
    const pollMax = hasVideo ? VIDEO_POLL_MAX_MS : IMAGE_POLL_MAX_MS;
    const fingerprint = buildFingerprint(ctx, text, topicTag);

    let containerId = await resumePreviousContainer(ctx, accessToken, fingerprint);
    if (!containerId) {
      const base: Record<string, string> = {
        ...(text ? { text } : {}),
        ...(topicTag ? { topic_tag: topicTag } : {}),
      };
      if (isCarousel) {
        if (urls.length < CAROUSEL_MIN_ITEMS) throw new PublishError("스레드 캐러셀은 2장 이상이어야 해요");
        const children: string[] = [];
        for (let i = 0; i < urls.length; i++) {
          const childId = await createContainer(ctx.platformAccountId, accessToken, {
            ...mediaParams(kinds[i], urls[i]),
            is_carousel_item: "true",
          });
          await pollContainerReady(childId, accessToken, {
            maxWaitMs: kinds[i] === "VIDEO" ? VIDEO_POLL_MAX_MS : IMAGE_POLL_MAX_MS,
            deadlineAt: ctx.deadlineAt,
          });
          children.push(childId);
        }
        containerId = await createContainer(ctx.platformAccountId, accessToken, {
          ...base,
          media_type: "CAROUSEL",
          children: children.join(","),
        });
      } else {
        containerId = await createContainer(ctx.platformAccountId, accessToken, {
          ...base,
          ...mediaParams(kinds[0], urls[0]),
        });
      }
      await ctx.saveResumeState({ threadsContainerId: containerId, fingerprint, createdAt: new Date().toISOString() });
    }

    await pollContainerReady(containerId, accessToken, { maxWaitMs: pollMax, deadlineAt: ctx.deadlineAt });

    const publishUrl = new URL(`${API_BASE}/${ctx.platformAccountId}/threads_publish`);
    publishUrl.searchParams.set("creation_id", containerId);
    publishUrl.searchParams.set("access_token", accessToken);
    const published = (await callApi(publishUrl.toString(), { method: "POST" })) as { id?: string };
    if (!published.id) throw new PublishError("스레드 threads_publish 응답에 id 없음");

    let permalink: string | null = null;
    try {
      const res = (await callApi(
        `${API_BASE}/${published.id}?fields=permalink&access_token=${encodeURIComponent(accessToken)}`,
      )) as { permalink?: string };
      permalink = res.permalink ?? null;
    } catch (err) {
      console.warn(`[threads] permalink 조회 실패 (media_id=${published.id}):`, err instanceof Error ? err.message : err);
    }
    return { platformPostId: published.id, platformPostUrl: permalink ?? "https://www.threads.net/" };
  },

  // 60일 토큰 자신을 th_refresh_token으로 연장한다(발급 24시간 뒤부터 가능).
  async refreshToken(current): Promise<RefreshedTokens> {
    const url = new URL(REFRESH_URL);
    url.searchParams.set("grant_type", "th_refresh_token");
    url.searchParams.set("access_token", current);
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      if (res.status === 400 || res.status === 401 || body.includes("OAuthException")) {
        throw new TokenExpiredError(`스레드 토큰 갱신 실패: ${body.slice(0, 200)}`);
      }
      throw new PublishError(`스레드 토큰 갱신 오류 (${res.status}): ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in?: number };
    return {
      accessToken: data.access_token,
      refreshToken: data.access_token,
      expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
    };
  },
};

function mediaParams(kind: "IMAGE" | "VIDEO", url: string): Record<string, string> {
  return kind === "VIDEO" ? { media_type: "VIDEO", video_url: url } : { media_type: "IMAGE", image_url: url };
}

async function createContainer(userId: string, accessToken: string, params: Record<string, string>): Promise<string> {
  const url = new URL(`${API_BASE}/${userId}/threads`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", accessToken);
  const res = (await callApi(url.toString(), { method: "POST" })) as { id?: string };
  if (!res.id) throw new PublishError("스레드 컨테이너 생성 응답에 id 없음");
  return res.id;
}

type ContainerStatus = { status?: string; error_message?: string };

async function getContainerStatus(containerId: string, accessToken: string): Promise<ContainerStatus> {
  const url = new URL(`${API_BASE}/${containerId}`);
  url.searchParams.set("fields", "status,error_message");
  url.searchParams.set("access_token", accessToken);
  return (await callApi(url.toString())) as ContainerStatus;
}

async function pollContainerReady(
  containerId: string,
  accessToken: string,
  opts: { maxWaitMs: number; deadlineAt: number | null },
): Promise<void> {
  const startedAt = Date.now();
  const giveUpAt = Math.min(startedAt + opts.maxWaitMs, opts.deadlineAt ?? Number.POSITIVE_INFINITY);
  let last: ContainerStatus = {};
  for (;;) {
    last = await getContainerStatus(containerId, accessToken);
    if (last.status === "FINISHED" || last.status === "PUBLISHED") return;
    if (last.status === "ERROR") {
      throw new PublishError(`스레드 컨테이너 오류: ${last.error_message ?? "(내용 없음)"}`);
    }
    if (last.status === "EXPIRED") {
      throw new MediaError("스레드 컨테이너가 만료됐어요 — 서명 URL을 받기 전에 시간이 지났어요");
    }
    if (Date.now() + POLL_INTERVAL_MS > giveUpAt) break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  const waitedSec = Math.round((Date.now() - startedAt) / 1000);
  throw new PublishError(
    `스레드 컨테이너 처리 대기 시간 초과 (${waitedSec}초, 마지막 상태 ${last.status ?? "?"}) — 컨테이너 id=${containerId}는 다음 시도에서 이어서 확인`,
  );
}

function buildFingerprint(ctx: PublishContext, text: string, topicTag: string | null): string {
  return createHash("sha1")
    .update(JSON.stringify([ctx.contentId, ctx.mediaType, ctx.mediaSignedUrls.length, text, topicTag]))
    .digest("hex")
    .slice(0, 16);
}

// 이전 시도가 만든 컨테이너가 같은 글로 만든 것이고 아직 쓸 수 있으면 그 id를 쓴다.
async function resumePreviousContainer(
  ctx: PublishContext,
  accessToken: string,
  fingerprint: string,
): Promise<string | null> {
  const state = ctx.resumeState as { [k: string]: Json | undefined } | null;
  const id = state && typeof state.threadsContainerId === "string" ? state.threadsContainerId : null;
  if (!id || state?.fingerprint !== fingerprint) return null;
  try {
    const status = await getContainerStatus(id, accessToken);
    if (status.status === "IN_PROGRESS" || status.status === "FINISHED") {
      console.log(`[threads] 이전 시도 컨테이너 이어받기 ${id} (${status.status})`);
      return id;
    }
  } catch (err) {
    if (err instanceof TokenExpiredError) throw err;
  }
  return null;
}

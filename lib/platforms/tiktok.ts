import "./server-guard";
import type { Json } from "@/types/database";
import {
  exchangeAuthCode,
  getBusinessAccount,
  getPublishStatus,
  publishVideo,
  refreshAccessToken,
  tiktokAppCredentials,
  tiktokMediaUrl,
  tiktokScopes,
  TIKTOK_AUTH_URL,
  type TikTokPublishStatus,
} from "./tiktok-business";
import {
  MediaError,
  PublishError,
  type OAuthTokens,
  type PlatformAdapter,
  type PublishContext,
  type PublishResult,
  type RefreshedTokens,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// TikTok — TikTok API for Business v1.3 "TikTok 계정"(2026-11-13 전환).
// 예전 TikTok for Developers(Login Kit + Content Posting API)는 게시 권한 승인을 받지 못해 바꿨다.
//   · 연결: www.tiktok.com/v2/auth/authorize/ → /tt_user/oauth2/token/ (auth_code)
//   · 토큰: 접근 토큰 24시간, 갱신 토큰 약 1년. 갱신할 때마다 갱신 토큰도 새로 온다.
//   · 게시: /business/video/publish/에 영상 주소를 넘기면 TikTok이 가져가 게시한다(전체 공개 —
//     이 API에는 비공개 옵션이 없다, 사용자 결정 2026-11-13). 주소는 소유 인증한 우리 도메인이어야 해서
//     Supabase 서명 주소를 /tiktok-media/로 바꿔 넘긴다(tiktokMediaUrl).
//   · 상태: /business/publish/status/ → PUBLISH_COMPLETE면 post_ids[0]이 게시물 id(최대 몇 분 늦게 채워짐).
// 호출 세부는 tiktok-business.ts.
// ─────────────────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5000;
const POLL_MAX_ATTEMPTS = 60; // 약 5분 — 영상 내려받기 · 처리 · 게시물 id가 채워질 때까지
// PUBLISH_COMPLETE 뒤 게시물 id(post_ids)를 기다리는 최대 횟수. 그래도 없으면 publish_id로 끝낸다.
const POST_ID_WAIT_ATTEMPTS = 36; // 약 3분
const CAPTION_MAX = 2200;

// 캡션은 본문 + 해시태그 인라인. caption-generator의 postProcessTiktok이 이미
// 본문 안에 #태그를 넣어주지만, hashtags 배열로 별도 들어온 경우도 합쳐서 처리.
function buildTikTokCaption(ctx: PublishContext): string {
  const tagLine = ctx.hashtags
    .map((t) => (t.startsWith("#") ? t : `#${t}`))
    .join(" ");
  const parts: string[] = [];
  if (ctx.caption?.trim()) parts.push(ctx.caption.trim());
  if (tagLine && !ctx.caption?.includes(tagLine)) parts.push(tagLine);
  return Array.from(parts.join(" ")).slice(0, CAPTION_MAX).join("");
}

export const tiktok: PlatformAdapter = {
  buildAuthUrl(state, redirectUri) {
    const { clientId } = tiktokAppCredentials();
    const params = new URLSearchParams({
      client_key: clientId,
      scope: tiktokScopes(),
      response_type: "code",
      redirect_uri: redirectUri,
      state,
    });
    return `${TIKTOK_AUTH_URL}?${params.toString()}`;
  },

  async exchangeCode(code, redirectUri): Promise<OAuthTokens> {
    const token = await exchangeAuthCode(code, redirectUri);
    if (!token.access_token || !token.open_id) {
      throw new Error("TikTok 토큰 교환 응답에 access_token 또는 open_id가 없어요");
    }

    // 표시 이름 · 프로필 사진. 못 읽어도 연결은 진행한다(이름은 다음 연결 때 채워짐).
    let displayName: string | null = null;
    let avatarUrl: string | null = null;
    try {
      const account = await getBusinessAccount(token.access_token, token.open_id, [
        "username",
        "display_name",
        "profile_image",
      ]);
      displayName = account.display_name || account.username || null;
      avatarUrl = account.profile_image ?? null;
    } catch (err) {
      console.warn("[tiktok] 계정 정보 조회 실패 — 이름 없이 연결:", err instanceof Error ? err.message : err);
    }

    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : null,
      accountInfo: {
        platformAccountId: token.open_id,
        displayName,
        avatarUrl,
      },
      grantedScopes: token.scope
        ? token.scope.split(",").map((s) => s.trim()).filter(Boolean)
        : null,
    };
  },

  async publish(ctx, accessToken): Promise<PublishResult> {
    if (ctx.mediaType !== "VIDEO") {
      throw new PublishError(
        `TikTok 게시는 동영상만 지원해요 (받은 형식: ${ctx.mediaType})`,
        { permanent: true },
      );
    }
    const businessId = ctx.platformAccountId;

    // 0. 이전 시도가 게시 요청까지 끝냈으면 새로 요청하지 않고 그 publish_id의 상태만 이어서 본다.
    //    요청이 들어가면 TikTok이 알아서 영상을 가져가 게시하므로, 폴링만 끊긴 것을 다시 요청하면
    //    같은 영상이 두 번 올라간다.
    const resumed = parseTikTokResume(ctx.resumeState, ctx.contentId);
    if (resumed) {
      console.log(
        `[tiktok] 이전 시도 게시 요청 이어받음 (publish_id=${resumed.publishId}, 요청 ${resumed.uploadedAt}) — 상태만 확인`,
      );
      return await finishTikTokPublish(ctx, businessId, resumed.publishId, accessToken);
    }

    const signedUrl = ctx.mediaSignedUrls[0];
    if (!signedUrl) {
      throw new MediaError("TikTok 게시: 미디어 서명 주소가 비어 있어요");
    }
    const videoUrl = tiktokMediaUrl(signedUrl);

    const publishId = await publishVideo(accessToken, businessId, videoUrl, {
      caption: buildTikTokCaption(ctx),
      disable_comment: false,
      disable_duet: false,
      disable_stitch: false,
      // 상업 콘텐츠 공개 값 — 틱톡이 빠지면 40002로 거절한다(2026-11-13 실측).
      // 우리 몰 상품을 소개하는 영상이라 '내 브랜드 홍보'로 표시하고(사용자 결정, 2026-11-13),
      // 다른 브랜드의 유료 협찬은 아니다.
      is_brand_organic: true,
      is_branded_content: false,
      // 커버 프레임: 사용자가 마법사에서 고른 시점(ms). 미지정이면 1초 프레임.
      thumbnail_offset: ctx.coverTimestampMs ?? 1000,
    });

    // 게시 요청이 들어갔으니 publish_id를 바로 남긴다 — 이번 폴링이 끊겨도 다음 시도가 이어받는다.
    await ctx.saveResumeState({
      tiktok: {
        publishId,
        contentId: ctx.contentId,
        uploadedAt: new Date().toISOString(),
      },
    });

    return await finishTikTokPublish(ctx, businessId, publishId, accessToken);
  },

  async refreshToken(refreshTokenPlain): Promise<RefreshedTokens> {
    const data = await refreshAccessToken(refreshTokenPlain);
    return {
      accessToken: data.access_token,
      // 갱신할 때마다 새 갱신 토큰이 온다 — 다음 갱신은 이 값으로.
      refreshToken: data.refresh_token ?? null,
      expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
    };
  },
};

// 게시 요청이 들어간 publish_id의 상태를 끝까지 보고 결과를 만든다. 첫 시도 · 이어받은 시도 공통.
async function finishTikTokPublish(
  ctx: PublishContext,
  businessId: string,
  publishId: string,
  accessToken: string,
): Promise<PublishResult> {
  let postId: string | null;
  try {
    postId = await pollTikTokStatus(businessId, publishId, accessToken, ctx.deadlineAt);
  } catch (err) {
    // TikTok이 처리 실패로 끝낸 요청은 이어받을 게 없다 — 다음 시도는 처음부터 다시 요청한다.
    // (폴링 타임아웃 · 네트워크 오류는 이어받기 상태를 그대로 둔다.)
    if (err instanceof TikTokProcessingFailed) await ctx.saveResumeState(null);
    throw err;
  }

  // 게시물 id가 끝내 안 채워지면 publish_id로 남긴다(성과 수집에서 이 게시물은 발행 작업과 연결되지 않는다).
  return {
    platformPostId: postId ?? publishId,
    platformPostUrl: postId ? `https://www.tiktok.com/video/${postId}` : "https://www.tiktok.com/",
  };
}

// 이전 시도가 남긴 게시 요청 상태. 같은 콘텐츠의 것이 아니면 버린다.
function parseTikTokResume(
  raw: Json | null,
  contentId: string,
): { publishId: string; uploadedAt: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const t = (raw as Record<string, unknown>).tiktok;
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  const r = t as Record<string, unknown>;
  if (typeof r.publishId !== "string" || !r.publishId) return null;
  if (r.contentId !== contentId) return null;
  return {
    publishId: r.publishId,
    uploadedAt: typeof r.uploadedAt === "string" ? r.uploadedAt : "?",
  };
}

// TikTok이 FAILED로 끝낸 요청. 일반 PublishError와 구분해 이어받기 상태를 지운다.
// 형식 · 길이 · 프레임 수 같은 영상 문제는 다시 해도 같으므로 영구 실패로 끝낸다.
class TikTokProcessingFailed extends PublishError {}

const PERMANENT_REASONS = [
  "file_format_check_failed",
  "duration_check_failed",
  "frame_rate_check_failed",
  "picture_size_check_failed",
  "spam_risk_user_banned_from_posting",
];

/** 게시가 끝나면 게시물 id(없으면 null)를 돌려준다. */
async function pollTikTokStatus(
  businessId: string,
  publishId: string,
  accessToken: string,
  deadlineAt: number | null,
): Promise<string | null> {
  let completeChecks = 0;
  for (let i = 0; i < POLL_MAX_ATTEMPTS + POST_ID_WAIT_ATTEMPTS; i++) {
    // run 시간 예산을 넘기기 전에 내려놓는다 — 다음 시도가 이 publish_id를 이어서 본다.
    if (deadlineAt !== null && Date.now() + POLL_INTERVAL_MS > deadlineAt) {
      throw new PublishError(
        `TikTok 상태 확인 중 이번 실행 시간이 끝남 (publish_id=${publishId}) — 다음 시도가 이어서 확인`,
      );
    }
    const data = await getPublishStatus(accessToken, businessId, publishId);
    const status: TikTokPublishStatus | undefined = data.status;
    if (status === "PUBLISH_COMPLETE") {
      const postId = data.post_ids?.[0];
      if (postId) return postId;
      // 게시는 끝났는데 id가 아직 안 채워짐 — 조금 더 기다린다.
      if (++completeChecks >= POST_ID_WAIT_ATTEMPTS) return null;
    } else if (status === "SEND_TO_USER_INBOX") {
      // 초안함으로 간 경우(이 경로에선 쓰지 않지만 오면 성공으로 본다 — 워커가 더 할 일은 없다).
      return null;
    } else if (status === "FAILED") {
      const reason = data.reason ?? "(이유 없음)";
      throw new TikTokProcessingFailed(`TikTok 게시 실패: ${reason}`, {
        permanent: PERMANENT_REASONS.includes(reason),
      });
    } else if (i >= POLL_MAX_ATTEMPTS) {
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new PublishError(
    `TikTok 상태 확인 시간 초과 (publish_id=${publishId}) — 다음 시도가 이어서 확인`,
  );
}

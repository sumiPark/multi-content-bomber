import type { Json } from "@/types/database";

export type Platform = "INSTAGRAM" | "TIKTOK" | "YOUTUBE";

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  accountInfo: {
    platformAccountId: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
}

// refreshToken() 결과 — accountInfo는 갱신 단계에선 안 받음.
export interface RefreshedTokens {
  accessToken: string;
  // refresh_token 자체가 갱신될 수도, 그대로일 수도. null이면 기존 값 유지.
  refreshToken: string | null;
  expiresAt: Date | null;
}

// 어댑터에 전달하는 게시 컨텍스트. 워커가 DB/Storage에서 미리 조합해 넘긴다.
export interface PublishContext {
  contentId: string;
  // 어댑터가 플랫폼 API 호출 시 user/channel/open_id를 URL path에 박아야 하는 경우.
  // YouTube는 access_token으로 자동 자기 채널 식별이라 사용하지 않지만, Instagram
  // Graph API는 `/{ig-user-id}/media` 형태로 path에 ID가 들어간다.
  platformAccountId: string;
  // DB contents.media_type enum과 같은 값. ("PHOTO"가 아니다 — 실제 값은 "IMAGE")
  mediaType: "VIDEO" | "IMAGE";
  // Storage 단기 서명 URL 배열. 어댑터가 cURL/fetch로 가져갈 수 있는 형태.
  mediaSignedUrls: string[];
  // 플랫폼별 캡션 필드를 워커가 풀어서 전달. YouTube=title/description/tags,
  // Instagram/TikTok=caption/hashtags. 불필요 필드는 null/빈 배열.
  title: string | null;
  description: string | null;
  caption: string | null;
  hashtags: string[];
  // 커버(썸네일) — 영상 한정. 사용자가 마법사에서 고른 프레임 한 시점이 출처.
  //   coverTimestampMs: 영상 내 프레임 오프셋(ms). TikTok=video_cover_timestamp_ms,
  //                     Instagram(REELS)=thumb_offset 로 그대로 전달.
  //   coverSignedUrl:   그 프레임을 이미지로 추출해 Storage에 올린 파일의 서명 URL.
  //                     YouTube는 프레임 타임스탬프 API가 없어 thumbnails.set에 이 이미지를 업로드.
  // 둘 다 null이면 커버 미지정(어댑터 기본 동작).
  coverTimestampMs: number | null;
  coverSignedUrl: string | null;
  // ── 재시도 이어받기 ──
  // 플랫폼이 서버에서 오래 처리하는 작업(Instagram 컨테이너 인코딩 등)은 한 시도의
  // 폴링 상한 안에 안 끝날 수 있다. 그때 진행분을 버리지 않도록, 어댑터가 다음 시도가
  // 이어받을 상태를 job(publish_jobs.resume_state)에 남기고 다음 시도가 읽는다.
  //   resumeState:     이전 시도가 남긴 상태. 첫 시도거나 없으면 null. 형식은 어댑터
  //                    자유 — 자기 것이 맞는지(같은 콘텐츠·캡션인지) 어댑터가 검증한다.
  //   saveResumeState: 이어받을 상태가 생긴 즉시(예: 컨테이너 생성 직후) 호출.
  //                    best-effort — 저장 실패는 워커가 경고만 남기고 발행은 계속.
  //   deadlineAt:      이 시도가 폴링을 포기해야 하는 시각(epoch ms). 워커 run의 시간
  //                    예산에서 온다 — GitHub Actions job timeout에 죽어 PROCESSING으로
  //                    굳기 전에 RETRYING으로 내려놓기 위함. null이면 어댑터 상한만.
  resumeState: Json | null;
  saveResumeState: (state: Json) => Promise<void>;
  deadlineAt: number | null;
}

export interface PublishResult {
  platformPostId: string;
  platformPostUrl: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 에러 분류. 워커가 instanceof로 분기 — 재시도 가치 / social_accounts.is_active
// 처리 / status_history 메시지 결정.
//
//   TokenExpired   : access_token revoke 또는 refresh 실패. 즉시 FAILED, 계정 비활성.
//   RateLimited    : 플랫폼 rate limit. BullMQ backoff로 재시도 가치 있음.
//   MediaError     : Storage 서명 URL 만료 / 미디어 fetch 실패. 재시도 가치 있음.
//   PublishError   : 그 외 (스키마 위반, 정책 위반 등). 재시도하되 영구 실패에 수렴.
// ─────────────────────────────────────────────────────────────────────────────

export class TokenExpiredError extends Error {
  readonly kind = "TOKEN_EXPIRED" as const;
  constructor(message: string) {
    super(message);
    this.name = "TokenExpiredError";
  }
}

export class RateLimitedError extends Error {
  readonly kind = "RATE_LIMITED" as const;
  // retry-after 초. 어댑터가 응답 헤더에서 파싱 가능하면 채운다.
  retryAfterSec: number | null;
  constructor(message: string, retryAfterSec: number | null = null) {
    super(message);
    this.name = "RateLimitedError";
    this.retryAfterSec = retryAfterSec;
  }
}

export class MediaError extends Error {
  readonly kind = "MEDIA_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "MediaError";
  }
}

export class PublishError extends Error {
  readonly kind = "PUBLISH_ERROR" as const;
  // true면 재시도해도 결과가 같은 실패(예: 플랫폼 한도 초과 파일) — 남은 시도를
  // 쓰지 않고 바로 FAILED로 끝낸다.
  readonly permanent: boolean;
  constructor(message: string, opts: { permanent?: boolean } = {}) {
    super(message);
    this.name = "PublishError";
    this.permanent = opts.permanent ?? false;
  }
}

export interface PlatformAdapter {
  buildAuthUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<OAuthTokens>;
  // Phase 4b ④: 실제 게시. accessToken은 plain text — 워커가 복호화 후 전달.
  publish(ctx: PublishContext, accessToken: string): Promise<PublishResult>;
  // Phase 4c 연계: refresh_token으로 access_token 재발급. plain text in/out.
  refreshToken(refreshToken: string): Promise<RefreshedTokens>;
}

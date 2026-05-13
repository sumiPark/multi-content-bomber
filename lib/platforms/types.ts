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
  mediaType: "VIDEO" | "PHOTO";
  // Storage 단기 서명 URL 배열. 어댑터가 cURL/fetch로 가져갈 수 있는 형태.
  mediaSignedUrls: string[];
  // 플랫폼별 캡션 필드를 워커가 풀어서 전달. YouTube=title/description/tags,
  // Instagram/TikTok=caption/hashtags. 불필요 필드는 null/빈 배열.
  title: string | null;
  description: string | null;
  caption: string | null;
  hashtags: string[];
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
  constructor(message: string) {
    super(message);
    this.name = "PublishError";
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

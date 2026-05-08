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

export interface PlatformAdapter {
  buildAuthUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<OAuthTokens>;
}

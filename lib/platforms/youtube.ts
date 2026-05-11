import "server-only";
import type { OAuthTokens, PlatformAdapter } from "./types";

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
};

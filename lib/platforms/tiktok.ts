import "server-only";
import type { OAuthTokens, PlatformAdapter } from "./types";

// TikTok Login Kit + Content Posting API. https://developers.tiktok.com
// Content Posting API는 별도 승인 필요(승인 난이도 높음).
const SCOPES = ["user.info.basic", "video.publish", "video.upload"].join(",");

const AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const USER_INFO_URL =
  "https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name";

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
};

import "server-only";
import type { OAuthTokens, PlatformAdapter } from "./types";

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

    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      user_id?: string | number;
      permissions?: string;
    };

    // Short-lived access_token. Production에선 long-lived(60일) 토큰으로 교환 권장.
    const meRes = await fetch(
      `${ME_URL}?fields=id,username&access_token=${encodeURIComponent(tokenData.access_token)}`,
    );
    if (!meRes.ok) {
      throw new Error(`Instagram 사용자 정보 조회 실패 (${meRes.status})`);
    }
    const me = (await meRes.json()) as {
      id: string;
      username: string;
    };

    return {
      accessToken: tokenData.access_token,
      refreshToken: null,
      expiresAt: null,
      accountInfo: {
        platformAccountId: String(me.id),
        displayName: me.username,
        avatarUrl: null,
      },
    };
  },
};

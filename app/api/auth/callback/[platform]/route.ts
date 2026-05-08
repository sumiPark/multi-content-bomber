import { NextResponse, type NextRequest } from "next/server";
import { encryptToken } from "@/lib/crypto";
import {
  getAdapter,
  getRedirectUri,
  isSupportedPlatform,
  type Platform,
} from "@/lib/platforms";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

const STATE_COOKIE = "oauth_state";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ platform: string }> },
) {
  const { platform: platformParam } = await params;
  const platformUpper = platformParam.toUpperCase();

  if (!isSupportedPlatform(platformUpper)) {
    return redirectWithError(request, "지원하지 않는 플랫폼");
  }
  const platform = platformUpper as Platform;

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const providerError =
    url.searchParams.get("error_description") ||
    url.searchParams.get("error") ||
    null;

  if (providerError) {
    return redirectWithError(request, `OAuth 거부: ${providerError}`);
  }
  if (!code || !state) {
    return redirectWithError(request, "code 또는 state 누락");
  }

  // Verify CSRF state
  const expectedState = request.cookies.get(STATE_COOKIE)?.value;
  if (!expectedState || expectedState !== state) {
    const response = redirectWithError(request, "OAuth state 검증 실패");
    response.cookies.delete(STATE_COOKIE);
    return response;
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("organization_id")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile?.organization_id) {
    return NextResponse.redirect(new URL("/onboarding", request.url));
  }

  const adapter = getAdapter(platform);
  if (!adapter) {
    return redirectWithError(request, `${platform}은 아직 준비 중입니다.`);
  }

  try {
    const tokens = await adapter.exchangeCode(code, getRedirectUri(platform));

    const accessEnc = encryptToken(tokens.accessToken);
    const refreshEnc = tokens.refreshToken
      ? encryptToken(tokens.refreshToken)
      : null;

    // Use service role: token columns are revoked from `authenticated`.
    const service = createServiceClient();
    const { error } = await service.from("social_accounts").upsert(
      {
        organization_id: profile.organization_id,
        connected_by: user.id,
        platform,
        platform_account_id: tokens.accountInfo.platformAccountId,
        display_name: tokens.accountInfo.displayName,
        avatar_url: tokens.accountInfo.avatarUrl,
        access_token_encrypted: accessEnc,
        refresh_token_encrypted: refreshEnc,
        token_expires_at: tokens.expiresAt?.toISOString() ?? null,
        is_active: true,
      },
      { onConflict: "organization_id,platform,platform_account_id" },
    );

    if (error) {
      console.error("[oauth callback] upsert failed:", error);
      const response = redirectWithError(request, `저장 실패: ${error.message}`);
      response.cookies.delete(STATE_COOKIE);
      return response;
    }

    const response = NextResponse.redirect(
      new URL(`/accounts?connected=${platform.toLowerCase()}`, request.url),
    );
    response.cookies.delete(STATE_COOKIE);
    return response;
  } catch (err) {
    console.error("[oauth callback] failed:", err);
    const response = redirectWithError(
      request,
      err instanceof Error ? err.message : "OAuth 콜백 실패",
    );
    response.cookies.delete(STATE_COOKIE);
    return response;
  }
}

function redirectWithError(request: NextRequest, message: string) {
  return NextResponse.redirect(
    new URL(`/accounts?error=${encodeURIComponent(message)}`, request.url),
  );
}

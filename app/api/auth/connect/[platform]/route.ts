import { randomBytes } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  getAdapter,
  getRedirectUri,
  isSupportedPlatform,
  type Platform,
} from "@/lib/platforms";

const STATE_COOKIE = "oauth_state";
const STATE_TTL_SECONDS = 900; // 15 minutes — Google "테스트 중인 앱" 경고 + 권한 동의 단계 고려

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

  const adapter = getAdapter(platform);
  if (!adapter) {
    return redirectWithError(request, `${platform}은 아직 준비 중입니다.`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  // 계정 연결 · 다시 연결은 관리자 · 매니저만(콜백이 service 키로 저장해 RLS가 막아 주지 않는다)
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (profile?.role !== "ADMIN" && profile?.role !== "MANAGER") {
    return redirectWithError(request, "계정 연결은 관리자 · 매니저만 할 수 있어요.");
  }

  const state = randomBytes(32).toString("base64url");
  const redirectUri = getRedirectUri(platform);
  console.log(`[oauth connect] platform=${platform} redirect_uri=${redirectUri}`);

  let authUrl: string;
  try {
    authUrl = adapter.buildAuthUrl(state, redirectUri);
  } catch (err) {
    return redirectWithError(
      request,
      err instanceof Error ? err.message : "OAuth URL 생성 실패",
    );
  }

  const response = NextResponse.redirect(authUrl);
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: STATE_TTL_SECONDS,
  });
  return response;
}

function redirectWithError(request: NextRequest, message: string) {
  return NextResponse.redirect(
    new URL(`/accounts?error=${encodeURIComponent(message)}`, request.url),
  );
}

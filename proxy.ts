import type { NextRequest } from "next/server";
import { moaHostRoute } from "@/lib/moa/proxy-route";
import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  // 모아링크 공개 주소(moa.cuma.co.kr) — 세션 갱신 없이 공개 페이지로 넘긴다
  const moa = moaHostRoute(request);
  if (moa) return moa;
  return await updateSession(request);
}

export const config = {
  matcher: [
    // 다음 경로는 proxy를 우회 → Vercel CDN이 정적 파일을 직접 응답:
    //   - _next/static, _next/image, favicon.ico
    //   - 이미지 확장자(.svg/.png/.jpg/.jpeg/.gif/.webp)
    //   - robots.txt — 검색엔진/소셜 crawler가 자주 fetch, Supabase 호출 불필요
    //   - .html, .txt 확장자 정적 파일 (public/*.html 포함) — 도메인 verify 파일이 Supabase
    //     세션 흐름을 거치며 발생할 수 있는 사이드이펙트 회피
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|.*\\.(?:html|txt|svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};

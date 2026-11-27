import { NextResponse, type NextRequest } from "next/server";

// moa.cuma.co.kr 주소 → 앱 경로 (proxy.ts가 맨 앞에서 부른다). 모아링크 공개 페이지는 로그인 세션이 필요 없어
// Supabase 세션 갱신도 건너뛴다.
//   /<주소>        → /m/<주소>          공개 페이지
//   /r/<블록>      → /api/moa/r/<블록>  클릭 기록 후 이동
//   /api · /_next  → 그대로(기록 받기 · 정적 파일)
// 모아링크 주소가 아니면 null — proxy가 원래 처리를 계속한다.

const MOA_HOSTS = new Set(["moa.cuma.co.kr"]);

export function moaHostRoute(request: NextRequest): NextResponse | null {
  const host = (request.headers.get("host") ?? "").toLowerCase().split(":")[0];
  if (!MOA_HOSTS.has(host)) return null;

  const path = request.nextUrl.pathname;
  if (path.startsWith("/api/") || path.startsWith("/_next/")) return NextResponse.next();

  const click = /^\/r\/([0-9a-fA-F-]{36})$/.exec(path);
  if (click) {
    const url = request.nextUrl.clone();
    url.pathname = `/api/moa/r/${click[1]}`;
    return NextResponse.rewrite(url);
  }

  const slug = /^\/([^/]+)\/?$/.exec(path);
  const url = request.nextUrl.clone();
  // 첫 화면(/)과 그 밖의 경로는 없는 페이지로
  url.pathname = slug ? `/m/${decodeURIComponent(slug[1]).toLowerCase()}` : "/m/_";
  return NextResponse.rewrite(url);
}

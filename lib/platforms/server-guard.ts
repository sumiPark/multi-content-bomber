// lib/platforms/* 는 OAuth 시크릿 + 토큰을 다루므로 서버 컨텍스트에서만 import되어야
// 한다. 원래 `import "server-only"`로 차단했으나 worker(tsx + plain Node)는 Next.js의
// server-only alias 우회가 없어 import 시 throw됐다. 런타임 `typeof window` 체크로
// 대체 — Next.js Server Action / API Route / 워커 모두 통과, 브라우저 번들에 실수로
// 끌려가면 모듈 로드 시 즉시 throw.
if (typeof window !== "undefined") {
  throw new Error(
    "lib/platforms/*는 서버 컨텍스트(Server Action / API route / worker)에서만 import해야 합니다.",
  );
}

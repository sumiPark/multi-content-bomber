import OpenAI from "openai";

// server-only 대신 런타임 체크 — 발행 워커(tsx + plain Node)에서도 시리즈 답글 문구를 새로
// 쓰는데, server-only는 워커에서 import하면 throw한다(lib/platforms/server-guard.ts와 같은 이유).
if (typeof window !== "undefined") {
  throw new Error("lib/openai는 서버(Server Action / API route / 워커)에서만 import해야 합니다.");
}

let cached: OpenAI | null = null;

/**
 * Lazy-instantiated OpenAI client.
 *
 * 모듈 로드 시점이 아니라 실제 호출 시점에 환경변수를 읽음. 이래야
 * `captionsSchema`만 import하는 페이지(예: /contents, /uploads)가 빌드
 * 단계에서 OpenAI 자격증명을 요구하지 않음.
 */
export function getOpenAI(): OpenAI {
  if (cached) return cached;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY 환경변수가 설정되지 않았습니다.");
  }
  cached = new OpenAI({ apiKey });
  return cached;
}

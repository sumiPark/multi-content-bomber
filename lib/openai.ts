import "server-only";
import OpenAI from "openai";

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

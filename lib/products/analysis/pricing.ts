// 상세페이지 분석 비용 추정 — 화면 표시용 대략값.
// OpenAI 표준 단가(USD / 100만 토큰, 2026-11-03 확인). 캐시 할인 · 장문 할증은 반영하지 않는다.
const PRICES: Record<string, { input: number; output: number }> = {
  "gpt-6.1-terra": { input: 1, output: 5 },
  "gpt-5.6-terra": { input: 2, output: 12 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
};

// 원화 환산 — 대략값(표시용).
const KRW_PER_USD = 1450;

/** 단가를 모르는 모델이면 null. */
export function estimateKrw(model: string | null | undefined, input: number, output: number): number | null {
  const p = model ? PRICES[model] : undefined;
  if (!p) return null;
  const usd = (input * p.input + output * p.output) / 1_000_000;
  return Math.round(usd * KRW_PER_USD);
}

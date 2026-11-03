import { kstToIso } from "./time";

/**
 * AI 자동 업로드 상품 확인 마감 — 올리는 날(slotDate) deadline(HH:MM, KST).
 * 2026-11-03부터 "전날 18시" → "올리는 날 07시"(0029). 08 · 21시 칸 모두 그날 07시에 닫힌다.
 */
export function confirmDeadlineIso(slotDate: string, deadline: string): string {
  return kstToIso(slotDate, deadline);
}

export function isPastDeadline(slotDate: string, deadline: string, now = Date.now()): boolean {
  return now >= Date.parse(confirmDeadlineIso(slotDate, deadline));
}

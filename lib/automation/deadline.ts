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

/** 칸의 올릴 시각(KST) - marginMs가 지났는지 — 직접 촬영 칸은 그 전까지 고르고 찍고 확인할 수 있다. */
export function isPastSlot(slotDate: string, slotTime: string, marginMs = 0, now = Date.now()): boolean {
  return now >= Date.parse(kstToIso(slotDate, slotTime)) - marginMs;
}

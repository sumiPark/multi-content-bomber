import { addDays, kstToIso } from "./time";

/** B 상품 컨펌 마감 — 발행 전날 deadline(HH:MM, KST). */
export function confirmDeadlineIso(slotDate: string, deadline: string): string {
  return kstToIso(addDays(slotDate, -1), deadline);
}

export function isPastDeadline(slotDate: string, deadline: string, now = Date.now()): boolean {
  return now >= Date.parse(confirmDeadlineIso(slotDate, deadline));
}

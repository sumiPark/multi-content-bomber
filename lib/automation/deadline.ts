import { kstToIso } from "./time";

/**
 * AI 자동 업로드 상품 확인 (2026-11-04 사용자 결정):
 *   · 올릴 시각 2시간 전에 아직 확인 안 한 칸을 알린다 (모든 계정 같게 — 영상 생성 시간을 잰 뒤 여기만 고치면 된다)
 *   · 올릴 시각까지 확인이 없으면 그 칸은 건너뛴다(사람이 안 본 상품은 올리지 않는다)
 *   · 확인한 칸은 영상 생성이 늦어져 시각이 지나도 건너뛰지 않고 끝나는 즉시 올린다
 *     (예약 시각이 지난 publish_jobs는 워커가 바로 집어 가므로 영상 생성이 예약만 넣으면 된다)
 */
export const CONFIRM_NOTICE_HOURS = 2;

/** 지금 확인 알림을 보낼 칸인지 — 올릴 시각 2시간 전부터 올릴 시각 전까지. */
export function isConfirmDue(slotDate: string, slotTime: string, now = Date.now()): boolean {
  const at = Date.parse(kstToIso(slotDate, slotTime));
  return now < at && now >= at - CONFIRM_NOTICE_HOURS * 3_600_000;
}

/** 칸의 올릴 시각(KST) - marginMs가 지났는지 — 직접 촬영 칸은 그 전까지 고르고 찍고 확인할 수 있다. */
export function isPastSlot(slotDate: string, slotTime: string, marginMs = 0, now = Date.now()): boolean {
  return now >= Date.parse(kstToIso(slotDate, slotTime)) - marginMs;
}

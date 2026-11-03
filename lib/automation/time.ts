// KST 날짜 계산 — 편성 칸은 모두 한국 시간 기준이다.
const KST_OFFSET_MS = 9 * 3600_000;
const DAY_MS = 24 * 3600_000;

/** KST 기준 오늘 + offsetDays 날짜 (YYYY-MM-DD). */
export function kstDate(offsetDays = 0, now = Date.now()): string {
  return new Date(now + KST_OFFSET_MS + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

/** KST 날짜 + HH:MM → UTC ISO 시각. */
export function kstToIso(date: string, time: string): string {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

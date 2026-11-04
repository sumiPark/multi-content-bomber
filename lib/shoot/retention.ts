// 직접 촬영 파일 보관 기간(2026-11-04 사용자 결정) — 정리 워커와 "곧 지워져요" 안내가 같이 쓴다.
//   "올렸어요"를 누른 건 올린 뒤 14일, 안 누른 건 편집이 끝난 날(편집 전이면 마지막 변경)부터 30일.

const DAY_MS = 86_400_000;

export const POSTED_KEEP_DAYS = 14;
export const UNPOSTED_KEEP_DAYS = 30;
// 이 기간 안으로 들어오면 화면에 삭제 예정을 보여 준다
export const DELETE_NOTICE_DAYS = 3;

export function shootFilesDeleteAt(input: { postedAt: string | null; editedAt?: string | null; updatedAt: string }): number {
  if (input.postedAt) return Date.parse(input.postedAt) + POSTED_KEEP_DAYS * DAY_MS;
  return Date.parse(input.editedAt ?? input.updatedAt) + UNPOSTED_KEEP_DAYS * DAY_MS;
}

/** 삭제까지 남은 날(올림) — 안내 기간 밖이면 null. */
export function deleteNoticeDays(deleteAtMs: number, now: number): number | null {
  const left = deleteAtMs - now;
  if (left > DELETE_NOTICE_DAYS * DAY_MS) return null;
  return Math.max(0, Math.ceil(left / DAY_MS));
}

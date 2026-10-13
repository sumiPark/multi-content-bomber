// 다음 화 알림 화면들이 같이 쓰는 상태 표기.

export type TaskStatus =
  | "COLLECTING"
  | "AWAITING_APPROVAL"
  | "SENDING"
  | "DONE"
  | "FAILED"
  | "CANCELLED";

export const TASK_STATUS: Record<TaskStatus, { label: string; className: string }> = {
  COLLECTING: {
    label: "대상 모으는 중",
    className: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  AWAITING_APPROVAL: {
    label: "확인 대기",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  SENDING: {
    label: "보내는 중",
    className: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  },
  DONE: {
    label: "완료",
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  FAILED: {
    label: "실패",
    className: "border-destructive/30 bg-destructive/10 text-destructive",
  },
  CANCELLED: {
    label: "중단됨",
    className: "border-border bg-muted text-muted-foreground",
  },
};

export type ReplyStatus = "PENDING" | "SENT" | "SKIPPED" | "EXCLUDED" | "FAILED";

export const REPLY_STATUS: Record<ReplyStatus, { label: string; className: string }> = {
  PENDING: { label: "보낼 예정", className: "text-muted-foreground" },
  SENT: { label: "보냄", className: "text-emerald-700 dark:text-emerald-300" },
  SKIPPED: { label: "건너뜀", className: "text-muted-foreground" },
  EXCLUDED: { label: "제외", className: "text-muted-foreground" },
  FAILED: { label: "실패", className: "text-destructive" },
};

export function mediaTypeLabel(mediaType: string | null): string {
  if (mediaType === "VIDEO") return "릴스";
  if (mediaType === "CAROUSEL_ALBUM") return "캐러셀";
  if (mediaType === "IMAGE") return "사진";
  return "게시물";
}

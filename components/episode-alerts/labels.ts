// 시리즈 댓글 자동화 화면들이 같이 쓰는 상태 표기.

export type TaskStatus =
  | "COLLECTING"
  | "SENDING"
  | "DONE"
  | "FAILED"
  | "CANCELLED";

export const TASK_STATUS: Record<TaskStatus, { label: string; className: string }> = {
  COLLECTING: {
    label: "대상 모으는 중",
    className: "border-border bg-surface-2 text-ink-2",
  },
  SENDING: {
    label: "보내는 중",
    className: "border-primary/30 bg-brand-soft text-primary",
  },
  DONE: {
    label: "완료",
    className: "border-ok/30 bg-ok-soft text-ok",
  },
  FAILED: {
    label: "실패",
    className: "border-destructive/30 bg-destructive/10 text-destructive",
  },
  CANCELLED: {
    label: "꺼짐",
    className: "border-border bg-muted text-muted-foreground",
  },
};

export type ReplyStatus = "PENDING" | "SENT" | "SKIPPED" | "EXCLUDED" | "FAILED";

export const REPLY_STATUS: Record<ReplyStatus, { label: string; className: string }> = {
  PENDING: { label: "보낼 예정", className: "text-muted-foreground" },
  SENT: { label: "보냄", className: "text-ok" },
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

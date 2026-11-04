import { isPastSlot } from "@/lib/automation/deadline";
import { kstDate } from "@/lib/automation/time";

// 편성표 칸 하나의 진행 상태 — 기획안(content_plans) 상태 + 발행(publish_jobs) 결과를 사람이 읽는 말로.
// 편성표(/schedule)와 대시보드(오늘 발행 16칸)가 같이 쓴다.
//   todo  사람 차례(누르면 할 곳으로)   wait  AI · 워커가 하는 중   ok  예약 · 발행 끝
//   risk  멈춤 · 실패 · 오늘 빈 칸       idle  기획 전 · 건너뜀 · 꺼짐 · 지난 날 기록 없음

export type CellTone = "todo" | "wait" | "ok" | "risk" | "idle";
// 사람 할 일 종류 — 대시보드 할 일 칸이 센다
export type CellTask = "confirm" | "plans" | "shoot" | "review";
export interface CellStatus {
  label: string;
  tone: CellTone;
  href: string | null;
  task?: CellTask;
}

export interface CellPlan {
  track: string;
  status: string;
  slot_date: string;
  slot_time: string;
  // publish_jobs.status (예약된 칸만)
  jobStatus: string | null;
  // shoot_requests.status (직접 촬영 칸만) — 편집 실패를 가려낸다
  requestStatus?: string | null;
}

export function cellStatus(
  plan: CellPlan | null,
  slot: { date: string; time: string; track: string; active: boolean },
  now = Date.now(),
): CellStatus {
  const past = isPastSlot(slot.date, slot.time, 0, now);
  if (!plan) {
    if (!slot.active) return { label: "꺼짐", tone: "idle", href: null };
    // 기획은 전날 만들어진다 — 오늘 칸인데 기획이 없으면 그대로 비게 되니 경고, 지난 날은 기록만
    const today = kstDate(0, now);
    if (slot.date < today || (slot.date === today && past)) return { label: "없음", tone: "idle", href: null };
    if (slot.date === today) return { label: "빈 칸", tone: "risk", href: null };
    return { label: "기획 전", tone: "idle", href: null };
  }

  const confirm = `/auto/confirm?date=${plan.slot_date}`;
  if (plan.status === "SCHEDULED" || plan.status === "PUBLISHED") {
    switch (plan.jobStatus) {
      case "SUCCESS":
        return { label: "발행됨", tone: "ok", href: "/postings" };
      case "FAILED":
        return { label: "발행 실패", tone: "risk", href: "/postings" };
      case "CANCELLED":
        return { label: "발행 취소", tone: "idle", href: "/postings" };
      case "PROCESSING":
      case "RETRYING":
        return { label: "올리는 중", tone: "wait", href: "/postings" };
      default:
        return { label: past ? "발행 대기" : "예약됨", tone: "ok", href: "/postings" };
    }
  }
  if (plan.status === "SKIPPED") return { label: "건너뜀", tone: "idle", href: null };
  // 예약까지 갔다가 발행 직전 확인(판매 상태 · 가격)에 걸린 칸 — 배포 관리에서 다시 시도한다
  if (plan.status === "BLOCKED" && plan.jobStatus) return { label: "발행 전 멈춤", tone: "risk", href: "/postings?status=failed" };
  if (plan.status === "FAILED") return { label: "오류", tone: "risk", href: plan.track === "B" ? confirm : "/shoot/review" };

  if (plan.track === "B") {
    switch (plan.status) {
      case "PROPOSED":
        return { label: "상품 확인", tone: "todo", href: confirm, task: "confirm" };
      case "CONFIRMED":
        return { label: "대본 쓰는 중", tone: "wait", href: confirm };
      case "SCRIPTED":
        // 영상 만들기가 아직 없어 대본까지가 끝 — 시각이 지나도 올라가지 않는다
        return past
          ? { label: "안 올라감 · 영상 준비 중", tone: "idle", href: confirm }
          : { label: "대본 완료 · 영상 준비 중", tone: "wait", href: confirm };
      case "RENDERED":
        return { label: "점검 중", tone: "wait", href: confirm };
      case "BLOCKED":
        return { label: "멈춤", tone: "risk", href: confirm };
    }
  } else {
    switch (plan.status) {
      case "PROPOSED":
        return { label: "기획 고르기", tone: "todo", href: "/shoot/plans", task: "plans" };
      case "CONFIRMED":
        return { label: "컷 리스트 쓰는 중", tone: "wait", href: "/shoot/plans" };
      case "SCRIPTED":
        return { label: "촬영", tone: "todo", href: "/shoot/uploads", task: "shoot" };
      case "SHOT":
        return plan.requestStatus === "FAILED"
          ? { label: "편집 실패", tone: "risk", href: "/shoot/review" }
          : { label: "편집 중", tone: "wait", href: "/shoot/review" };
      case "RENDERED":
        return { label: "완성본 확인", tone: "todo", href: "/shoot/review", task: "review" };
      case "BLOCKED":
        return { label: "멈춤", tone: "risk", href: "/shoot/plans" };
    }
  }
  return { label: plan.status, tone: "idle", href: null };
}

export const TONE_LABEL: Record<CellTone, string> = {
  todo: "내 차례",
  wait: "진행 중",
  ok: "예약 · 발행",
  risk: "멈춤 · 빈 칸",
  idle: "기획 전 · 건너뜀 · 없음",
};

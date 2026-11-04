import { isPastSlot } from "@/lib/automation/deadline";
import { kstDate } from "@/lib/automation/time";

// 자동 업로드 일정 칸 하나의 진행 상태 — 기획안(content_plans) 상태 + 발행(publish_jobs) 결과를 사람이 읽는 말로.
// 자동 업로드 일정(/schedule)과 대시보드(경고 · 업로드 예정)가 같이 쓴다. 직접 촬영은 날짜 · 시각이 없어 칸이 아니다(0042).
//   todo  사람 차례(누르면 할 곳으로)   wait  AI · 워커가 하는 중   ok  예약 · 발행 끝
//   risk  멈춤 · 실패 · 오늘 빈 칸       idle  기획 전 · 건너뜀 · 꺼짐 · 지난 날 기록 없음

export type CellTone = "todo" | "wait" | "ok" | "risk" | "idle";
export type CellTask = "confirm";
export interface CellStatus {
  label: string;
  tone: CellTone;
  href: string | null;
  task?: CellTask;
}

export interface CellPlan {
  status: string;
  // publish_jobs.status (예약된 칸만)
  jobStatus: string | null;
}

export function cellStatus(
  plan: CellPlan | null,
  slot: { date: string; time: string; active: boolean; accountOff?: boolean },
  now = Date.now(),
): CellStatus {
  const past = isPastSlot(slot.date, slot.time, 0, now);
  if (!plan) {
    if (!slot.active) return { label: "꺼짐", tone: "idle", href: null };
    // 토큰이 만료된 계정은 기획하지 않는다 — 이유 없는 "빈 칸" 대신 할 일을 알려 준다
    if (slot.accountOff && !past && slot.date >= kstDate(0, now)) return { label: "계정 다시 연결", tone: "risk", href: "/accounts" };
    // 기획은 전날 만들어진다 — 오늘 칸인데 기획이 없으면 그대로 비게 되니 경고, 지난 날은 기록만
    const today = kstDate(0, now);
    if (slot.date < today || (slot.date === today && past)) return { label: "없음", tone: "idle", href: null };
    if (slot.date === today) return { label: "빈 칸", tone: "risk", href: null };
    return { label: "기획 전", tone: "idle", href: null };
  }

  const confirm = `/auto/confirm?date=${slot.date}`;
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
  if (plan.status === "FAILED") return { label: "오류", tone: "risk", href: confirm };

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
  return { label: plan.status, tone: "idle", href: null };
}

export const TONE_LABEL: Record<CellTone, string> = {
  todo: "내 차례",
  wait: "진행 중",
  ok: "예약 · 발행",
  risk: "멈춤 · 빈 칸",
  idle: "기획 전 · 건너뜀 · 없음",
};

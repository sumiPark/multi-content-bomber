import { permanentRedirect } from "next/navigation";

// 예전 "예약 규칙(준비 중)" 주소 — 편성표가 그 자리를 대신한다(5단계).
export default function ScheduleRulesPage() {
  permanentRedirect("/schedule");
}

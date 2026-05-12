import { CalendarClock } from "lucide-react";
import { ComingSoon } from "@/components/layout/coming-soon";

export const metadata = {
  title: "예약 규칙 (출시 예정) | MCB",
};

export default function ScheduleRulesComingSoonPage() {
  return (
    <ComingSoon
      icon={CalendarClock}
      title="예약 규칙"
      description="반복 예약과 자동 배포 규칙을 만들어 매번 마법사를 거치지 않도록 준비 중이에요."
      highlights={[
        "요일/시간대별 반복 배포 (예: 매주 화·금 19시)",
        "콘텐츠 태그 → 계정 그룹 자동 매칭 규칙",
        "Smart Scheduler 추천 시간대를 규칙 템플릿으로 저장",
      ]}
    />
  );
}

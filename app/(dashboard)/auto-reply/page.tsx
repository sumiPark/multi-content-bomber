import { MessageSquareReply } from "lucide-react";
import { ComingSoon } from "@/components/layout/coming-soon";

export const metadata = {
  title: "DM 자동 응답 (출시 예정) | MCB",
};

export default function AutoReplyComingSoonPage() {
  return (
    <ComingSoon
      icon={MessageSquareReply}
      title="DM 자동 응답"
      description="AI가 인스타그램·틱톡·유튜브 DM을 24시간 자동으로 응대하는 기능을 준비하고 있어요."
      highlights={[
        "캡션·브랜드 톤을 학습한 GPT-4o가 1차 응답을 작성",
        "키워드별 분기 + 사람 핸드오프 큐 (담당자 알림)",
        "응대 로그·전환 지표는 분석 페이지에서 함께 조회",
      ]}
    />
  );
}

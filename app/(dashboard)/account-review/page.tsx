import { permanentRedirect } from "next/navigation";

// 계정 점검은 분석 화면의 "프로필 점수" 탭으로 합쳤다(2026-11-04 사용자 결정). 예전 주소는 그리로 보낸다.
export default function AccountReviewPage() {
  permanentRedirect("/analytics?tab=profile");
}

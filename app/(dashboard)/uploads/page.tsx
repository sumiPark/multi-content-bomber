import { redirect } from "next/navigation";

// 업로드 이력 메뉴는 사이드바 §8.6 변경으로 제거되었다.
// 기존 북마크/외부 링크 호환을 위해 배포 관리로 영구 리다이렉트한다.
export default function UploadsRedirectPage() {
  redirect("/postings");
}

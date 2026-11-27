import { redirect } from "next/navigation";
import { AUTO_CONTENT_PAUSED } from "@/lib/paused";

// AI 자동 콘텐츠(자동 업로드 일정) 일시 중지(lib/paused.ts) — 메뉴를 숨기고, 주소로 들어와도 대시보드로 보낸다. 데이터는 그대로 남는다.
export default function PausedLayout({ children }: { children: React.ReactNode }) {
  if (AUTO_CONTENT_PAUSED) redirect("/");
  return <>{children}</>;
}

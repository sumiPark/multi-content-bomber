import { isPaused, type PausableArea } from "@/lib/paused";

// 일시 중지(lib/paused.ts) 중이면 워커가 아무것도 읽거나 부르지 않고 끝난다 — OpenAI · 음성 · 렌더 비용이 들지 않게.
// 워크플로를 꺼 두었지만, 누가 다시 켜거나 손으로 돌려도 비용이 나가지 않게 한 번 더 막는다.
export function stopIfPaused(area: PausableArea, worker: string): boolean {
  if (!isPaused(area)) return false;
  const name = area === "auto" ? "AI 자동 콘텐츠" : "직접 촬영 콘텐츠";
  console.log(`[${worker}] ${name}가 일시 중지 상태라 실행하지 않아요 (lib/paused.ts).`);
  return true;
}

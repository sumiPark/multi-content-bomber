// 일시 중지 스위치(사용자 결정, 2026-11-27) — AI 자동 콘텐츠 · 직접 촬영 콘텐츠를 멈춘다.
// 상품 분석(상품 수집 · 상세페이지 분석, products.yml)은 멈추지 않는다.
//
// 멈춘 동안:
//   · 화면: 사이드바 메뉴를 숨기고, 주소로 들어와도 대시보드로 보낸다(각 폴더의 layout.tsx).
//     대시보드의 자동 칸 경고 · 업로드 예정의 자동 칸 · 음성 종료 예고 · 사이드바 확인 뱃지도 숨긴다.
//   · 실행: 워크플로를 깨우는 dispatch를 보내지 않고(lib/github-dispatch.ts), 워커는 시작하자마자 끝난다(worker/pause-check.ts).
//     GitHub 워크플로 자체도 꺼 두었다(gh workflow disable) — 예약 실행(schedule)까지 멈추게.
//   · 데이터: 지우지 않는다. 칸 · 기획 · 설정 · 완성본은 그대로 남는다.
//
// 다시 쓰려면:
//   1. 아래 값을 false로 바꿔 배포한다.
//   2. 워크플로를 다시 켠다.
//      AI 자동 콘텐츠: gh workflow enable b-plan · auto-video · knowledge · lemo-video
//      직접 촬영 콘텐츠: gh workflow enable a-plan · shoot-edit
//   3. 멈춘 사이에 지난 "확인 전" 칸은 b-plan의 07:10 정리가 건너뜀으로 바꾼다.

export const AUTO_CONTENT_PAUSED = true;
export const SHOOT_PAUSED = true;

export type PausableArea = "auto" | "shoot";

export function isPaused(area: PausableArea): boolean {
  return area === "auto" ? AUTO_CONTENT_PAUSED : SHOOT_PAUSED;
}

// 멈춘 동안 숨기는 화면 — 사이드바가 이 주소로 시작하는 메뉴를 뺀다.
// 에이전트 · 학습은 두 기능의 에이전트(상품 선정 · 대본 · 편집 · 검수 …) 설정만 있어 둘 다 멈추면 숨긴다.
export function pausedPaths(): string[] {
  const paths: string[] = [];
  if (AUTO_CONTENT_PAUSED) paths.push("/schedule", "/auto");
  if (SHOOT_PAUSED) paths.push("/shoot");
  if (AUTO_CONTENT_PAUSED && SHOOT_PAUSED) paths.push("/agents");
  return paths;
}

// 멈춘 동안 보내지 않는 repository_dispatch event_type (워크플로 on.repository_dispatch.types와 같다)
const PAUSED_EVENTS: Record<PausableArea, readonly string[]> = {
  // b-plan(날짜별 상품 제안) · auto-video(장면표 · 영상) · knowledge(상식 · 차이 초안)
  auto: ["plan-b", "auto-video", "draft-knowledge"],
  // a-plan(촬영 기획 · 컷 리스트) · shoot-edit(편집 · 아카이브)
  shoot: ["plan-a", "a-shotlist", "shoot-edit"],
};

export function isPausedEvent(eventType: string): boolean {
  return (Object.keys(PAUSED_EVENTS) as PausableArea[]).some((area) => isPaused(area) && PAUSED_EVENTS[area].includes(eventType));
}

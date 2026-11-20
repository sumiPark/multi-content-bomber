// 스타일 쇼츠 만들기 · 버전 · 주석 — 앱 · 워커가 함께 쓰는 형식(Node 전용 모듈을 불러오지 않는다).

// 촬영본 보관 기간(사용자 결정 2026-11-19). 완성본은 모든 버전을 보관한다
export const CLIP_KEEP_DAYS = 30;
export const MAX_CLIPS = 20;
// 촬영본 하나 한도 — media 버킷 한도(0014)와 같게
export const MAX_CLIP_BYTES = 1024 * 1024 * 1024;
export const SCRIPT_MAX = 3000;
// 편집용 파일 묶음(zip) 버킷(0061). 비공개라 링크는 서버가 service_role로 만든다
export const PARTS_BUCKET = "edit-parts";
export const CONCEPT_MAX = 1000;

export interface JobClip {
  path: string;
  name: string;
  size: number;
}

/** 버전을 만든 요청. v1은 null. remake = 같은 입력으로 처음부터 다시, revise = 주석 수정(3단계) */
export type VersionRequest =
  | { kind: "remake"; from: number }
  | { kind: "revise"; from: number; notes: { no: number; at: number | null; x: number | null; y: number | null; body: string }[] };

/** 주석 시각을 장면 · 자막에 맞추는 데 쓰는 시각표 요약 */
export interface VersionTimeline {
  duration: number;
  // rate: 원본을 돌린 배수(없으면 1). 완성본 시각을 원본 시각으로 바꿀 때 쓴다
  cuts: { start: number; end: number; clip: number; in: number; rate?: number }[];
  captions: { start: number; end: number; text: string }[];
  graphics: { start: number; end: number; type: string; text: string }[];
  sfx: { t: number; name: string }[];
}

export const VERSION_STATUS: Record<string, { label: string; variant: "secondary" | "default" | "ok" | "destructive" | "warn" }> = {
  PENDING: { label: "편집 대기", variant: "secondary" },
  EDITING: { label: "편집 중", variant: "default" },
  DONE: { label: "완성", variant: "ok" },
  FAILED: { label: "실패", variant: "destructive" },
};

export const VOICE_MODE_LABEL = { AI: "AI 음성", LIVE: "영상 내 음성" } as const;

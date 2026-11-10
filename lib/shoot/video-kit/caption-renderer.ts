/**
 * 자막 모션 스킬을 쓸 수 있으면 모션 자막, 아니면 기본 자막으로 만든다.
 * AI 자동 영상도 실패로 멈추지 않고 기본 자막(읽기 보정)으로 만들고 경고를 남긴다(사용자 결정 2026-11-09).
 * 경고가 있으면 사람 확인 없는 자동 발행은 멈춘다.
 */
export function selectCaptionRenderer(skillAvailable: boolean): "motion" | "basic" {
  return skillAvailable ? "motion" : "basic";
}

export const CAPTION_FALLBACK_WARNING = "자막 모션 스킬을 쓰지 못해 기본 자막으로 만들었어요.";

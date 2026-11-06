/** 자동 영상의 가독성 보정이 구매한 자막 모션을 우회해서는 안 된다. */
export function selectCaptionRenderer(source: "auto" | "shoot", skillAvailable: boolean): "motion" | "basic" {
  if (skillAvailable) return "motion";
  if (source === "auto") throw new Error("자막 모션 스킬을 불러오지 못했어요. 기본 자막으로 바꾸지 않고 생성을 중단해요.");
  return "basic";
}

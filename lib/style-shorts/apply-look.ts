import type { Look } from "@/lib/shoot/video-kit/caption-style";
import { SIZE_PX, type CaptionLook } from "@/lib/style-shorts/caption-look";

/**
 * 편집 계획의 글자 디자인(look)에 레퍼런스 자막 모양을 덮는다(스타일 쇼츠만).
 * 상자가 있으면 box, 테두리가 있으면 stroke, 그림자만 있으면 shade. 강조는 강조색이 글자색과 다를 때만 색으로 표시한다.
 */
export function applyCaptionLook(look: Look, ref: CaptionLook): Look {
  const treatment: Look["treatment"] = ref.box_color ? "box" : ref.outline_color ? "stroke" : ref.shadow ? "shade" : look.treatment;
  return {
    ...look,
    treatment,
    text_color: ref.text_color,
    accent_color: ref.accent_color,
    box_color: ref.box_color || look.box_color,
    size: SIZE_PX[ref.size] ?? look.size,
    emphasis: ref.accent_color.toUpperCase() !== ref.text_color.toUpperCase() ? "color" : look.emphasis,
  };
}

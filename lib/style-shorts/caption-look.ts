import { z } from "zod";

// 스타일 쇼츠 — 레퍼런스 자막 모양(사용자 결정 2026-11-19: 글꼴 · 자막 스타일을 최대한 레퍼런스대로).
// 레퍼런스 분석이 자막 프레임에서 읽고, 카드에 공통 모양으로 저장하고(사람이 고칠 수 있다), 편집이 이 값을 따른다.
// 똑같은 글꼴 파일은 쓸 수 없어 자막 모션 스킬 글꼴 중 가장 비슷한 계열 · 굵기로 고른다. 스타일 쇼츠만 고딕도 고를 수 있다.
// 앱 · 워커가 함께 쓴다(Node 전용 모듈을 불러오지 않는다).

export const FONT_KINDS = ["굵은 고딕", "보통 고딕", "둥근 고딕", "명조", "손글씨", "장식 디스플레이", "알 수 없음"] as const;
export const FONT_WEIGHTS = ["아주 굵게", "굵게", "보통"] as const;
export const CAPTION_POSITIONS = ["위", "가운데", "아래", "알 수 없음"] as const;
export const CAPTION_SIZES = ["작게", "보통", "크게", "아주 크게"] as const;

const HEX = /^#[0-9A-Fa-f]{6}$/;

export const captionLookSchema = z.object({
  font: z.enum(FONT_KINDS).describe("말 자막 글꼴 계열. 자막이 없으면 알 수 없음"),
  weight: z.enum(FONT_WEIGHTS).describe("글자 굵기"),
  text_color: z.string().describe("기본 글자색 #RRGGBB"),
  accent_color: z.string().describe("강조 낱말 색 #RRGGBB. 강조가 없으면 글자색과 같게"),
  outline_color: z.string().describe("글자 테두리 색 #RRGGBB. 테두리가 없으면 빈 문자열"),
  box_color: z.string().describe("글자 뒤 상자 · 띠 색 #RRGGBB. 상자가 없으면 빈 문자열"),
  shadow: z.boolean().describe("글자 그림자가 있는지"),
  position: z.enum(CAPTION_POSITIONS).describe("말 자막이 주로 놓인 자리"),
  size: z.enum(CAPTION_SIZES).describe("화면 대비 글자 크기"),
  per_line: z.number().int().describe("한 줄에 보이는 글자 수 어림. 모르면 0"),
  motion: z.string().describe("자막이 나타나는 움직임 짧게(예: 낱말씩 튀어나옴, 한 줄씩 그냥 바뀜). 30자 안"),
});
export type CaptionLook = z.infer<typeof captionLookSchema>;

/** 화면에서 고친 값 검사 — 색은 #RRGGBB 또는 빈 문자열(테두리 · 상자 없음). */
export const captionLookEditSchema = captionLookSchema.extend({
  text_color: z.string().regex(HEX),
  accent_color: z.string().regex(HEX),
  outline_color: z.string().regex(HEX).or(z.literal("")),
  box_color: z.string().regex(HEX).or(z.literal("")),
  per_line: z.number().int().min(0).max(40),
  motion: z.string().trim().max(60),
});

export function normalHex(s: string, fallback: string): string {
  return HEX.test(s.trim()) ? s.trim().toUpperCase() : fallback;
}

/** 편집 에이전트 · 자막 디자인 AI에 넘기는 글. */
export function captionLookText(c: CaptionLook): string {
  return [
    `레퍼런스 자막 모양(꼭 따른다): 글꼴 ${c.font} · ${c.weight}, 글자색 ${c.text_color}, 강조색 ${c.accent_color}`,
    c.outline_color ? `테두리 ${c.outline_color}` : "테두리 없음",
    c.box_color ? `글자 뒤 상자 ${c.box_color}` : "상자 없음",
    c.shadow ? "그림자 있음" : "그림자 없음",
    `자리 ${c.position}, 크기 ${c.size}${c.per_line ? `, 한 줄 ${c.per_line}자 안팎` : ""}`,
    c.motion ? `움직임: ${c.motion}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** 자막 디자인 AI가 글꼴 · 모양을 고를 때 붙이는 지시. */
export function captionFontDirective(c: CaptionLook): string {
  const kind = c.font === "알 수 없음" ? "" : `글꼴은 목록에서 레퍼런스(${c.font}, ${c.weight})와 가장 비슷한 계열 · 굵기를 key_font와 small_font로 고른다. 레퍼런스가 한 가지 글꼴만 쓰면 두 줄 모두 같은 계열에서 굵기만 다르게 보이는 짝을 고른다.`;
  return [
    captionLookText(c),
    kind,
    "글자색 · 강조색은 코드가 레퍼런스 값으로 고정한다. 레퍼런스에 예능 자막처럼 튀는 장식이 없으면 key_look과 줄 look은 빈 문자열로 둔다.",
    c.motion ? `대표 모션은 레퍼런스 움직임(${c.motion})과 가장 비슷한 것으로 고른다. 레퍼런스가 움직임 없이 바뀌면 부드럽고 단순한 모션을 고른다.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export const SIZE_PX: Record<CaptionLook["size"], number> = { 작게: 54, 보통: 64, 크게: 78, "아주 크게": 92 };

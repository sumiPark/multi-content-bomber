import { z } from "zod";

// 직접 촬영 편집 스타일 — 사람이 글로 쓴 지시를 AI가 옮겨 둔 편집 값(account_concepts.shoot_edit_params, 0038).
// 편집은 FFmpeg라 글을 그대로 읽지 못해서, 실제로 바꿀 수 있는 값만 여기 둔다. 값이 없으면 기본 편집과 똑같다.
// 화면에서도 읽어 "지금 편집에 들어가는 값"을 보여 주므로 서버 전용 코드를 넣지 않는다.

export const editStyleSchema = z.object({
  pace: z.enum(["tight", "normal", "relaxed"]).describe("컷 길이: tight 빠르게 · normal 보통 · relaxed 여유 있게"),
  textPosition: z.enum(["top", "middle"]).describe("화면 문구 위치: top 위쪽 · middle 가운데"),
  textSize: z.enum(["small", "normal", "large"]).describe("화면 문구 크기"),
  textColor: z.enum(["white", "yellow"]).describe("화면 문구 색"),
  textBox: z.boolean().describe("화면 문구 뒤에 어두운 띠를 깔면 true"),
  subtitles: z.boolean().describe("말 자막을 넣으면 true, 빼면 false"),
  color: z.enum(["natural", "bright", "warm", "muted"]).describe("영상 색: natural 원본 · bright 밝고 선명하게 · warm 따뜻하게 · muted 차분하게"),
});
export type EditStyle = z.infer<typeof editStyleSchema>;

export const editStyleResultSchema = z.object({
  style: editStyleSchema,
  unsupported: z.array(z.string()).describe("이 값들로 옮길 수 없어 따르지 못하는 요청 (예: 배경 음악, 전환 효과). 없으면 빈 배열"),
});
export type EditStyleResult = z.infer<typeof editStyleResultSchema>;

export const DEFAULT_EDIT_STYLE: EditStyle = {
  pace: "normal",
  textPosition: "top",
  textSize: "normal",
  textColor: "white",
  textBox: false,
  subtitles: true,
  color: "natural",
};

/** DB 값을 읽는다 — 비었거나 모양이 다르면 기본 편집. */
export function parseEditStyle(raw: unknown): EditStyleResult {
  const r = editStyleResultSchema.safeParse(raw);
  return r.success ? r.data : { style: DEFAULT_EDIT_STYLE, unsupported: [] };
}

// 말하는 컷의 앞뒤 여백(초)과 말 없는 컷의 길이 배율
export const PACE = {
  tight: { lead: 0.1, tail: 0.15, length: 0.85 },
  normal: { lead: 0.25, tail: 0.35, length: 1 },
  relaxed: { lead: 0.4, tail: 0.6, length: 1.15 },
} as const;

/** 기본과 다른 값만 사람이 읽는 말로. 기본 그대로면 빈 배열. */
export function describeEditStyle(s: EditStyle): string[] {
  const out: string[] = [];
  if (s.pace === "tight") out.push("컷 빠르게");
  if (s.pace === "relaxed") out.push("컷 여유 있게");
  if (s.textPosition === "middle") out.push("화면 문구 가운데");
  if (s.textSize === "large") out.push("화면 문구 크게");
  if (s.textSize === "small") out.push("화면 문구 작게");
  if (s.textColor === "yellow") out.push("화면 문구 노란색");
  if (s.textBox) out.push("화면 문구 뒤에 띠");
  if (!s.subtitles) out.push("말 자막 빼기");
  if (s.color === "bright") out.push("색 밝고 선명하게");
  if (s.color === "warm") out.push("색 따뜻하게");
  if (s.color === "muted") out.push("색 차분하게");
  return out;
}

import { z } from "zod";

// 모아링크 페이지 꾸미기 값 (moa_pages.theme).
// 공개 페이지는 MCB 관리 화면 디자인(DESIGN.md)이 아니라 계정마다 고르는 디자인이라 색을 값으로 저장한다.

export const BUTTON_STYLES = ["fill", "soft", "outline"] as const;
export const RADIUS_STYLES = ["square", "round", "pill"] as const;
export const FONT_KEYS = ["pretendard", "gowun-dodum", "nanum-myeongjo", "jua"] as const;

export type ButtonStyle = (typeof BUTTON_STYLES)[number];
export type RadiusStyle = (typeof RADIUS_STYLES)[number];
export type FontKey = (typeof FONT_KEYS)[number];

export const BUTTON_STYLE_LABEL: Record<ButtonStyle, string> = { fill: "채움", soft: "연한 색", outline: "테두리" };
export const RADIUS_LABEL: Record<RadiusStyle, string> = { square: "각지게", round: "둥글게", pill: "알약" };
export const FONT_LABEL: Record<FontKey, string> = {
  pretendard: "프리텐다드",
  "gowun-dodum": "고운돋움",
  "nanum-myeongjo": "나눔명조",
  jua: "주아",
};

// 프리텐다드는 앱이 자체 호스팅한다(app/layout.tsx). 나머지는 공개 페이지에서만 Google Fonts로 받는다.
export const FONT_STACK: Record<FontKey, string> = {
  pretendard: '"Pretendard Variable", Pretendard, "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif',
  "gowun-dodum": '"Gowun Dodum", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif',
  "nanum-myeongjo": '"Nanum Myeongjo", "AppleMyungjo", serif',
  jua: '"Jua", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif',
};
export const FONT_GOOGLE_FAMILY: Partial<Record<FontKey, string>> = {
  "gowun-dodum": "Gowun+Dodum",
  "nanum-myeongjo": "Nanum+Myeongjo:wght@400;700",
  jua: "Jua",
};

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const themeSchema = z.object({
  background: hex.default("#F6F5F2"),
  backgroundImage: z.string().url().max(500).nullable().default(null),
  accent: hex.default("#1F2937"),
  buttonStyle: z.enum(BUTTON_STYLES).default("fill"),
  radius: z.enum(RADIUS_STYLES).default("round"),
  font: z.enum(FONT_KEYS).default("pretendard"),
});
export type MoaTheme = z.infer<typeof themeSchema>;

export const DEFAULT_THEME: MoaTheme = themeSchema.parse({});

export function parseTheme(raw: unknown): MoaTheme {
  const r = themeSchema.safeParse(raw ?? {});
  return r.success ? r.data : DEFAULT_THEME;
}

// 빠르게 고르는 배경 · 대표 색 조합
export const THEME_PRESETS: { name: string; background: string; accent: string }[] = [
  { name: "기본", background: "#F6F5F2", accent: "#1F2937" },
  { name: "흰색", background: "#FFFFFF", accent: "#111827" },
  { name: "오렌지", background: "#FFF4EC", accent: "#F2662B" },
  { name: "하늘", background: "#EEF6FC", accent: "#1C8AD0" },
  { name: "로즈", background: "#FDF0F4", accent: "#D93A72" },
  { name: "숲", background: "#EEF5EF", accent: "#2F7A4B" },
  { name: "밤", background: "#14161B", accent: "#F5F5F5" },
];

function luminance(h: string): number {
  const n = parseInt(h.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** 배경 위 글자색 · 버튼 위 글자색을 배경 밝기로 정한다 */
export function themeColors(t: MoaTheme) {
  const darkBg = luminance(t.background) < 0.35;
  const darkAccent = luminance(t.accent) < 0.45;
  return {
    text: darkBg ? "#F5F5F7" : "#17181C",
    muted: darkBg ? "#A9ABB3" : "#6B6E76",
    card: darkBg ? "#1F2229" : "#FFFFFF",
    line: darkBg ? "#2D3039" : "#E7E5E0",
    onAccent: darkAccent ? "#FFFFFF" : "#111111",
  };
}

export function radiusPx(r: RadiusStyle): { button: string; card: string } {
  if (r === "square") return { button: "6px", card: "8px" };
  if (r === "pill") return { button: "999px", card: "20px" };
  return { button: "14px", card: "16px" };
}

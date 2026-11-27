// 댓글이 반응할 대상인지 — 키워드 · 제외 단어 · 이모지만 있는 댓글. 화면 미리보기와 서버가 같이 쓴다.
// 비교할 때 띄어쓰기 · 이모지 · 문장부호 · 대소문자는 무시한다("단감!!", "단 감", "단감🍊" 모두 '단감').
import type { AutomationConfig } from "./config";

const STRIP = /[\s\p{Extended_Pictographic}\p{Emoji_Modifier}‍️\p{P}\p{S}]/gu;

export function normalizeForMatch(s: string): string {
  return s.normalize("NFC").toLowerCase().replace(STRIP, "");
}

// 글자 · 숫자가 하나도 없는 댓글 (이모지 · 기호만)
export function isEmojiOnly(s: string): boolean {
  return s.trim().length > 0 && !/[\p{L}\p{N}]/u.test(s);
}

export type MatchResult =
  | { matched: true; keyword: string | null }
  | { matched: false; reason: "NO_MATCH" | "EXCLUDED" | "EMOJI_ONLY" | "EMPTY" };

export function matchComment(c: AutomationConfig, text: string): MatchResult {
  const raw = text ?? "";
  if (!raw.trim()) return { matched: false, reason: "EMPTY" };
  const norm = normalizeForMatch(raw);

  // 제외 단어는 두 모드 모두에 적용 (키워드 모드에서도 "광고"가 섞이면 뺀다)
  for (const ex of c.trig.exclude) {
    const n = normalizeForMatch(ex);
    if (n && norm.includes(n)) return { matched: false, reason: "EXCLUDED" };
  }

  if (c.trig.mode === "all") {
    if (c.trig.emojiOnly && isEmojiOnly(raw)) return { matched: false, reason: "EMOJI_ONLY" };
    return { matched: true, keyword: null };
  }

  for (const kw of c.trig.keywords) {
    const n = normalizeForMatch(kw);
    if (!n) continue;
    if (c.trig.match === "exact" ? norm === n : norm.includes(n)) return { matched: true, keyword: kw };
  }
  return { matched: false, reason: "NO_MATCH" };
}

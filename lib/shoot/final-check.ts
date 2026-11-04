import type { ProductKind } from "@/lib/products/shops";
import { checkText, type ContentRule } from "@/lib/rules/check";

// 완성본 확인의 마지막 관문 — 화면(확인 버튼 잠금)과 서버 액션(예약 직전)이 같이 쓴다.
// 코드로 확실히 아는 것만 막는다: 광고 문구 규칙(금지 표현 · 필수 문구), 판매 상태.
// 편집 때 AI 점검(근거 · 지어낸 체험 · 말투 · 훅)은 "확인할 것"으로 보여 주고 사람이 판단한다.

export interface FinalTexts {
  caption: string;
  onScreen: string[];
  subtitles: string[];
}

/** 상품 분석(관계가 객체 · 배열 어느 쪽으로 와도)에서 화장품 기능성 표기를 꺼낸다. */
export function certifiedFunctionsOf(analysis: unknown): string[] {
  const row = (Array.isArray(analysis) ? analysis[0] : analysis) as { summary?: { details?: { certifiedFunctions?: unknown } } } | null | undefined;
  const v = row?.summary?.details?.certifiedFunctions;
  return Array.isArray(v) ? (v as string[]) : [];
}

export function finalBlocking(
  texts: FinalTexts,
  opts: { kind: ProductKind; rules: ContentRule[]; approvedClaims: string[]; stockStatus: string; healthFunctional?: boolean | null; certifiedFunctions?: string[] },
): string[] {
  const out: string[] = [];
  if (opts.stockStatus !== "available") out.push("지금 판매 중이 아닌 상품이에요");
  const all = [...texts.onScreen, ...texts.subtitles, texts.caption].filter(Boolean).join("\n");
  for (const h of checkText(all, opts.kind, opts.rules, opts.approvedClaims, { healthFunctional: opts.healthFunctional, certifiedFunctions: opts.certifiedFunctions })) {
    out.push(
      h.rule.ruleType === "BANNED"
        ? `금지 표현 "${h.matched}"${h.rule.suggestion ? ` → ${h.rule.suggestion}` : ""}`
        : `꼭 넣을 문구 빠짐 "${h.rule.phrase}"`,
    );
  }
  return out;
}

/** 캡션 끝의 해시태그 줄을 떼어 낸다 — 발행 때 hashtags 배열이 본문 뒤에 다시 붙는다(lib/platforms/instagram.ts). */
export function splitHashtags(text: string): { caption: string; hashtags: string[] } {
  const lines = text.replace(/\r/g, "").split("\n");
  const tags: string[] = [];
  while (lines.length) {
    const last = lines[lines.length - 1].trim();
    if (!last) {
      lines.pop();
      continue;
    }
    const tokens = last.split(/\s+/);
    if (!tokens.every((t) => /^#[^#\s]+$/.test(t))) break;
    tags.unshift(...tokens);
    lines.pop();
  }
  return { caption: lines.join("\n").trim(), hashtags: [...new Set(tags)] };
}

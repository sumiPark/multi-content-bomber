import type { ProductKind } from "@/lib/products/shops";

// 표현 규칙 검사 — 점검 에이전트(4)의 "금지 표현 검사 · 심의 문구 대조" 스킬.
// DB를 모르는 순수 함수라 화면(미리 검사)과 워커(B 트랙 발행 전 점검)가 같이 쓴다.
//
// 규칙은 content_rules(0026). 확정된 건기식 심의 문구(product_claim_approvals) 안에 들어 있는
// 표현은 금지 표현 검사에서 뺀다 — 예: 심의 문구 "골다공증 발생 위험 감소에 도움"의 "위험 감소"를
// 다른 규칙이 잡지 않게.

export interface ContentRule {
  id: string;
  scope: "ALL" | Exclude<ProductKind, "OTHER">;
  ruleType: "BANNED" | "REQUIRED";
  phrase: string;
  matchType: "CONTAINS" | "REGEX";
  reason: string | null;
  suggestion: string | null;
}

export interface RuleHit {
  rule: ContentRule;
  // BANNED: 걸린 구절 / REQUIRED: null (빠짐)
  matched: string | null;
}

const squash = (s: string) => s.replace(/\s+/g, "");

function regexOf(rule: ContentRule): RegExp | null {
  try {
    return new RegExp(rule.phrase, "giu");
  } catch {
    return null; // 잘못된 정규식은 화면에서 저장 전에 막지만, 혹시 남아 있으면 건너뛴다
  }
}

export function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
}

/**
 * @param approvedClaims 이 상품의 확정 심의 문구 — 그 안의 표현은 금지 검사에서 뺀다.
 */
export function checkText(
  text: string,
  kind: ProductKind,
  rules: ContentRule[],
  approvedClaims: string[] = [],
): RuleHit[] {
  // 확정 문구 부분을 지운 본문으로 금지 표현을 찾는다.
  let scrubbed = text;
  for (const c of approvedClaims) {
    if (c.trim()) scrubbed = scrubbed.split(c).join(" ");
  }
  const squashed = squash(scrubbed);
  const hits: RuleHit[] = [];

  for (const rule of rules) {
    if (rule.scope !== "ALL" && rule.scope !== kind) continue;
    if (rule.ruleType === "BANNED") {
      if (rule.matchType === "REGEX") {
        const re = regexOf(rule);
        const m = re ? scrubbed.match(re) : null;
        if (m) hits.push({ rule, matched: m[0] });
      } else if (squashed.includes(squash(rule.phrase))) {
        hits.push({ rule, matched: rule.phrase });
      }
    } else {
      // REQUIRED는 원문 전체(확정 문구 포함)에서 찾는다.
      const present =
        rule.matchType === "REGEX"
          ? !!regexOf(rule)?.test(text)
          : squash(text).includes(squash(rule.phrase));
      if (!present) hits.push({ rule, matched: null });
    }
  }
  return hits;
}

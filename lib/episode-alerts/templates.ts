// 시리즈 댓글 자동화 — 답글 문구 템플릿. 브라우저(문구 편집 미리보기)와 워커가 같이 쓴다.
// 서버 전용 import 금지.

export const TEMPLATE_VARIABLES = [
  { key: "username", label: "댓글 단 사람", sample: "minji_daily" },
  { key: "series", label: "시리즈 이름", sample: "노을 아래서" },
  { key: "episode", label: "새 회차 번호", sample: "2" },
] as const;

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number]["key"];
export type TemplateValues = Record<TemplateVariable, string | number>;

// 기본 문구 — 새 시리즈를 만들 때 이 문구로 채워두고, 시리즈 문구가 비어 있을 때도 쓴다.
// 같은 문구 반복은 스팸 제한 위험이 커서 3개를 돌려쓴다. 인스타 댓글 속 링크는 눌리지
// 않아 프로필로 유도한다.
export const DEFAULT_TEMPLATES = [
  "@{username} {episode}화 올라왔어요! 프로필에서 바로 보실 수 있어요",
  "@{username} 기다리셨죠? {series} {episode}화 업로드됐어요",
  "@{username} {episode}화 나왔어요. 프로필 최신 게시물에서 확인해주세요",
];

export const TEMPLATE_MAX_LENGTH = 300;
export const TEMPLATE_MAX_COUNT = 10;
// 이보다 적으면 저장은 되지만 경고한다.
export const TEMPLATE_RECOMMENDED_MIN = 2;

const VARIABLE_PATTERN = /\{([a-zA-Z_]+)\}/g;
const KNOWN = new Set<string>(TEMPLATE_VARIABLES.map((v) => v.key));

export function renderTemplate(template: string, values: TemplateValues): string {
  return template.replace(VARIABLE_PATTERN, (match, key: string) =>
    KNOWN.has(key) ? String(values[key as TemplateVariable]) : match,
  );
}

// 문구 목록의 i번째 답글에 쓸 문구. 순서대로 돌려쓴다.
export function pickTemplate(templates: string[], index: number): string {
  const list = templates.length > 0 ? templates : DEFAULT_TEMPLATES;
  return list[index % list.length];
}

export function effectiveTemplates(templates: string[] | null | undefined): string[] {
  const cleaned = (templates ?? []).map((t) => t.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : DEFAULT_TEMPLATES;
}

// 저장 전 검증. 오류가 있으면 저장을 막고, 경고는 보여주기만 한다.
export function validateTemplates(templates: string[]): {
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const cleaned = templates.map((t) => t.trim()).filter(Boolean);

  if (cleaned.length === 0) errors.push("문구를 1개 이상 입력해주세요.");
  if (cleaned.length > TEMPLATE_MAX_COUNT) {
    errors.push(`문구는 최대 ${TEMPLATE_MAX_COUNT}개까지 등록할 수 있어요.`);
  }

  cleaned.forEach((t, i) => {
    if (t.length > TEMPLATE_MAX_LENGTH) {
      errors.push(`${i + 1}번 문구가 ${TEMPLATE_MAX_LENGTH}자를 넘어요.`);
    }
    for (const m of t.matchAll(VARIABLE_PATTERN)) {
      if (!KNOWN.has(m[1])) {
        errors.push(`${i + 1}번 문구의 {${m[1]}}는 쓸 수 없는 변수예요.`);
      }
    }
  });

  if (cleaned.length > 0 && cleaned.length < TEMPLATE_RECOMMENDED_MIN) {
    warnings.push(
      "문구가 1개뿐이에요. 같은 문구를 반복하면 인스타 스팸 제한에 걸리기 쉬워서 2~3개 이상을 권장해요.",
    );
  }
  if (new Set(cleaned).size < cleaned.length) {
    warnings.push("똑같은 문구가 있어요. 조금씩 다르게 쓰는 게 좋아요.");
  }
  return { errors, warnings };
}

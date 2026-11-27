// 모아링크 주소 (moa.cuma.co.kr/<slug>) — DB check와 같은 규칙: 소문자 · 숫자 · 점 · 밑줄 · 하이픈, 2~40자,
// 처음과 끝은 글자나 숫자.

export const MOA_HOST = "moa.cuma.co.kr";
export const MOA_ORIGIN = `https://${MOA_HOST}`;

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,38}[a-z0-9]$/;

// 경로로 쓰는 이름 · 헷갈리는 이름은 막는다
const RESERVED = new Set([
  "r", "e", "m", "api", "admin", "login", "signup", "moa", "mcb", "www", "static", "assets",
  "_next", "favicon.ico", "robots.txt", "sitemap.xml", "privacy", "terms", "help",
]);

export function normalizeSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 40);
}

/** 쓸 수 없으면 이유, 쓸 수 있으면 null */
export function slugProblem(slug: string): string | null {
  if (slug.length < 2) return "주소는 2자 이상이어야 해요.";
  if (!SLUG_RE.test(slug)) return "주소는 영어 소문자 · 숫자 · 점(.) · 밑줄(_) · 하이픈(-)만 쓸 수 있고, 처음과 끝은 글자나 숫자여야 해요.";
  if (RESERVED.has(slug)) return "이 주소는 시스템이 쓰는 이름이라 쓸 수 없어요.";
  return null;
}

export function publicUrl(slug: string): string {
  return `${MOA_ORIGIN}/${slug}`;
}

/** 공개 도메인을 연결하기 전에도 열어 볼 수 있는 앱 안 주소 */
export function appPreviewPath(slug: string): string {
  return `/m/${slug}`;
}

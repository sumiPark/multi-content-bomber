// 계정 그룹(0009)별 상점 태그 — 오늘과일 그룹 계정은 #오늘과일, 쿠마마켓은 #쿠마마켓, 리유코스메틱은 #리유코스메틱
// (사용자 요청, 2026-11-12). 계정과 상점의 연결은 계정 연동 화면의 그룹이 기준이다.
// "리유코스메틱 (일본)"처럼 이름이 정확히 같지 않은 그룹 · 그룹 없는 계정에는 붙이지 않는다.
// AI가 쓰는 해시태그 3개와 별개로, 발행할 때(worker/processors/publish-processor.ts)와
// 직접 촬영 완성본 받기 캡션에 덧붙인다. 이미 들어 있으면 다시 붙이지 않는다.

const SHOP_TAG_BY_GROUP: Record<string, string> = {
  오늘과일: "#오늘과일",
  쿠마마켓: "#쿠마마켓",
  리유코스메틱: "#리유코스메틱",
};

/** 계정 그룹 이름 → 상점 태그. 해당 없으면 null. */
export function shopTagForGroup(groupName: string | null | undefined): string | null {
  if (!groupName) return null;
  return SHOP_TAG_BY_GROUP[groupName.trim()] ?? null;
}

/** supabase 조인 결과(account_groups가 객체 또는 배열)에서 그룹 이름을 꺼낸다. */
export function groupNameOf(embedded: unknown): string | null {
  const row = (Array.isArray(embedded) ? embedded[0] : embedded) as { name?: unknown } | null | undefined;
  return typeof row?.name === "string" ? row.name : null;
}

function hasTag(text: string, tag: string): boolean {
  const body = tag.replace(/^#/, "");
  return new RegExp(`#${body}(?![^\\s#.,!?)])`).test(text);
}

/** 해시태그 배열 끝에 상점 태그를 더한다. 배열이나 본문에 이미 있으면 그대로. */
export function withShopTag(hashtags: string[], caption: string | null, tag: string | null): string[] {
  if (!tag) return hashtags;
  const normalized = hashtags.map((t) => (t.startsWith("#") ? t : `#${t}`));
  if (normalized.includes(tag) || hasTag(caption ?? "", tag)) return hashtags;
  return [...hashtags, tag];
}

/** 해시태그까지 한 글로 된 캡션에 상점 태그를 더한다 — 끝 줄이 해시태그 줄이면 그 줄 끝에, 아니면 빈 줄 뒤 새 줄로. */
export function withShopTagText(text: string, tag: string | null): string {
  if (!tag || !text.trim() || hasTag(text, tag)) return text;
  const lines = text.replace(/\s+$/, "").split("\n");
  const last = lines[lines.length - 1].trim();
  if (last && last.split(/\s+/).every((t) => /^#[^#\s]+$/.test(t))) {
    lines[lines.length - 1] = `${lines[lines.length - 1].trimEnd()} ${tag}`;
    return lines.join("\n");
  }
  return `${lines.join("\n")}\n\n${tag}`;
}

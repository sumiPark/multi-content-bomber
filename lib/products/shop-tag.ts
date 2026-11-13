// 상점 태그 — 오늘과일은 #오늘과일, 쿠마마켓은 #쿠마마켓, 리유코스메틱은 #리유코스메틱 (사용자 요청, 2026-11-12).
// 고르는 순서(2026-11-13): AI 자동 콘텐츠 · 직접 촬영처럼 상품이 정해진 콘텐츠는 그 상품의 몰을 따른다
// (joongdi처럼 리유 · 쿠마마켓 상품을 같이 다루는 계정 때문). 상품이 없으면 계정 연동 화면의 계정 그룹(0009)을 따르고,
// 아래 목록에 없는 그룹 · 그룹 없는 계정에는 붙이지 않는다.
// AI가 쓰는 해시태그 3개와 별개로, 발행할 때(worker/processors/publish-processor.ts)와
// 직접 촬영 완성본 받기 캡션에 덧붙인다. 이미 들어 있으면 다시 붙이지 않는다.

import { SHOPS, type ShopCode } from "@/lib/products/shops";

const SHOP_TAG_BY_GROUP: Record<string, string> = {
  오늘과일: "#오늘과일",
  쿠마마켓: "#쿠마마켓",
  리유코스메틱: "#리유코스메틱",
  "리유코스메틱 (일본)": "#리유코스메틱",
};

/** 몰 코드 → 상점 태그 (#오늘과일 · #쿠마마켓 · #리유코스메틱). */
export function shopTagForShop(code: string | null | undefined): string | null {
  if (!code || !(code in SHOPS)) return null;
  return `#${SHOPS[code as ShopCode].name}`;
}

/** 상품의 몰이 있으면 그 몰, 없으면 계정 그룹으로 상점 태그를 고른다. */
export function pickShopTag(productShop: string | null | undefined, groupName: string | null | undefined): string | null {
  return shopTagForShop(productShop) ?? shopTagForGroup(groupName);
}

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

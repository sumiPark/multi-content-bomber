// 세 몰 설정 — 오늘과일(cuma) · 쿠마마켓(cm) · 리유코스메틱(ru).
// 세 몰은 같은 백엔드(fshop)의 공개 상품 API를 쓰고 몰 코드만 다르다. 주소는 shops 테이블(0025)에도
// 있지만, 워커가 DB 없이 --dry-run으로도 돌 수 있게 코드에 같은 값을 둔다.

export type ShopCode = "cuma" | "cm" | "ru";
export type ProductKind = "FRUIT" | "COSMETIC" | "HEALTH_FOOD" | "CLOTHING" | "OTHER";

export interface ShopConfig {
  code: ShopCode;
  name: string;
  apiBase: string;
  siteBase: string;
}

export const SHOPS: Record<ShopCode, ShopConfig> = {
  cuma: {
    code: "cuma",
    name: "오늘과일",
    apiBase: "https://service.cuma.co.kr",
    siteBase: "https://www.cuma.co.kr",
  },
  cm: {
    code: "cm",
    name: "쿠마마켓",
    apiBase: "https://service.cumamarket.co.kr",
    siteBase: "https://www.cumamarket.co.kr",
  },
  ru: {
    code: "ru",
    name: "리유코스메틱",
    apiBase: "https://prod.service.reucosmetic.com",
    siteBase: "https://www.reucosmetic.com",
  },
};

export const SHOP_CODES = Object.keys(SHOPS) as ShopCode[];

export const KIND_LABEL: Record<ProductKind, string> = {
  FRUIT: "과일",
  COSMETIC: "화장품",
  HEALTH_FOOD: "건기식",
  CLOTHING: "의류",
  OTHER: "기타",
};

// 카테고리를 처음 발견했을 때의 기본값 (2026-11-03 사용자 확정). 이후엔 상품 화면에서 바꾼 값을 유지한다.
//   @fruit_cuma  → 오늘과일 과일
//   @joongdi     → 리유 화장품 + 건기식(쿠마마켓 식품 · 리유 건강식품)
//   @jjoonb      → 리유 화장품
//   @jior_joong  → 리유 의류 (라이프스타일 > 의류)
// 쿠마마켓 "식품"은 하위 분류가 없어 일반 식품이 섞인다 — 건기식인지는 분석이 판정한다.
// 이름으로 맞추는 이유: 카테고리 id는 몰마다 따로 매겨져 의미를 알기 어렵고, 이름이 사람이 확인한 기준이다.
const DEFAULT_RULES: Record<ShopCode, { name: string; kind: ProductKind }[]> = {
  cuma: [{ name: "과일", kind: "FRUIT" }],
  cm: [{ name: "식품", kind: "HEALTH_FOOD" }],
  ru: [
    { name: "클렌저", kind: "COSMETIC" },
    { name: "토너/미스트", kind: "COSMETIC" },
    { name: "세럼/앰플", kind: "COSMETIC" },
    { name: "크림", kind: "COSMETIC" },
    { name: "아이케어", kind: "COSMETIC" },
    { name: "메이크업", kind: "COSMETIC" },
    { name: "스페셜라인", kind: "COSMETIC" },
    { name: "베이비/키즈", kind: "COSMETIC" },
    { name: "건강식품", kind: "HEALTH_FOOD" },
    { name: "의류", kind: "CLOTHING" },
  ],
};

/**
 * 새로 발견한 카테고리의 기본 수집 여부 · 종류. 자기 규칙이 없으면 부모 값을 물려받는다.
 * (부모 값은 호출 쪽에서 트리 위에서부터 계산해 넘긴다.)
 */
export function defaultCategoryRule(
  shop: ShopCode,
  name: string,
  parent: { collect: boolean; kind: ProductKind | null } | null,
): { collect: boolean; kind: ProductKind | null } {
  const rule = DEFAULT_RULES[shop].find((r) => r.name === name.trim());
  if (rule) return { collect: true, kind: rule.kind };
  return parent ?? { collect: false, kind: null };
}

// 상세 이미지가 이 몰의 이 상품 자산인지 — 엉뚱한 외부 URL을 내려받아 AI에 보내지 않게.
const ASSET_PREFIXES = [
  "https://s3.ap-northeast-2.amazonaws.com/cumamarket.co.kr/resources/",
  "https://d35hpmlkzr3qpx.cloudfront.net/",
  "https://dsvf2lcz6s8aj.cloudfront.net/",
];

export function isShopAsset(url: string, shop: ShopCode, productId?: number): boolean {
  const prefix = ASSET_PREFIXES.find((p) => url.startsWith(p));
  if (!prefix) return false;
  const rest = url.slice(prefix.length);
  if (!rest.startsWith(`${shop}/products/`)) return false;
  return productId == null || rest.startsWith(`${shop}/products/${productId}/`);
}

export function productUrl(shop: ShopCode, productId: number): string {
  return `${SHOPS[shop].siteBase}/product/${productId}`;
}

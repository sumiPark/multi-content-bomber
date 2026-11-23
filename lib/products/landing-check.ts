import { SHOPS, SHOP_CODES, productUrl, type ShopCode } from "./shops";
import {
  ShopApiError,
  fetchLandingProduct,
  type LandingStatus,
  type StockStatus,
} from "./shop-api";

// 광고 랜딩 상품 점검 (Marketing Hub "상품 점검" 화면, 2026-11-23).
// 광고의 최종 URL을 받아 몰 공개 API에서 지금 상품명 · 가격 · 판매 상태를 읽는다.
// MCB 카탈로그(products)에 없는 상품도 본다 — 광고 전용 상품은 목록에 안 보여 수집에서 빠지거나 unavailable이다.

export const MAX_CHECK_URLS = 50;
const CONCURRENCY = 6;

/** 몰 상품 주소면 몰 · 상품번호. 쿼리(utm) · 해시 · 끝 슬래시는 무시한다. www · m · 도메인만 모두 받는다. */
export function parseProductUrl(input: string): { shop: ShopCode; productId: number } | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, "");
  const shop = SHOP_CODES.find((code) => new URL(SHOPS[code].siteBase).hostname.replace(/^www\./, "") === host);
  if (!shop) return null;
  const m = /^\/product\/(\d{1,12})\/?$/.exec(u.pathname);
  if (!m) return null;
  const productId = Number(m[1]);
  return Number.isSafeInteger(productId) && productId > 0 ? { shop, productId } : null;
}

export type CheckResult =
  | {
      input: string;
      result: "ok";
      shop: ShopCode;
      shopName: string;
      productId: number;
      url: string;
      name: string;
      price: number | null;
      landingStatus: LandingStatus;
      stockStatus: StockStatus;
      productStatus: string | null;
      hiddenInList: boolean;
      appOnly: boolean;
      image: string | null;
    }
  | { input: string; result: "not_product_url" }
  | { input: string; result: "not_found" | "error"; shop: ShopCode; shopName: string; productId: number; url: string; error: string };

async function checkOne(shop: ShopCode, productId: number) {
  const base = { shop, shopName: SHOPS[shop].name, productId, url: productUrl(shop, productId) };
  try {
    const p = await fetchLandingProduct(shop, productId);
    return {
      ...base,
      result: "ok" as const,
      name: p.name,
      price: p.price,
      landingStatus: p.landingStatus,
      stockStatus: p.stockStatus,
      productStatus: p.productStatus,
      hiddenInList: p.hiddenInList,
      appOnly: p.appOnly,
      image: p.representImageUrl,
    };
  } catch (err) {
    // 몰은 없는 상품에 400(E1031 "존재하지 않는 상품")으로 답한다
    const missing = err instanceof ShopApiError && (err.status === 400 || err.status === 404);
    return {
      ...base,
      result: missing ? ("not_found" as const) : ("error" as const),
      error: missing ? "몰에 없는 상품" : err instanceof Error ? err.message : String(err),
    };
  }
}

/** 주소마다 결과 하나(입력 순서). 같은 상품을 가리키는 주소는 몰에 한 번만 묻는다. */
export async function checkProductUrls(urls: string[]): Promise<CheckResult[]> {
  const parsed = urls.map((input) => ({ input, key: parseProductUrl(input) }));
  const keys = [...new Map(parsed.filter((p) => p.key).map((p) => [`${p.key!.shop}:${p.key!.productId}`, p.key!])).entries()];

  const found = new Map<string, Awaited<ReturnType<typeof checkOne>>>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, keys.length) }, async () => {
      while (next < keys.length) {
        const [k, v] = keys[next++];
        found.set(k, await checkOne(v.shop, v.productId));
      }
    }),
  );

  return parsed.map(({ input, key }) =>
    key ? ({ input, ...found.get(`${key.shop}:${key.productId}`)! } as CheckResult) : { input, result: "not_product_url" },
  );
}

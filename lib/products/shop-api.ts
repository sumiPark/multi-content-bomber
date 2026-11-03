import { createHash } from "crypto";
import { z } from "zod";
import {
  SHOPS,
  isShopAsset,
  productUrl,
  type ShopCode,
} from "./shops";

// 몰 공개 상품 API (fshop 백엔드 — 세 몰 공통, 인증 없음).
//   GET /v1/categories?withChildren=true
//   GET /v1/products/category/{categoryId}?orderby=latest&take=N[&nextPage=<cursor>]
//   GET /v1/products/{id}
// 응답 형태는 리유 분석 프로젝트(ChatGPT-Codex/ai-recommend lib/ingest.ts)에서 확인한 것과 같고,
// 2026-11-03 오늘과일 · 쿠마마켓에서도 같은 필드가 오는 것을 확인했다.

const USER_AGENT = "MCB-Catalog/1.0";
const TIMEOUT_MS = 20_000;
const LIST_PAGE_SIZE = 50;
// 목록이 끝없이 이어지는 이상 상황 방어 (50 × 200 = 1만 개)
const MAX_LIST_PAGES = 200;
const MAX_DETAIL_IMAGES = 100;

export class ShopApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "ShopApiError";
  }
}

async function getJson(url: string): Promise<unknown> {
  // 5xx · 429 · 네트워크 오류는 한 번만 다시 시도한다.
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      throw new ShopApiError(
        `요청 실패 ${url}: ${err instanceof Error ? err.message : String(err)}`,
        null,
      );
    }
    if (res.ok) return res.json();
    if (attempt === 0 && (res.status >= 500 || res.status === 429)) {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    throw new ShopApiError(`HTTP ${res.status} ${url}`, res.status);
  }
}

// ── 카테고리 ────────────────────────────────────────────────────────────────

export interface ShopCategory {
  id: number;
  name: string;
  parentId: number | null;
}

type CategoryNode = { id: number; name: string; children?: CategoryNode[] | null };
const categoryNode: z.ZodType<CategoryNode> = z.lazy(() =>
  z.object({
    id: z.number(),
    name: z.string(),
    children: z.array(categoryNode).nullish(),
  }),
);

/** 카테고리 트리를 위에서부터(부모가 자식보다 먼저) 평탄화해 돌려준다. */
export async function fetchCategories(shop: ShopCode): Promise<ShopCategory[]> {
  const body = await getJson(`${SHOPS[shop].apiBase}/v1/categories?withChildren=true`);
  const roots = z.array(categoryNode).parse(body);
  const out: ShopCategory[] = [];
  const walk = (nodes: CategoryNode[], parentId: number | null) => {
    for (const n of nodes) {
      out.push({ id: n.id, name: n.name, parentId });
      if (n.children?.length) walk(n.children, n.id);
    }
  };
  walk(roots, null);
  return out;
}

// ── 목록 ────────────────────────────────────────────────────────────────────

const listSchema = z.object({
  page: z.object({ nextPage: z.string().nullish() }).nullish(),
  list: z.array(z.object({ id: z.number() })),
});

/** 카테고리(하위 포함)에 있는 상품 id 전부. */
export async function listCategoryProductIds(
  shop: ShopCode,
  categoryId: number,
): Promise<number[]> {
  const ids: number[] = [];
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const url = new URL(`${SHOPS[shop].apiBase}/v1/products/category/${categoryId}`);
    url.searchParams.set("orderby", "latest");
    url.searchParams.set("take", String(LIST_PAGE_SIZE));
    if (cursor) url.searchParams.set("nextPage", cursor);
    const body = listSchema.parse(await getJson(url.toString()));
    for (const p of body.list) ids.push(p.id);
    const next = body.page?.nextPage ?? null;
    if (!next || body.list.length === 0 || seenCursors.has(next)) return ids;
    seenCursors.add(next);
    cursor = next;
  }
  throw new ShopApiError(
    `${shop} 카테고리 ${categoryId} 목록이 ${MAX_LIST_PAGES}쪽을 넘음 — 수집 중단`,
    null,
  );
}

// ── 상세 ────────────────────────────────────────────────────────────────────

const detailSchema = z.object({
  id: z.number(),
  name: z.string(),
  summaryTitle: z.string().nullish(),
  contents: z.string().nullish(),
  productStatus: z.string().nullish(),
  deletedAt: z.string().nullish(),
  updateDate: z.string().nullish(),
  minAppUserGrade: z.unknown().nullish(),
  isAppOnly: z.boolean().nullish(),
  isGiftOnly: z.boolean().nullish(),
  isVisibleInList: z.boolean().nullish(),
  representImageBucketUrl: z.string().nullish(),
  productPrice: z.object({ price: z.number().nullish() }).nullish(),
  productSaleType: z
    .object({
      isCommingSoon: z.boolean().nullish(),
      saleType: z.string().nullish(),
      limitedPeriodSaleEndDate: z.string().nullish(),
    })
    .nullish(),
  productDetail: z
    .object({
      productImages: z
        .array(z.object({ bucketUrl: z.string(), sort: z.number().nullish() }))
        .nullish(),
    })
    .nullish(),
  category: z.object({ id: z.number().nullish(), name: z.string().nullish() }).nullish(),
  categories: z.array(z.object({ id: z.number().nullish(), name: z.string().nullish() })).nullish(),
  reviewCount: z.number().nullish(),
  scoreAverage: z.number().nullish(),
  salesQuantity: z.number().nullish(),
});

export type StockStatus = "available" | "temporarily_out" | "discontinued" | "unavailable";

export interface ShopProduct {
  shop: ShopCode;
  id: number;
  name: string;
  summaryTitle: string | null;
  categoryId: number | null;
  categoryName: string | null;
  // 상품이 걸린 카테고리 전부 (대표 카테고리 + 하위 분류). 수집 여부 · 종류 판정에 쓴다.
  categoryIds: number[];
  price: number | null;
  productStatus: string | null;
  stockStatus: StockStatus;
  url: string;
  representImageUrl: string | null;
  detailImageUrls: string[];
  sourceUpdatedAt: string | null;
  sourceHash: string;
  // 판정에 쓴 원본 값 — 기준을 바꿀 때 다시 받지 않고 확인할 수 있게 남긴다.
  raw: Record<string, unknown>;
}

/**
 * 판매 상태. 리유 분석 프로젝트의 기준을 따르되, 앱 전용(isAppOnly) 상품은 판매 중으로 본다 —
 * 세 몰 모두 앱에서 팔고, 인스타 영상은 앱 구매로 이어져도 된다.
 */
function stockStatusOf(d: z.infer<typeof detailSchema>, now: number): StockStatus {
  const sale = d.productSaleType;
  const periodEnded =
    !!sale?.saleType?.includes("PERIOD") &&
    !!sale.limitedPeriodSaleEndDate &&
    Date.parse(sale.limitedPeriodSaleEndDate) < now;
  const accessible =
    d.isVisibleInList !== false &&
    !d.deletedAt &&
    !sale?.isCommingSoon &&
    !periodEnded &&
    !d.minAppUserGrade &&
    !d.isGiftOnly;
  if (d.productStatus === "suspended") return "discontinued";
  if (!accessible) return "unavailable";
  if (d.productStatus === "stock_in") return "available";
  if (d.productStatus === "temp_stock_out" || d.productStatus === "stock_out") {
    return "temporarily_out";
  }
  return "unavailable";
}

export async function fetchProduct(shop: ShopCode, id: number): Promise<ShopProduct> {
  const d = detailSchema.parse(await getJson(`${SHOPS[shop].apiBase}/v1/products/${id}`));
  if (d.id !== id) throw new ShopApiError(`${shop} 상품 ${id}: 응답 id 불일치(${d.id})`, null);

  const images = [...(d.productDetail?.productImages ?? [])]
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
    .map((i) => i.bucketUrl)
    // 상세페이지 이미지는 새 상품은 detailImage/, 예전 상품(오늘과일)은 productImages/에 있다.
    // productImages에는 상세 내용이 들어 있어 둘 다 받는다(대표 이미지는 represent/라 빠진다).
    .filter(
      (u) =>
        isShopAsset(u, shop, id) &&
        (u.includes("/detailImage/") || u.includes("/productImages/")),
    );
  if (images.length > MAX_DETAIL_IMAGES) {
    throw new ShopApiError(`${shop} 상품 ${id}: 상세 이미지 ${images.length}장 — 상한 초과`, null);
  }

  const summaryTitle = d.summaryTitle?.trim() || null;
  const contents = d.contents?.trim() || null;
  // 가격 · 재고 · 수정일은 넣지 않는다 — 이것만 바뀌면 상세페이지를 다시 분석할 이유가 없다.
  const sourceHash = createHash("sha256")
    .update(JSON.stringify([d.name, summaryTitle, contents, images]))
    .digest("hex");

  const represent = d.representImageBucketUrl ?? null;
  return {
    shop,
    id,
    name: d.name.trim(),
    summaryTitle,
    categoryId: d.category?.id ?? null,
    categoryName: d.category?.name ?? null,
    categoryIds: [
      ...new Set(
        [d.category?.id, ...(d.categories ?? []).map((c) => c.id)].filter(
          (v): v is number => typeof v === "number",
        ),
      ),
    ],
    price: d.productPrice?.price ?? null,
    productStatus: d.productStatus ?? null,
    stockStatus: stockStatusOf(d, Date.now()),
    url: productUrl(shop, id),
    representImageUrl: represent && isShopAsset(represent, shop) ? represent : null,
    detailImageUrls: images,
    sourceUpdatedAt: d.updateDate ?? null,
    sourceHash,
    raw: {
      contents,
      isAppOnly: d.isAppOnly ?? null,
      isGiftOnly: d.isGiftOnly ?? null,
      isVisibleInList: d.isVisibleInList ?? null,
      minAppUserGrade: d.minAppUserGrade ?? null,
      saleType: d.productSaleType ?? null,
      categories: (d.categories ?? []).map((c) => c.name).filter(Boolean),
      reviewCount: d.reviewCount ?? null,
      scoreAverage: d.scoreAverage ?? null,
      salesQuantity: d.salesQuantity ?? null,
    },
  };
}

/**
 * 가격 · 판매 상태만 — 발행 직전 다시 확인(5-4)용. 상세 이미지 개수 검사 같은 수집용 검사는 하지 않는다
 * (발행을 막을 이유가 아니므로).
 */
export async function fetchProductStatus(
  shop: ShopCode,
  id: number,
): Promise<{ name: string; price: number | null; stockStatus: StockStatus }> {
  const d = detailSchema.parse(await getJson(`${SHOPS[shop].apiBase}/v1/products/${id}`));
  if (d.id !== id) throw new ShopApiError(`${shop} 상품 ${id}: 응답 id 불일치(${d.id})`, null);
  return { name: d.name.trim(), price: d.productPrice?.price ?? null, stockStatus: stockStatusOf(d, Date.now()) };
}

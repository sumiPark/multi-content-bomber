// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions에선 no-op).
import "./load-env";

import {
  fetchCategories,
  fetchProduct,
  listCategoryProductIds,
  type ShopCategory,
  type ShopProduct,
} from "@/lib/products/shop-api";
import {
  SHOP_CODES,
  defaultCategoryRule,
  type ProductKind,
  type ShopCode,
} from "@/lib/products/shops";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";
import { startRunLog } from "./run-log";

// ─────────────────────────────────────────────────────────────────────────────
// 상품 수집 워커 — 세 몰(오늘과일 · 쿠마마켓 · 리유) 상품을 공개 API로 받아 products에 쌓는다.
// 상품 선정 에이전트(1)의 "상품 조회" 스킬이 읽는 재료. "한 번 실행하고 종료"하는 배치.
//
// .github/workflows/products.yml이 깨운다: 매일 03시(KST) + 상품 화면의 "지금 수집".
//
// 몰마다:
//   1. 카테고리 트리 → shop_categories (새 카테고리만 기본 수집 규칙 적용, 기존 값은 유지)
//   2. 수집하는 카테고리의 상품 id 목록 → 상세를 하나씩 받아 products에 upsert
//      이름 · 요약 · 상세 이미지가 바뀐 상품만 analysis_state=queued (가격 · 재고만 바뀌면 그대로)
//   3. 목록을 끝까지 다 읽었을 때만, 이번에 안 보인 상품을 unavailable로 내린다
//
// 옵션: --dry-run (DB에 안 씀, 몰 API만 읽고 요약 출력) · --shop cuma|cm|ru · --limit N (몰당 상세 N개)
// ─────────────────────────────────────────────────────────────────────────────

const DETAIL_CONCURRENCY = 4;
const UPSERT_BATCH = 100;

type Service = ReturnType<typeof createServiceClient>;

interface Args {
  dryRun: boolean;
  shops: ShopCode[];
  limit: number | null;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const shop = get("--shop");
  if (shop && !SHOP_CODES.includes(shop as ShopCode)) {
    throw new Error(`--shop은 ${SHOP_CODES.join("|")} 중 하나`);
  }
  const limit = get("--limit");
  return {
    dryRun: argv.includes("--dry-run"),
    shops: shop ? [shop as ShopCode] : SHOP_CODES,
    limit: limit ? Number(limit) : null,
  };
}

type CategoryState = ShopCategory & {
  collect: boolean;
  kind: ProductKind | null;
  depth: number;
  isNew: boolean;
};

/** 카테고리 트리에 수집 여부 · 종류를 매긴다. 기존 행은 사람이 바꾼 값을 그대로 쓴다. */
async function resolveCategories(
  service: Service | null,
  shop: ShopCode,
  categories: ShopCategory[],
): Promise<Map<number, CategoryState>> {
  const existing = new Map<number, { collect: boolean; kind: ProductKind | null }>();
  if (service) {
    const { data, error } = await service
      .from("shop_categories")
      .select("category_id, collect, kind")
      .eq("shop_code", shop);
    if (error) throw new Error(`shop_categories 조회 실패: ${error.message}`);
    for (const r of data ?? []) {
      existing.set(r.category_id, { collect: r.collect, kind: r.kind as ProductKind | null });
    }
  }

  const out = new Map<number, CategoryState>();
  // fetchCategories는 부모를 자식보다 먼저 준다.
  for (const c of categories) {
    const parent = c.parentId != null ? out.get(c.parentId) ?? null : null;
    const prev = existing.get(c.id);
    const rule = prev ?? defaultCategoryRule(shop, c.name, parent);
    out.set(c.id, {
      ...c,
      collect: rule.collect,
      kind: rule.kind,
      depth: parent ? parent.depth + 1 : 0,
      isNew: !prev,
    });
  }

  if (service) {
    const rows = [...out.values()].map((c) => ({
      shop_code: shop,
      category_id: c.id,
      parent_id: c.parentId,
      name: c.name,
      collect: c.collect,
      kind: c.kind,
      seen_at: new Date().toISOString(),
    }));
    const { error } = await service
      .from("shop_categories")
      .upsert(rows, { onConflict: "shop_code,category_id" });
    if (error) throw new Error(`shop_categories 저장 실패: ${error.message}`);
  }
  return out;
}

/** 상품이 걸린 카테고리 중 가장 깊은(구체적인) 것의 설정을 따른다. */
function effectiveCategory(
  product: ShopProduct,
  categories: Map<number, CategoryState>,
): CategoryState | null {
  let best: CategoryState | null = null;
  for (const id of product.categoryIds) {
    const c = categories.get(id);
    if (c && (!best || c.depth > best.depth)) best = c;
  }
  return best;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

interface ShopSummary {
  shop: ShopCode;
  categories: number;
  collectRoots: string[];
  listed: number;
  saved: number;
  queued: number;
  skippedByCategory: number;
  errors: string[];
  markedUnavailable: number;
  byKind: Record<string, number>;
  byStock: Record<string, number>;
}

async function collectShop(service: Service | null, shop: ShopCode, args: Args): Promise<ShopSummary> {
  const runStartedAt = new Date().toISOString();
  const summary: ShopSummary = {
    shop,
    categories: 0,
    collectRoots: [],
    listed: 0,
    saved: 0,
    queued: 0,
    skippedByCategory: 0,
    errors: [],
    markedUnavailable: 0,
    byKind: {},
    byStock: {},
  };

  // 1. 카테고리
  const categories = await resolveCategories(service, shop, await fetchCategories(shop));
  summary.categories = categories.size;
  // 부모가 이미 수집 대상이면 자식 목록은 따로 안 읽는다(부모 목록에 하위 상품이 다 나온다).
  const roots = [...categories.values()].filter(
    (c) => c.collect && !(c.parentId != null && categories.get(c.parentId)?.collect),
  );
  summary.collectRoots = roots.map((c) => `${c.name}(${c.id})`);

  // 2. 상품 id
  const ids = new Set<number>();
  let listComplete = true;
  for (const root of roots) {
    try {
      for (const id of await listCategoryProductIds(shop, root.id)) ids.add(id);
    } catch (err) {
      listComplete = false;
      summary.errors.push(`목록 ${root.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  summary.listed = ids.size;
  const targetIds = args.limit ? [...ids].slice(0, args.limit) : [...ids];

  const existing = new Map<number, { source_hash: string; excluded: boolean; kind: string | null }>();
  if (service) {
    // 몰당 수천 개 이하라 한 번에 읽는다(Supabase 기본 1000행 제한 → 페이지로).
    for (let from = 0; ; from += 1000) {
      const { data, error } = await service
        .from("products")
        .select("shop_product_id, source_hash, excluded, kind")
        .eq("shop_code", shop)
        .range(from, from + 999);
      if (error) throw new Error(`products 조회 실패: ${error.message}`);
      for (const r of data ?? []) existing.set(r.shop_product_id, r);
      if (!data || data.length < 1000) break;
    }
  }

  // 3. 상세
  const products = await mapLimit(targetIds, DETAIL_CONCURRENCY, async (id) => {
    try {
      return await fetchProduct(shop, id);
    } catch (err) {
      summary.errors.push(`상품 ${id}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  });

  const rows = [];
  for (const p of products) {
    if (!p) continue;
    const cat = effectiveCategory(p, categories);
    // 사람이 끈 하위 카테고리의 상품 — 부모 목록에 섞여 나와도 넣지 않는다.
    if (cat && !cat.collect) {
      summary.skippedByCategory++;
      continue;
    }
    const kind = cat?.kind ?? "OTHER";
    const prev = existing.get(p.id);
    // 사람이 카테고리 종류를 바꿨으면 분석 항목이 달라지니 다시 분석한다(받아 둔 이미지 글은 재사용, 판매 중인 것만)
    const changed = !prev || prev.source_hash !== p.sourceHash || prev.kind !== kind;
    summary.byKind[kind] = (summary.byKind[kind] ?? 0) + 1;
    summary.byStock[p.stockStatus] = (summary.byStock[p.stockStatus] ?? 0) + 1;
    if (changed) summary.queued++;
    rows.push({
      shop_code: shop,
      shop_product_id: p.id,
      name: p.name,
      summary_title: p.summaryTitle,
      category_id: cat?.id ?? p.categoryId,
      category_name: cat?.name ?? p.categoryName,
      kind,
      price: p.price,
      stock_status: p.stockStatus,
      product_status: p.productStatus,
      url: p.url,
      represent_image_url: p.representImageUrl,
      detail_image_urls: p.detailImageUrls,
      source_updated_at: p.sourceUpdatedAt,
      source_hash: p.sourceHash,
      raw: p.raw as Json,
      last_seen_at: new Date().toISOString(),
      // 상세페이지나 종류가 바뀐 상품만 다시 분석 대기로. 종류가 기타면 분석하지 않는다.
      ...(changed
        ? {
            analysis_state: kind === "OTHER" ? "skipped" : "queued",
            analysis_attempts: 0,
            analysis_next_at: new Date().toISOString(),
            analysis_error: null,
          }
        : {}),
    });
  }

  if (args.dryRun || !service) {
    summary.saved = rows.length;
    const sample = rows.slice(0, 3).map(
      (r) => `    ${r.shop_product_id} ${r.name} | ${r.kind} | ${r.stock_status} | ${r.price ?? "-"}원 | 상세 이미지 ${r.detail_image_urls.length}장`,
    );
    if (sample.length) console.log(`[collect-products] ${shop} 예시:\n${sample.join("\n")}`);
    return summary;
  }

  // 바뀐 행과 안 바뀐 행은 컬럼 구성이 달라 따로 upsert한다(안 바뀐 행의 분석 상태를 덮지 않게).
  const groups = [rows.filter((r) => "analysis_state" in r), rows.filter((r) => !("analysis_state" in r))];
  for (const group of groups) {
    for (let i = 0; i < group.length; i += UPSERT_BATCH) {
      const { error } = await service
        .from("products")
        .upsert(group.slice(i, i + UPSERT_BATCH), { onConflict: "shop_code,shop_product_id" });
      if (error) throw new Error(`products 저장 실패: ${error.message}`);
    }
  }
  summary.saved = rows.length;

  // 4. 이번에 안 보인 상품 — 목록을 끝까지 읽었고 일부만(--limit) 돈 게 아닐 때만.
  if (listComplete && !args.limit) {
    const { data, error } = await service
      .from("products")
      .update({ stock_status: "unavailable" })
      .eq("shop_code", shop)
      .lt("last_seen_at", runStartedAt)
      .neq("stock_status", "unavailable")
      .select("id");
    if (error) summary.errors.push(`사라진 상품 처리 실패: ${error.message}`);
    summary.markedUnavailable = data?.length ?? 0;
  }
  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const service = args.dryRun ? null : createServiceClient();
  const startedAt = Date.now();
  const log = service ? await startRunLog(service, "collect-products") : null;
  const summaries: Record<string, unknown>[] = [];

  let failed = 0;
  for (const shop of args.shops) {
    try {
      const s = await collectShop(service, shop, args);
      summaries.push({
        shop,
        listed: s.listed,
        saved: s.saved,
        queued: s.queued,
        markedUnavailable: s.markedUnavailable,
        errors: s.errors.slice(0, 10),
        errorCount: s.errors.length,
      });
      console.log(
        `[collect-products] ${shop}: 카테고리 ${s.categories} | 수집 카테고리 ${s.collectRoots.join(", ") || "없음"}\n` +
          `  목록 ${s.listed}개 → 저장 ${s.saved}개 (분석 대기 ${s.queued}, 꺼진 하위 카테고리 ${s.skippedByCategory}, 사라짐 처리 ${s.markedUnavailable})\n` +
          `  종류 ${JSON.stringify(s.byKind)} | 판매 상태 ${JSON.stringify(s.byStock)}` +
          (s.errors.length ? `\n  오류 ${s.errors.length}건: ${s.errors.slice(0, 5).join(" / ")}` : ""),
      );
      if (s.errors.length > 0 && s.saved === 0) failed++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      summaries.push({ shop, failed: true, errors: [message], errorCount: 1 });
      console.error(`[collect-products] ${shop} 실패:`, message);
    }
  }

  if (failed === args.shops.length) process.exitCode = 1;
  await log?.finish(failed === args.shops.length ? "failed" : "success", { shops: summaries });
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[collect-products] 완료${args.dryRun ? " (dry-run, DB 저장 안 함)" : ""} | ${elapsed}s`);
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("[collect-products] 치명적 오류:", err);
    process.exit(1);
  });

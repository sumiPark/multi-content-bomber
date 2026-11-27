import { fetchLandingProduct, ShopApiError } from "@/lib/products/shop-api";
import { SHOP_CODES, type ShopCode } from "@/lib/products/shops";
import type { createServiceClient } from "@/lib/supabase/service";
import { productKey } from "./load";

// 모아링크에 올라간 상품의 판매 상태 · 가격 점검 (기획서 2장).
// 몰 공개 API(광고 랜딩 기준)만 쓴다 — AI 비용 없음. 조회가 실패하면 마지막 상태를 그대로 두고 실패 횟수만 올린다.

type Service = ReturnType<typeof createServiceClient>;

export interface ProductRef {
  shop: ShopCode;
  id: number;
}

const CONCURRENCY = 6;

export interface RefreshResult {
  checked: number;
  failed: number;
  /** 판매 상태 · 가격 · 이름 · 이미지 중 하나라도 바뀐 상품 수 — 0보다 크면 공개 페이지 캐시를 비운다 */
  changed: number;
}

export function isShopCode(v: string | null | undefined): v is ShopCode {
  return !!v && (SHOP_CODES as string[]).includes(v);
}

/** 상품들을 몰에 조회해 moa_product_status를 갱신한다. deadline(ms 시각)이 지나면 남은 것은 다음 회차로 넘긴다. */
export async function refreshProductStatuses(
  service: Service,
  refs: ProductRef[],
  deadline = Date.now() + 45_000,
): Promise<RefreshResult> {
  const unique = [...new Map(refs.map((r) => [productKey(r.shop, r.id), r])).values()];
  if (unique.length === 0) return { checked: 0, failed: 0, changed: 0 };

  const prev = new Map<string, { landing_status: string | null; price: number | null; name: string | null; image_url: string | null; fail_count: number }>();
  for (const shop of new Set(unique.map((r) => r.shop))) {
    const { data } = await service
      .from("moa_product_status")
      .select("shop_product_id, landing_status, price, name, image_url, fail_count")
      .eq("shop_code", shop)
      .in("shop_product_id", unique.filter((r) => r.shop === shop).map((r) => r.id));
    for (const s of data ?? []) prev.set(productKey(shop, s.shop_product_id), s);
  }

  const result: RefreshResult = { checked: 0, failed: 0, changed: 0 };
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, unique.length) }, async () => {
      while (next < unique.length && Date.now() < deadline) {
        const ref = unique[next++];
        const key = productKey(ref.shop, ref.id);
        const before = prev.get(key);
        const now = new Date().toISOString();
        try {
          let row: { name: string | null; price: number | null; image_url: string | null; landing_status: string; app_only: boolean };
          try {
            const p = await fetchLandingProduct(ref.shop, ref.id);
            row = { name: p.name, price: p.price, image_url: p.representImageUrl, landing_status: p.landingStatus, app_only: p.appOnly };
          } catch (err) {
            // 몰은 없는 상품에 400(E1031)으로 답한다 — 삭제로 본다
            if (err instanceof ShopApiError && (err.status === 400 || err.status === 404)) {
              row = { name: before?.name ?? null, price: before?.price ?? null, image_url: before?.image_url ?? null, landing_status: "deleted", app_only: false };
            } else {
              throw err;
            }
          }
          const statusChanged = before?.landing_status !== row.landing_status;
          const changed =
            statusChanged || before?.price !== row.price || before?.name !== row.name || before?.image_url !== row.image_url;
          const { error } = await service.from("moa_product_status").upsert(
            {
              shop_code: ref.shop,
              shop_product_id: ref.id,
              ...row,
              checked_at: now,
              last_ok_at: now,
              fail_count: 0,
              last_error: null,
              ...(statusChanged ? { status_changed_at: now } : {}),
            },
            { onConflict: "shop_code,shop_product_id" },
          );
          if (error) throw new Error(error.message);
          result.checked++;
          if (changed) result.changed++;
        } catch (err) {
          result.failed++;
          const message = err instanceof Error ? err.message : String(err);
          // 실패: 마지막 상태는 그대로 두고 실패 횟수만 올린다(품절로 단정하지 않음)
          await service.from("moa_product_status").upsert(
            {
              shop_code: ref.shop,
              shop_product_id: ref.id,
              checked_at: now,
              fail_count: (before?.fail_count ?? 0) + 1,
              last_error: message.slice(0, 300),
            },
            { onConflict: "shop_code,shop_product_id" },
          );
        }
      }
    }),
  );
  return result;
}

/** 점검할 상품 — 지우지 않은 블록에 걸린 상품 중 마지막 조회가 오래된 순서 */
export async function dueProductRefs(service: Service, olderThanMs: number, limit: number): Promise<ProductRef[]> {
  const { data: blocks, error } = await service
    .from("moa_blocks")
    .select("shop_code, shop_product_id")
    .is("deleted_at", null)
    .not("shop_code", "is", null);
  if (error) throw new Error(`블록 조회 실패: ${error.message}`);
  const refs = new Map<string, ProductRef>();
  for (const b of blocks ?? []) {
    if (isShopCode(b.shop_code) && b.shop_product_id != null) refs.set(productKey(b.shop_code, b.shop_product_id), { shop: b.shop_code, id: b.shop_product_id });
  }
  if (refs.size === 0) return [];

  const checked = new Map<string, number>();
  for (const shop of new Set([...refs.values()].map((r) => r.shop))) {
    const { data } = await service
      .from("moa_product_status")
      .select("shop_product_id, checked_at")
      .eq("shop_code", shop)
      .in("shop_product_id", [...refs.values()].filter((r) => r.shop === shop).map((r) => r.id));
    for (const s of data ?? []) checked.set(productKey(shop, s.shop_product_id), s.checked_at ? Date.parse(s.checked_at) : 0);
  }
  const cutoff = Date.now() - olderThanMs;
  return [...refs.entries()]
    .map(([k, r]) => ({ r, at: checked.get(k) ?? 0 }))
    .filter((x) => x.at <= cutoff)
    .sort((a, b) => a.at - b.at)
    .slice(0, limit)
    .map((x) => x.r);
}

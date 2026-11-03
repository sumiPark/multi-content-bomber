import { fetchProductStatus, type StockStatus } from "@/lib/products/shop-api";
import type { ShopCode } from "@/lib/products/shops";
import type { createServiceClient } from "@/lib/supabase/service";

// 발행 직전 다시 확인(콘텐츠 자동화 5-4) — 편성 칸(content_plans)에서 예약된 발행만.
// 올리기 바로 전에 몰 API로 판매 상태 · 가격을 다시 받아, 판매 중이 아니거나 캡션에 적은 가격이 지금 가격과
// 다르면 올리지 않는다. 칸은 BLOCKED(멈춤)로 두고 이유를 남겨 대시보드 · 편성표에 뜨게 한다.
// 몰 API가 안 되면 수집해 둔 상태(매일 03시)로 판단한다 — API 장애로 발행 전체가 막히지 않게.
// 편성 칸이 아닌 발행(사람이 콘텐츠 생성에서 만든 것)은 아무것도 하지 않는다.

type Service = ReturnType<typeof createServiceClient>;

export type PrepublishResult = { ok: true; note: string | null } | { ok: false; reason: string };

const STOCK_LABEL: Record<StockStatus, string> = {
  available: "판매 중",
  temporarily_out: "일시 품절",
  discontinued: "판매 중지",
  unavailable: "노출 안 됨",
};

/**
 * 캡션에 적힌 판매 가격(원) — "19,900원", "19900 원". 1,000원 미만과
 * 할인 · 적립 · 쿠폰 금액("3,000원 할인")은 판매 가격이 아니라 뺀다.
 */
export function captionPrices(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(\d{1,3}(?:,\d{3})+|\d{4,})\s*원(?!\s*(?:할인|적립|쿠폰|추가|더|off|OFF|↓))/g)) {
    const n = Number(m[1].replaceAll(",", ""));
    if (n >= 1000) out.push(n);
  }
  return out;
}

export async function prepublishCheck(service: Service, job: { id: string; content_id: string }): Promise<PrepublishResult> {
  const { data: plan } = await service
    .from("content_plans")
    .select("id, status, product_id, products(shop_code, shop_product_id, name, price, stock_status)")
    .eq("publish_job_id", job.id)
    .maybeSingle();
  if (!plan) return { ok: true, note: null }; // 편성 칸 발행이 아님 — 예전 그대로
  const product = plan.products;
  if (!product) return { ok: true, note: null };

  let stock = product.stock_status as StockStatus;
  let price = product.price;
  let source = "몰 확인";
  try {
    const fresh = await fetchProductStatus(product.shop_code as ShopCode, Number(product.shop_product_id));
    stock = fresh.stockStatus;
    price = fresh.price;
    // 받은 김에 상품 행도 최신으로(수집은 하루 한 번이라)
    if (fresh.stockStatus !== product.stock_status || fresh.price !== product.price) {
      await service.from("products").update({ stock_status: fresh.stockStatus, price: fresh.price }).eq("id", plan.product_id!);
    }
  } catch (err) {
    source = `몰 API 실패 — 수집해 둔 상태로 판단 (${err instanceof Error ? err.message.slice(0, 80) : String(err)})`;
  }

  let reason: string | null = null;
  if (stock !== "available") {
    reason = `발행 직전 확인: 상품이 지금 ${STOCK_LABEL[stock] ?? stock}이라 올리지 않았어요 (${product.name})`;
  } else if (price != null) {
    const { data: content } = await service.from("contents").select("ai_captions").eq("id", job.content_id).maybeSingle();
    const ig = ((content?.ai_captions ?? {}) as { instagram?: { caption?: string } }).instagram;
    const mentioned = captionPrices(ig?.caption ?? "");
    if (mentioned.length > 0 && !mentioned.includes(price)) {
      reason = `발행 직전 확인: 캡션 가격(${mentioned.map((p) => p.toLocaleString("ko-KR")).join(" · ")}원)이 지금 가격(${price.toLocaleString("ko-KR")}원)과 달라 올리지 않았어요`;
    }
  }

  if (reason) {
    await service.from("content_plans").update({ status: "BLOCKED", note: reason }).eq("id", plan.id);
    return { ok: false, reason };
  }
  // 예전에 막혔다가 사람이 다시 시도해 통과하면 칸을 예약 상태로 되돌린다
  if (plan.status === "BLOCKED") await service.from("content_plans").update({ status: "SCHEDULED", note: null }).eq("id", plan.id);
  return { ok: true, note: `발행 직전 확인 통과 (${source}: ${STOCK_LABEL[stock]}${price != null ? ` · ${price.toLocaleString("ko-KR")}원` : ""})` };
}

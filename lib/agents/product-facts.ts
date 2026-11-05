import { KIND_LABEL, SHOPS, type ProductKind, type ShopCode } from "@/lib/products/shops";
import type { createServiceClient } from "@/lib/supabase/service";

// 대본 · 점검 에이전트가 쓰는 상품 사실 묶음 — 상세페이지 분석(0025)에서 원문 근거가 확인된 것만.
// 건강기능식품 기능성 표현은 사람이 확정한 심의 문구(product_claim_approvals)만.

type Service = ReturnType<typeof createServiceClient>;

/** 대본 · 영상에 쓰는 상품 이름. 쇼핑몰 표기의 대괄호 표시([70번], [김성중], [무료배송])를 뺀다(2026-11-05 사용자 결정). */
export function videoProductName(listing: string): string {
  const name = listing.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
  return name || listing.replace(/[[\]]/g, "").trim();
}

export interface ProductFacts {
  id: string;
  // 대본 · 영상에 쓰는 이름
  name: string;
  // 쇼핑몰 표기 그대로. 글에 쓰지 않고 근거 대조에만 쓴다
  rawName: string;
  shop: string;
  kind: ProductKind;
  kindLabel: string;
  price: number | null;
  stockStatus: string;
  url: string;
  detailImages: number;
  oneLine: string | null;
  usage: string | null;
  cautions: string | null;
  details: Record<string, unknown>;
  claims: { claim: string; quote: string }[];
  uncertainties: string[];
  healthFunctional: boolean | null;
  approvedClaims: string[];
  // 화장품 기능성 표기(심사 · 보고) — 상세페이지에 있을 때만 그 표현을 쓸 수 있다
  certifiedFunctions: string[];
  // 근거 확인용 원문 (이미지 순서, 앞 6000자)
  sourceText: string;
}

export async function loadProductFacts(service: Service, productId: string): Promise<ProductFacts> {
  const [{ data: p, error }, { data: extracts }, { data: approvals }] = await Promise.all([
    service
      .from("products")
      .select("id, name, shop_code, kind, price, stock_status, url, detail_image_urls, product_analyses(summary, claims, uncertainties, health_functional)")
      .eq("id", productId)
      .maybeSingle(),
    service.from("product_image_extracts").select("image_index, text").eq("product_id", productId).order("image_index"),
    service.from("product_claim_approvals").select("claim").eq("product_id", productId),
  ]);
  if (error) throw new Error(error.message);
  if (!p) throw new Error("상품 없음");
  const an = p.product_analyses;
  const summary = (an?.summary ?? {}) as { oneLine?: string; usage?: string; cautions?: string; details?: Record<string, unknown> };
  const claims = (Array.isArray(an?.claims) ? an.claims : []) as { claim: string; quote: string }[];
  const kind = (p.kind ?? "OTHER") as ProductKind;
  return {
    id: p.id,
    name: videoProductName(p.name),
    rawName: p.name,
    shop: SHOPS[p.shop_code as ShopCode]?.name ?? p.shop_code,
    kind,
    kindLabel: KIND_LABEL[kind],
    price: p.price,
    stockStatus: p.stock_status,
    url: p.url,
    detailImages: p.detail_image_urls.length,
    oneLine: summary.oneLine ?? null,
    usage: summary.usage ?? null,
    cautions: summary.cautions ?? null,
    details: summary.details ?? {},
    claims: claims.map((c) => ({ claim: c.claim, quote: c.quote })),
    uncertainties: an?.uncertainties ?? [],
    healthFunctional: an?.health_functional ?? null,
    approvedClaims: (approvals ?? []).map((a) => a.claim),
    certifiedFunctions: Array.isArray(summary.details?.certifiedFunctions) ? (summary.details.certifiedFunctions as string[]) : [],
    sourceText: (extracts ?? []).map((e) => e.text).join("\n").slice(0, 6000),
  };
}

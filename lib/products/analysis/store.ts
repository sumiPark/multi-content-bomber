import { analysisModel, type TokenUsage } from "@/lib/products/analysis/analyze";
import { analyzeProduct, type AnalysisResult, type StoredExtract } from "@/lib/products/analysis/run";
import type { ProductKind, ShopCode } from "@/lib/products/shops";
import { mustOk, warnIfError } from "@/lib/supabase/result";
import type { createServiceClient } from "@/lib/supabase/service";
import type { Database, Json } from "@/types/database";

// 상품 하나를 분석해 저장한다 — 분석 워커(worker/analyze-products.ts)와 AI 상품 고르기(lib/agents/select.ts)가 같이 쓴다.
// 읽은 이미지는 하나씩 바로 저장해서, 중간에 죽어도 다음 분석이 읽은 이미지를 건너뛴다.
// 서버 액션(Vercel 60초)에서는 부르지 않는다 — 상품 하나에 1~2분 걸린다. 화면은 requestAnalysis(on-demand.ts)로 워커를 깨운다.

type Service = ReturnType<typeof createServiceClient>;
export type ProductRow = Database["public"]["Tables"]["products"]["Row"];

export const ANALYSIS_LOCK_MINUTES = 30;
const MAX_ATTEMPTS = 3;

// OpenAI 크레딧 · 한도 소진 — 상품 문제가 아니라 계정 문제라 그 상품의 실패로 세지 않고 멈춘다.
// (2026-11-03 크레딧이 바닥난 채로 돌아 대기 상품이 줄줄이 "실패"로 쌓일 뻔했다.)
export class QuotaExhaustedError extends Error {}

function isQuotaError(err: unknown): boolean {
  const e = err as { status?: number; code?: string; error?: { code?: string; type?: string } };
  const code = e?.code ?? e?.error?.code ?? e?.error?.type;
  return e?.status === 429 && (code === "insufficient_quota" || code === "credit_balance_exhausted");
}

async function saveResult(service: Service, product: ProductRow, r: AnalysisResult) {
  const { data: prev } = await service
    .from("product_analyses")
    .select("edited")
    .eq("product_id", product.id)
    .maybeSingle();

  // 사람이 고친 요약은 덮어쓰지 않는다 — 상세페이지가 바뀌었으니 다시 보라고만 남긴다.
  if (prev?.edited) {
    mustOk(
      await service
        .from("products")
        .update({
          analysis_state: "review",
          analysis_note: "사람이 고친 요약이 있어 새 분석으로 덮어쓰지 않았어요. 상세페이지가 바뀌었는지 확인해 주세요.",
          analysis_error: null,
          analysis_locked_until: null,
        })
        .eq("id", product.id),
      `상품 분석 상태 저장 (id=${product.id})`,
    );
    return "review";
  }

  const { error } = await service.from("product_analyses").upsert({
    product_id: product.id,
    kind: product.kind ?? "OTHER",
    summary: (r.summary ?? {}) as unknown as Json,
    claims: r.claims as unknown as Json,
    rejected_claims: r.rejectedClaims as unknown as Json,
    health_functional: r.healthFunctional,
    functional_claims: r.functionalClaims,
    uncertainties: r.uncertainties,
    model: r.model,
    source_hash: product.source_hash,
    analyzed_at: new Date().toISOString(),
    approved_by: null,
    approved_at: null,
  });
  if (error) throw new Error(`product_analyses 저장 실패: ${error.message}`);

  mustOk(
    await service
      .from("products")
      .update({
        analysis_state: r.state,
        analysis_note: r.reason,
        analysis_error: null,
        analysis_locked_until: null,
      })
      .eq("id", product.id),
    `상품 분석 상태 저장 (id=${product.id})`,
  );
  return r.state;
}

/**
 * 이미 잡아 둔(analyzing) 상품을 분석해 저장하고 결과 상태를 돌려준다. 실패하면 "error".
 * 크레딧 · 한도 소진이면 상품을 queued로 되돌리고 QuotaExhaustedError를 던진다.
 * @param onFailState 실패했을 때 돌아갈 상태 — 분석 워커는 queued(다시 시도), AI 상품 고르기는 pending(분석 전)
 */
export async function analyzeClaimedProduct(
  service: Service,
  product: ProductRow,
  usage: TokenUsage,
  onFailState: "queued" | "pending" = "queued",
): Promise<string> {
  try {
    const { data: rows } = await service.from("product_image_extracts").select("*").eq("product_id", product.id);
    const reuse = new Map<string, StoredExtract>();
    for (const e of rows ?? []) {
      reuse.set(e.image_url, {
        imageUrl: e.image_url,
        imageIndex: e.image_index,
        text: e.text,
        facts: ((e.data as { facts?: StoredExtract["facts"] })?.facts ?? []),
        ingredients: ((e.data as { ingredients?: string[] })?.ingredients ?? []),
        fullIngredientsVisible: !!(e.data as { fullIngredientsVisible?: boolean })?.fullIngredientsVisible,
        uncertainties: e.uncertainties,
        partCount: e.part_count,
        width: e.width,
        height: e.height,
      });
    }
    // 상세페이지에서 빠진 이미지의 추출 결과는 지운다.
    const stale = [...reuse.keys()].filter((u) => !product.detail_image_urls.includes(u));
    if (stale.length) {
      warnIfError(
        await service.from("product_image_extracts").delete().eq("product_id", product.id).in("image_url", stale),
        `빠진 이미지 추출 결과 삭제 (product=${product.id})`,
      );
    }

    const r = await analyzeProduct(
      {
        shop: product.shop_code as ShopCode,
        kind: (product.kind ?? "OTHER") as ProductKind,
        name: product.name,
        summaryTitle: product.summary_title,
        categoryName: product.category_name,
        detailImageUrls: product.detail_image_urls,
      },
      usage,
      reuse,
      async (e) => {
        const { error } = await service.from("product_image_extracts").upsert({
          product_id: product.id,
          image_url: e.imageUrl,
          image_index: e.imageIndex,
          text: e.text,
          data: { facts: e.facts, ingredients: e.ingredients, fullIngredientsVisible: e.fullIngredientsVisible } as unknown as Json,
          uncertainties: e.uncertainties,
          part_count: e.partCount,
          width: e.width,
          height: e.height,
          model: analysisModel(),
          analyzed_at: new Date().toISOString(),
        });
        if (error) throw new Error(`product_image_extracts 저장 실패: ${error.message}`);
      },
    );
    return await saveResult(service, product, r);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isQuotaError(err)) {
      // 시도 횟수는 그대로 두고 되돌린다 — 크레딧을 채우면 다음에 그대로 이어 간다.
      warnIfError(
        await service
          .from("products")
          .update({ analysis_state: onFailState, analysis_error: null, analysis_locked_until: null })
          .eq("id", product.id),
        `상품 분석 되돌리기 (id=${product.id})`,
      );
      throw new QuotaExhaustedError(`OpenAI 크레딧 · 한도 소진 — 분석을 멈춤: ${message.slice(0, 200)}`);
    }
    const attempts = product.analysis_attempts + 1;
    warnIfError(
      await service
        .from("products")
        .update({
          analysis_state: attempts >= MAX_ATTEMPTS ? "failed" : onFailState,
          analysis_attempts: attempts,
          analysis_next_at: new Date(Date.now() + attempts * 10 * 60_000).toISOString(),
          analysis_error: message.slice(0, 500),
          analysis_locked_until: null,
        })
        .eq("id", product.id),
      `상품 분석 실패 기록 (id=${product.id})`,
    );
    console.error(`[product-analysis] ${product.shop_code} ${product.shop_product_id} 실패(${attempts}회): ${message}`);
    return "error";
  }
}

/**
 * AI 상품 고르기에서 고른 상품을 그 자리에서 분석한다(워커 전용 — 1~2분).
 * 이미 분석이 끝났으면 바로 그 상태를, 다른 분석기가 잡고 있으면 끝날 때까지(최대 5분) 기다린 뒤 상태를 돌려준다.
 */
export async function analyzeNow(service: Service, productId: string, usage: TokenUsage): Promise<string> {
  const now = new Date().toISOString();
  const { data: claimed, error } = await service
    .from("products")
    .update({
      analysis_state: "analyzing",
      analysis_locked_until: new Date(Date.now() + ANALYSIS_LOCK_MINUTES * 60_000).toISOString(),
    })
    .eq("id", productId)
    .or(`analysis_state.in.(pending,queued),and(analysis_state.eq.analyzing,analysis_locked_until.lt.${now})`)
    .select("*");
  if (error) throw new Error(`상품 분석 잡기 실패: ${error.message}`);
  if (claimed?.length) return analyzeClaimedProduct(service, claimed[0] as ProductRow, usage, "pending");

  // 이미 끝났거나 다른 분석기가 잡고 있다
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    const { data } = await service.from("products").select("analysis_state").eq("id", productId).maybeSingle();
    const state = data?.analysis_state ?? "missing";
    if (state !== "analyzing" || Date.now() > deadline) return state;
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

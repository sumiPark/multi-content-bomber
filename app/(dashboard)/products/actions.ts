"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile, getSessionUser } from "@/lib/auth";
import { triggerProductsRun } from "@/lib/github-dispatch";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// 상품 · 상세페이지 분석 관리 (0025). 상품 테이블은 authenticated에 쓰기 정책이 없어
// service_role로 쓰고, 권한(ADMIN/MANAGER)은 여기서 직접 확인한다.

export type ProductActionResult = { ok: true } | { ok: false; error: string };

async function authorize(): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "로그인이 필요합니다." };
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) return { ok: false, error: "소속된 조직이 없습니다." };
  if (profile.role !== "ADMIN" && profile.role !== "MANAGER") {
    return { ok: false, error: "상품 관리 권한이 없습니다." };
  }
  return { ok: true, userId: user.id };
}

function refresh(productId?: string) {
  revalidatePath("/products");
  if (productId) revalidatePath(`/products/${productId}`);
}

/** "지금 수집" — 상품 수집 + 이어서 상세페이지 분석 워크플로를 깨운다. */
export async function collectProductsNowAction(): Promise<ProductActionResult> {
  const auth = await authorize();
  if (!auth.ok) return auth;
  try {
    await triggerProductsRun(`manual:${auth.userId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "수집 시작 실패" };
  }
}

const idSchema = z.object({ productId: z.string().uuid() });

/** 사람이 분석 결과를 확인함 → ready(후보). 건기식 기능성 문구 확정은 표현 규칙 화면에서 따로 — 둘 다 돼야 후보가 된다. */
export async function approveAnalysisAction(input: z.infer<typeof idSchema>): Promise<ProductActionResult> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;

  const service = createServiceClient();
  // 근거 있는 특징이 하나도 없으면 대본에 쓸 말이 없다 — 확인해도 후보가 되면 안 된다(2026-11-04)
  const { data: current } = await service.from("product_analyses").select("claims").eq("product_id", parsed.data.productId).maybeSingle();
  if (current && (!Array.isArray(current.claims) || current.claims.length === 0)) {
    return { ok: false, error: "상세페이지에서 근거를 찾은 특징이 없어 확인할 수 없어요. 이미지부터 다시 읽거나 이 상품을 빼 주세요." };
  }
  const { data, error } = await service
    .from("product_analyses")
    .update({ approved_by: auth.userId, approved_at: new Date().toISOString() })
    .eq("product_id", parsed.data.productId)
    .select("product_id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: "아직 분석 결과가 없습니다." };
  await service
    .from("products")
    .update({ analysis_state: "ready", analysis_note: null })
    .eq("id", parsed.data.productId);
  refresh(parsed.data.productId);
  return { ok: true };
}

const reanalyzeSchema = idSchema.extend({
  // true면 이미지 받아 적기부터 다시 (기본은 받아 둔 원문으로 요약만 다시)
  fromImages: z.boolean(),
});

/** 다시 분석 — 바로 분석 워크플로를 깨운다(판매 중인 상품만 집힌다). 사람이 고친 요약(edited)은 이때 풀린다. */
export async function reanalyzeAction(input: z.infer<typeof reanalyzeSchema>): Promise<ProductActionResult> {
  const parsed = reanalyzeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;

  const service = createServiceClient();
  if (parsed.data.fromImages) {
    await service.from("product_image_extracts").delete().eq("product_id", parsed.data.productId);
  }
  await service.from("product_analyses").update({ edited: false }).eq("product_id", parsed.data.productId);
  const { error } = await service
    .from("products")
    .update({
      analysis_state: "queued",
      analysis_attempts: 0,
      analysis_next_at: new Date().toISOString(),
      analysis_error: null,
      analysis_note: null,
      analysis_locked_until: null,
    })
    .eq("id", parsed.data.productId);
  if (error) return { ok: false, error: error.message };
  // 깨우지 못해도 다음 03시 실행이 집어 간다 — 즉시성만 손해
  await triggerProductsRun(`reanalyze:${parsed.data.productId}`).catch((e) => console.error("[products] 분석 트리거 실패:", e));
  refresh(parsed.data.productId);
  return { ok: true };
}

const excludeSchema = idSchema.extend({ excluded: z.boolean() });

/** 추천 · 분석에서 빼기 / 되돌리기. */
export async function setExcludedAction(input: z.infer<typeof excludeSchema>): Promise<ProductActionResult> {
  const parsed = excludeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;

  const { error } = await createServiceClient()
    .from("products")
    .update({ excluded: parsed.data.excluded })
    .eq("id", parsed.data.productId);
  if (error) return { ok: false, error: error.message };
  refresh(parsed.data.productId);
  return { ok: true };
}

const editSchema = idSchema.extend({
  oneLine: z.string().max(200),
  usage: z.string().max(2000),
  cautions: z.string().max(2000),
  // 남길 특징의 순번 (지운 건 빠진다)
  keepClaims: z.array(z.number().int().min(0)).max(50),
});

/**
 * 요약 고치기 — 한 줄 소개 · 사용법 · 주의사항을 고치고, 쓰면 안 되는 특징을 지운다.
 * edited=true로 남겨 상세페이지가 바뀌어도 새 분석이 덮어쓰지 않게 한다.
 */
export async function editAnalysisAction(input: z.infer<typeof editSchema>): Promise<ProductActionResult> {
  const parsed = editSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;

  const service = createServiceClient();
  const { data: row, error: readErr } = await service
    .from("product_analyses")
    .select("summary, claims")
    .eq("product_id", parsed.data.productId)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!row) return { ok: false, error: "아직 분석 결과가 없습니다." };

  const summary = { ...(row.summary as Record<string, unknown>) };
  summary.oneLine = parsed.data.oneLine.trim();
  summary.usage = parsed.data.usage.trim();
  summary.cautions = parsed.data.cautions.trim();
  const claims = (Array.isArray(row.claims) ? row.claims : []).filter((_, i) =>
    parsed.data.keepClaims.includes(i),
  );

  const { error } = await service
    .from("product_analyses")
    .update({
      summary: summary as Json,
      claims: claims as Json,
      edited: true,
      approved_by: auth.userId,
      approved_at: new Date().toISOString(),
    })
    .eq("product_id", parsed.data.productId);
  if (error) return { ok: false, error: error.message };
  await service
    .from("products")
    .update({ analysis_state: "ready", analysis_note: null })
    .eq("id", parsed.data.productId);
  refresh(parsed.data.productId);
  return { ok: true };
}

const categorySchema = z.object({
  shopCode: z.enum(["cuma", "cm", "ru"]),
  categoryId: z.number().int(),
  collect: z.boolean(),
  kind: z.enum(["FRUIT", "COSMETIC", "HEALTH_FOOD", "CLOTHING", "OTHER"]).nullable(),
});

/** 수집 카테고리 켜고 끄기 · 종류 바꾸기 — 다음 수집부터 반영된다. 종류가 바뀐 상품은 그때 다시 분석한다(판매 중인 것만). */
export async function updateCategoryAction(input: z.infer<typeof categorySchema>): Promise<ProductActionResult> {
  const parsed = categorySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;

  const { error } = await createServiceClient()
    .from("shop_categories")
    .update({ collect: parsed.data.collect, kind: parsed.data.kind })
    .eq("shop_code", parsed.data.shopCode)
    .eq("category_id", parsed.data.categoryId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/products/categories");
  return { ok: true };
}

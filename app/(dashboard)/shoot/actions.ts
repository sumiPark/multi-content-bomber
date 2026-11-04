"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile, getSessionUser } from "@/lib/auth";
import { getInstagramAuth } from "@/lib/episode-alerts/server";
import { triggerShootEditRun, triggerShootPlanRun, triggerShotlistRun } from "@/lib/github-dispatch";
import { listRecentMedia } from "@/lib/platforms/instagram-insights";
import type { ProductKind } from "@/lib/products/shops";
import type { ContentRule } from "@/lib/rules/check";
import { duplicateWarning } from "@/lib/shoot/duplicates";
import { certifiedFunctionsOf, finalBlocking } from "@/lib/shoot/final-check";
import { buildPackageTexts, safeFileName, type PackageCut, type PackageScript, type PackageSegment, type TextFile } from "@/lib/shoot/package";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// 직접 촬영 콘텐츠(0030 · 0042). 계정별 기획 목록에서 고르거나 원하는 상품을 추가 → 컷 리스트(워커) →
// 컷마다 촬영본을 올리고 "다 올렸어요" → 자동 편집 → 완성본 · 다시 편집용 파일 받기 → 사람이 직접 올리고 "올렸어요" + 릴스 연결.
// 자동 예약은 없다. 고르기 · 추가 · 새로 고침은 ADMIN · MANAGER, 촬영본 올리기 · 받기 · 올렸어요는 조직 누구나.

export type ShootResult = { ok: true } | { ok: false; error: string; warning?: boolean };
type Service = ReturnType<typeof createServiceClient>;

async function authorize(level: "plan" | "shoot"): Promise<{ ok: true; userId: string; orgId: string } | { ok: false; error: string }> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "로그인이 필요합니다." };
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) return { ok: false, error: "소속된 조직이 없습니다." };
  if (level === "plan" && profile.role !== "ADMIN" && profile.role !== "MANAGER") {
    return { ok: false, error: "기획을 고를 권한이 없습니다." };
  }
  return { ok: true, userId: user.id, orgId: profile.organization_id };
}

async function loadPlan(service: Service, planId: string, orgId: string) {
  const { data } = await service
    .from("content_plans")
    .select("id, status, product_id, proposal, social_account_id, shoot_requests(id, clips)")
    .eq("id", planId)
    .eq("organization_id", orgId)
    .eq("track", "A")
    .maybeSingle();
  return data;
}

async function accountSettings(service: Service, accountId: string, orgId: string) {
  const { data } = await service
    .from("track_settings")
    .select("product_scopes, repeat_gap_days, shoot_enabled")
    .eq("social_account_id", accountId)
    .eq("organization_id", orgId)
    .maybeSingle();
  return data;
}

function revalidateShoot() {
  revalidatePath("/shoot/plans");
  revalidatePath("/shoot/uploads");
  revalidatePath("/shoot/review");
}

const chooseSchema = z.object({ planId: z.string().uuid(), force: z.boolean().optional() });

/** 목록의 기획으로 찍기 — 컷 리스트를 쓰게 한다. 다른 계정과 겹치거나 최근에 쓴 상품이면 경고 뒤 진행(force). */
export async function chooseIdeaAction(input: z.infer<typeof chooseSchema>): Promise<ShootResult> {
  const parsed = chooseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize("plan");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const plan = await loadPlan(service, parsed.data.planId, auth.orgId);
  if (!plan) return { ok: false, error: "기획을 찾을 수 없습니다." };
  if (plan.status !== "PROPOSED") return { ok: false, error: "이미 고른 기획이에요. 새로 고쳐 주세요." };
  if (!plan.product_id) return { ok: false, error: "상품이 없는 기획이에요." };

  const { data: product } = await service.from("products").select("stock_status, excluded").eq("id", plan.product_id).maybeSingle();
  if (!product || product.stock_status !== "available" || product.excluded) return { ok: false, error: "지금 판매 중이 아닌 상품이에요. 다른 기획을 골라 주세요." };

  if (!parsed.data.force) {
    const settings = await accountSettings(service, plan.social_account_id, auth.orgId);
    const warning = await duplicateWarning(service, { accountId: plan.social_account_id, productId: plan.product_id, excludePlanId: plan.id, gapDays: settings?.repeat_gap_days ?? 14 });
    if (warning) return { ok: false, error: warning, warning: true };
  }

  const proposal = { ...((plan.proposal ?? {}) as Record<string, unknown>), chosen: 0 };
  const { data: moved, error } = await service
    .from("content_plans")
    .update({ status: "CONFIRMED", proposal: proposal as unknown as Json, note: null, error: null, confirmed_by: auth.userId, confirmed_at: new Date().toISOString() })
    .eq("id", plan.id)
    .eq("status", "PROPOSED")
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!moved?.length) return { ok: false, error: "이미 고른 기획이에요. 새로 고쳐 주세요." };
  // 실패해도 다음 05시 실행이 집어 간다 — 즉시성만 손해
  await triggerShotlistRun(`plan ${plan.id}`).catch((e) => console.error("[shoot] 컷 리스트 트리거 실패:", e));
  revalidateShoot();
  return { ok: true };
}

const wantedSchema = z.object({
  accountId: z.string().uuid(),
  productId: z.string().uuid(),
  brief: z.string().trim().max(300).nullable(),
  force: z.boolean().optional(),
});

/** 원하는 상품 추가 (+ 찍고 싶은 것 메모) — 고른 것과 같아서 바로 컷 리스트를 쓴다. 목록 5개와 상관없다. */
export async function addWantedProductAction(input: z.infer<typeof wantedSchema>): Promise<ShootResult> {
  const parsed = wantedSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize("plan");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const settings = await accountSettings(service, parsed.data.accountId, auth.orgId);
  if (!settings) return { ok: false, error: "촬영 설정에 없는 계정이에요." };

  const { data: product } = await service
    .from("products")
    .select("id, shop_code, kind, stock_status, excluded, analysis_state")
    .eq("id", parsed.data.productId)
    .maybeSingle();
  if (!product) return { ok: false, error: "상품을 찾을 수 없습니다." };
  const scopes = (settings.product_scopes ?? []) as { shop: string; kind: string }[];
  if (!scopes.some((s) => s.shop === product.shop_code && s.kind === product.kind)) return { ok: false, error: "이 계정에서 쓰지 않는 상품 종류예요." };
  if (product.stock_status !== "available" || product.excluded) return { ok: false, error: "지금 판매 중인 상품만 고를 수 있어요." };
  if (product.analysis_state !== "ready") return { ok: false, error: "상세페이지 분석이 끝난 상품만 고를 수 있어요." };

  if (!parsed.data.force) {
    const warning = await duplicateWarning(service, { accountId: parsed.data.accountId, productId: product.id, gapDays: settings.repeat_gap_days });
    if (warning) return { ok: false, error: warning, warning: true };
  }

  const { data: inserted, error } = await service
    .from("content_plans")
    .insert({
      organization_id: auth.orgId,
      social_account_id: parsed.data.accountId,
      track: "A",
      status: "CONFIRMED",
      product_id: product.id,
      product_changed: true,
      human_brief: parsed.data.brief || null,
      proposal: { ideas: [], chosen: null } as unknown as Json,
      confirmed_by: auth.userId,
      confirmed_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !inserted) return { ok: false, error: error?.message ?? "저장하지 못했어요." };
  await triggerShotlistRun(`plan ${inserted.id}`).catch((e) => console.error("[shoot] 컷 리스트 트리거 실패:", e));
  revalidateShoot();
  return { ok: true };
}

export interface ProductHit {
  id: string;
  name: string;
  price: number | null;
  image: string | null;
  oneLine: string | null;
}

const searchSchema = z.object({ accountId: z.string().uuid(), query: z.string().trim().min(1).max(50) });

/** 원하는 상품 찾기 — 이 계정이 쓰는 몰 · 종류, 판매 중, 분석 완료만. */
export async function searchProductsAction(
  input: z.infer<typeof searchSchema>,
): Promise<{ ok: true; hits: ProductHit[] } | { ok: false; error: string }> {
  const parsed = searchSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "검색어를 입력하세요." };
  const auth = await authorize("plan");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const settings = await accountSettings(service, parsed.data.accountId, auth.orgId);
  if (!settings) return { ok: false, error: "촬영 설정에 없는 계정이에요." };

  const pattern = `%${parsed.data.query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const hits: ProductHit[] = [];
  for (const scope of (settings.product_scopes ?? []) as { shop: string; kind: string }[]) {
    const { data } = await service
      .from("products")
      .select("id, name, price, represent_image_url, product_analyses(summary)")
      .eq("shop_code", scope.shop)
      .eq("kind", scope.kind)
      .eq("stock_status", "available")
      .eq("excluded", false)
      .eq("analysis_state", "ready")
      .ilike("name", pattern)
      .limit(12);
    for (const p of data ?? []) {
      hits.push({
        id: p.id,
        name: p.name,
        price: p.price,
        image: p.represent_image_url,
        oneLine: (p.product_analyses?.summary as { oneLine?: string } | null)?.oneLine ?? null,
      });
    }
  }
  return { ok: true, hits: hits.slice(0, 12) };
}

const accountSchema = z.object({ accountId: z.string().uuid() });

/** 계정 기획 목록 새로 고침 — 고르기 전 기획을 모두 빼고 기획 워커를 부른다. 지운 상품은 한동안 다시 내지 않는다. */
export async function refreshIdeasAction(input: z.infer<typeof accountSchema>): Promise<ShootResult> {
  const parsed = accountSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize("plan");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const settings = await accountSettings(service, parsed.data.accountId, auth.orgId);
  if (!settings?.shoot_enabled) return { ok: false, error: "촬영 설정에서 켠 계정만 새로 고칠 수 있어요." };
  const { error } = await service
    .from("content_plans")
    .update({ status: "SKIPPED", note: "목록을 새로 고쳐 뺐어요" })
    .eq("social_account_id", parsed.data.accountId)
    .eq("organization_id", auth.orgId)
    .eq("track", "A")
    .eq("status", "PROPOSED");
  if (error) return { ok: false, error: error.message };
  try {
    await triggerShootPlanRun(`refresh ${parsed.data.accountId}`);
  } catch (e) {
    console.error("[shoot] 기획 트리거 실패:", e);
    revalidateShoot();
    return { ok: false, error: "목록을 비웠지만 새 기획 만들기를 시작하지 못했어요. 내일 새벽 5시에 다시 채워져요." };
  }
  revalidateShoot();
  return { ok: true };
}

const idSchema = z.object({ planId: z.string().uuid() });

/** 목록에서 기획 하나 지우기 — 다음 새벽에 부족한 만큼 채워진다. */
export async function dismissIdeaAction(input: z.infer<typeof idSchema>): Promise<ShootResult> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize("plan");
  if (!auth.ok) return auth;
  const { data, error } = await createServiceClient()
    .from("content_plans")
    .update({ status: "SKIPPED", note: "사람이 목록에서 지움" })
    .eq("id", parsed.data.planId)
    .eq("organization_id", auth.orgId)
    .eq("track", "A")
    .eq("status", "PROPOSED")
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: "이미 고르거나 지운 기획이에요. 새로 고쳐 주세요." };
  revalidateShoot();
  return { ok: true };
}

/** 진행 중인 기획 빼기 (올렸어요 전까지) — 올린 촬영본도 함께 멈춘다. */
export async function skipShootAction(input: z.infer<typeof idSchema>): Promise<ShootResult> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize("plan");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const plan = await loadPlan(service, parsed.data.planId, auth.orgId);
  if (!plan) return { ok: false, error: "기획을 찾을 수 없습니다." };
  if (["PUBLISHED", "SKIPPED"].includes(plan.status)) return { ok: false, error: "뺄 수 없는 기획입니다." };
  const { error } = await service.from("content_plans").update({ status: "SKIPPED", note: "사람이 건너뜀" }).eq("id", plan.id);
  if (error) return { ok: false, error: error.message };
  if (plan.shoot_requests) await service.from("shoot_requests").update({ status: "CANCELLED" }).eq("id", plan.shoot_requests.id);
  revalidateShoot();
  return { ok: true };
}

// ─── 촬영 · 올리기 ────────────────────────────────────────────────────────────

type Cut = { no: number; done?: boolean; skipped?: boolean } & Record<string, unknown>;
type Clip = { cut: number; path: string; name: string; size: number; type: string; uploaded_at: string; uploaded_by: string };

async function loadRequest(service: Service, requestId: string, orgId: string) {
  const { data } = await service
    .from("shoot_requests")
    .select("id, plan_id, status, cuts, clips, updated_at")
    .eq("id", requestId)
    .eq("organization_id", orgId)
    .maybeSingle();
  return data;
}

type LoadedRequest = NonNullable<Awaited<ReturnType<typeof loadRequest>>>;

/**
 * 촬영 요청의 cuts · clips(jsonb)를 읽고 → 고쳐 → 저장. 저장할 때 updated_at이 읽은 때와 같아야 한다 —
 * 휴대폰에서 컷 여러 개를 연달아 올리면 등록이 비슷한 때 끝나, 예전엔 서로 덮어써 한 컷의 등록이 빠졌다(2026-11-04).
 * 그사이 누가 바꿨으면 다시 읽어 다시 고친다(최대 5번). mutate가 문자열을 돌려주면 그 이유로 멈춘다.
 */
async function updateRequestJson(
  service: Service,
  requestId: string,
  orgId: string,
  mutate: (req: LoadedRequest) => { patch: { cuts?: Json; clips?: Json }; after?: () => Promise<void> } | string,
): Promise<ShootResult> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const req = await loadRequest(service, requestId, orgId);
    if (!req) return { ok: false, error: "촬영 요청을 찾을 수 없어요. 기획이 바뀌었을 수 있으니 새로 고쳐 주세요." };
    const r = mutate(req);
    if (typeof r === "string") return { ok: false, error: r };
    const { data, error } = await service
      .from("shoot_requests")
      .update(r.patch)
      .eq("id", req.id)
      .eq("updated_at", req.updated_at)
      .select("id");
    if (error) return { ok: false, error: error.message };
    if (data?.length) {
      await r.after?.();
      return { ok: true };
    }
  }
  return { ok: false, error: "다른 컷 저장과 겹쳤어요. 잠시 뒤 다시 해 주세요." };
}

const cutSchema = z.object({ requestId: z.string().uuid(), no: z.number().int().min(1).max(20), done: z.boolean() });

/** 찍은 컷 체크. */
export async function toggleCutAction(input: z.infer<typeof cutSchema>): Promise<ShootResult> {
  const parsed = cutSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize("shoot");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const r = await updateRequestJson(service, parsed.data.requestId, auth.orgId, (req) => {
    const cuts = ((req.cuts ?? []) as Cut[]).map((c) => (c.no === parsed.data.no ? { ...c, done: parsed.data.done } : c));
    return { patch: { cuts: cuts as unknown as Json } };
  });
  if (!r.ok) return r;
  revalidatePath("/shoot/uploads");
  return { ok: true };
}

const skipCutSchema = z.object({ requestId: z.string().uuid(), no: z.number().int().min(1).max(20), skipped: z.boolean() });

/**
 * 못 찍는 컷 빼기 / 되돌리기. 예전엔 한 컷이라도 못 찍으면 "다 올렸어요"를 못 눌러 칸 전체가 멈췄다(2026-11-04).
 * 찍는 사람이 현장에서 판단하니 촬영 권한으로 되고, 뺀 컷은 완성본 받기에 표시돼 사람이 본다.
 */
export async function skipCutAction(input: z.infer<typeof skipCutSchema>): Promise<ShootResult> {
  const parsed = skipCutSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize("shoot");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const r = await updateRequestJson(service, parsed.data.requestId, auth.orgId, (req) => {
    if (req.status !== "OPEN") return "이미 편집으로 넘어간 촬영 요청입니다.";
    const cuts = (req.cuts ?? []) as Cut[];
    if (parsed.data.skipped && !cuts.some((c) => c.no !== parsed.data.no && !c.skipped)) return "컷을 모두 뺄 수는 없어요. 찍지 못하면 촬영 기획 고르기에서 이 기획을 빼 주세요.";
    const clips = (req.clips ?? []) as Clip[];
    const old = parsed.data.skipped ? clips.filter((c) => c.cut === parsed.data.no) : [];
    return {
      patch: {
        cuts: cuts.map((c) => (c.no === parsed.data.no ? { ...c, skipped: parsed.data.skipped, done: false } : c)) as unknown as Json,
        ...(old.length ? { clips: clips.filter((c) => c.cut !== parsed.data.no) as unknown as Json } : {}),
      },
      after: async () => {
        if (old.length) await service.storage.from("media").remove(old.map((c) => c.path));
      },
    };
  });
  if (!r.ok) return r;
  revalidatePath("/shoot/uploads");
  return { ok: true };
}

const MAX_CLIP_BYTES = 1024 * 1024 * 1024; // media 버킷 한도(0014)와 같게

const clipSchema = z.object({
  requestId: z.string().uuid(),
  cut: z.number().int().min(1).max(20),
  path: z.string().min(1).max(300),
  name: z.string().max(200),
  size: z.number().int().min(1).max(MAX_CLIP_BYTES),
  type: z.string().max(100),
});

/** 컷 촬영본 등록 — 브라우저가 media 버킷에 올린 뒤 부른다. 같은 컷에 다시 올리면 이전 파일은 지운다. */
export async function addClipAction(input: z.infer<typeof clipSchema>): Promise<ShootResult> {
  const parsed = clipSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize("shoot");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const r = await updateRequestJson(service, parsed.data.requestId, auth.orgId, (req) => {
    if (req.status !== "OPEN") return "이미 편집으로 넘어간 촬영 요청입니다.";
    if (!parsed.data.path.startsWith(`${auth.orgId}/${auth.userId}/shoot/${req.id}/`)) return "잘못된 파일 경로";
    const cuts = (req.cuts ?? []) as Cut[];
    if (!cuts.some((c) => c.no === parsed.data.cut)) return "없는 컷입니다.";
    const clips = (req.clips ?? []) as Clip[];
    const old = clips.filter((c) => c.cut === parsed.data.cut && c.path !== parsed.data.path);
    const next: Clip[] = [
      ...clips.filter((c) => c.cut !== parsed.data.cut),
      {
        cut: parsed.data.cut,
        path: parsed.data.path,
        name: parsed.data.name,
        size: parsed.data.size,
        type: parsed.data.type,
        uploaded_at: new Date().toISOString(),
        uploaded_by: auth.userId,
      },
    ].sort((a, b) => a.cut - b.cut);
    const nextCuts = cuts.map((c) => (c.no === parsed.data.cut ? { ...c, done: true, skipped: false } : c));
    return {
      patch: { clips: next as unknown as Json, cuts: nextCuts as unknown as Json },
      // 같은 컷의 예전 촬영본은 저장이 된 뒤에만 지운다
      after: async () => {
        if (old.length) await service.storage.from("media").remove(old.map((c) => c.path));
      },
    };
  });
  if (!r.ok) return r;
  revalidatePath("/shoot/uploads");
  return { ok: true };
}

const removeSchema = z.object({ requestId: z.string().uuid(), cut: z.number().int().min(1).max(20) });

export async function removeClipAction(input: z.infer<typeof removeSchema>): Promise<ShootResult> {
  const parsed = removeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize("shoot");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const r = await updateRequestJson(service, parsed.data.requestId, auth.orgId, (req) => {
    if (req.status !== "OPEN") return "이미 편집으로 넘어간 촬영 요청입니다.";
    const clips = (req.clips ?? []) as Clip[];
    const old = clips.filter((c) => c.cut === parsed.data.cut);
    // 촬영본을 지우면 "찍음" 표시도 푼다(예전엔 체크가 남아 올린 수와 어긋났다)
    const cuts = ((req.cuts ?? []) as Cut[]).map((c) => (c.no === parsed.data.cut ? { ...c, done: false } : c));
    return {
      patch: { clips: clips.filter((c) => c.cut !== parsed.data.cut) as unknown as Json, cuts: cuts as unknown as Json },
      after: async () => {
        if (old.length) await service.storage.from("media").remove(old.map((c) => c.path));
      },
    };
  });
  if (!r.ok) return r;
  revalidatePath("/shoot/uploads");
  return { ok: true };
}

const finishSchema = z.object({ requestId: z.string().uuid() });

/** 다 올렸어요 → 편집 대기. 뺀 컷을 뺀 컷마다 촬영본이 있어야 한다. */
export async function finishUploadAction(input: z.infer<typeof finishSchema>): Promise<ShootResult> {
  const parsed = finishSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize("shoot");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const req = await loadRequest(service, parsed.data.requestId, auth.orgId);
  if (!req) return { ok: false, error: "촬영 요청을 찾을 수 없습니다." };
  if (req.status !== "OPEN") return { ok: false, error: "이미 편집으로 넘어간 촬영 요청입니다." };
  const cuts = (req.cuts ?? []) as Cut[];
  const clips = (req.clips ?? []) as Clip[];
  const active = cuts.filter((c) => !c.skipped);
  if (!active.length) return { ok: false, error: "남은 컷이 없어요. 뺀 컷을 되돌려 주세요." };
  const missing = active.filter((c) => !clips.some((k) => k.cut === c.no)).map((c) => c.no);
  if (missing.length) return { ok: false, error: `${missing.join(", ")}번 컷 촬영본이 아직 없어요.` };

  const { data: moved, error } = await service
    .from("shoot_requests")
    .update({ status: "UPLOADED", uploaded_at: new Date().toISOString(), error: null })
    .eq("id", req.id)
    .eq("status", "OPEN")
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!moved?.length) return { ok: false, error: "이미 편집으로 넘어간 촬영 요청입니다." };
  await service.from("content_plans").update({ status: "SHOT" }).eq("id", req.plan_id).in("status", ["SCRIPTED", "SHOT"]);
  // 실패해도 한 시간마다 도는 편집 sweep이 집어 간다 — 즉시성만 손해
  await triggerShootEditRun(`request ${req.id}`).catch((e) => console.error("[shoot] 편집 트리거 실패:", e));
  revalidatePath("/shoot/uploads");
  revalidatePath("/shoot/plans");
  return { ok: true };
}

// ─── 완성본 받기 ──────────────────────────────────────────────────────────────

/** 상품 분석의 건강기능식품 판정 — 관계가 객체 · 배열 어느 쪽으로 와도. 없으면 null. */
function healthFunctionalOf(a: unknown): boolean | null {
  const row = (Array.isArray(a) ? a[0] : a) as { health_functional?: boolean | null } | null | undefined;
  return row?.health_functional ?? null;
}

type EditResult = { segments?: { cut: number; onScreen: string; subtitles: { text: string }[] }[] };
type SavedCaption = { caption?: { text: string; keywords?: string[] } };

const captionSchema = z.object({ planId: z.string().uuid(), caption: z.string().trim().min(1).max(2200) });

/** 캡션 고치기 — 완성본을 다시 만들 필요 없이 바로 저장. */
export async function saveCaptionAction(input: z.infer<typeof captionSchema>): Promise<ShootResult> {
  const parsed = captionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "캡션을 확인해 주세요 (2,200자 이내)." };
  const auth = await authorize("plan");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const { data: plan } = await service
    .from("content_plans")
    .select("id, status, script")
    .eq("id", parsed.data.planId)
    .eq("organization_id", auth.orgId)
    .eq("track", "A")
    .maybeSingle();
  if (!plan) return { ok: false, error: "기획을 찾을 수 없습니다." };
  if (!["SCRIPTED", "SHOT", "RENDERED"].includes(plan.status)) return { ok: false, error: "이미 올린 기획은 고칠 수 없어요." };
  const script = (plan.script ?? {}) as SavedCaption & Record<string, unknown>;
  const next = { ...script, caption: { ...(script.caption ?? { keywords: [] }), text: parsed.data.caption }, caption_edited: true };
  const { error } = await service.from("content_plans").update({ script: next as unknown as Json }).eq("id", plan.id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/shoot/review");
  return { ok: true };
}

const reEditSchema = z.object({
  requestId: z.string().uuid(),
  cuts: z
    // subtitle을 안 보내면 그 컷 자막은 그대로(말한 시각에 맞춘 자막 유지), 보내면 그 글로 바꾼다
    .array(z.object({ no: z.number().int().min(1).max(20), onScreen: z.string().max(40), subtitle: z.string().max(120).optional() }))
    .max(20),
  // 사람이 직접 넣는 후킹 · 표지 문구. 안 보내면 그대로, 빈 문자열이면 AI가 정한다
  hook: z.string().trim().max(40).optional(),
  thumbnail: z.string().trim().max(24).optional(),
});

const humanTextSchema = z.object({
  planId: z.string().uuid(),
  hook: z.string().trim().max(40),
  thumbnail: z.string().trim().max(24),
});

/** 대본(content_plans.script)에 사람이 정한 후킹 · 표지 문구를 저장한다. 편집 에이전트가 글자 그대로 쓴다. */
async function saveHumanText(service: Service, planId: string, patch: { hook?: string; thumbnail?: string }): Promise<string | null> {
  const { data: row, error } = await service.from("content_plans").select("script").eq("id", planId).maybeSingle();
  if (error) return error.message;
  const script = (row?.script ?? {}) as Record<string, unknown>;
  const human = { ...((script.human ?? {}) as { hook?: string; thumbnail?: string }), ...patch };
  const { error: upErr } = await service
    .from("content_plans")
    .update({ script: { ...script, human } as unknown as Json })
    .eq("id", planId);
  return upErr?.message ?? null;
}

/** 촬영 · 올리기 화면의 후킹 · 표지 문구 저장. 비워 두면 AI가 만든다. */
export async function saveHumanTextAction(input: z.infer<typeof humanTextSchema>): Promise<ShootResult> {
  const parsed = humanTextSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "후킹은 40자, 표지는 24자까지 넣을 수 있어요." };
  const auth = await authorize("shoot");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const { data: plan } = await service.from("content_plans").select("id, status").eq("id", parsed.data.planId).eq("organization_id", auth.orgId).eq("track", "A").maybeSingle();
  if (!plan) return { ok: false, error: "기획을 찾을 수 없습니다." };
  if (plan.status === "PUBLISHED") return { ok: false, error: "이미 올린 기획이에요." };
  const failed = await saveHumanText(service, plan.id, { hook: parsed.data.hook, thumbnail: parsed.data.thumbnail });
  if (failed) return { ok: false, error: failed };
  revalidatePath("/shoot/uploads");
  revalidatePath("/shoot/review");
  return { ok: true };
}

/** 고친 화면 문구 · 자막으로 다시 편집 (실패한 편집 다시 시도도 이걸로 — cuts 빈 배열). */
export async function reEditAction(input: z.infer<typeof reEditSchema>): Promise<ShootResult> {
  const parsed = reEditSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  // 완성본 받기 화면의 고치기 기능 — 화면처럼 관리자 · 매니저만(예전엔 찍는 사람도 서버에서 됐다)
  const auth = await authorize("plan");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const req = await loadRequest(service, parsed.data.requestId, auth.orgId);
  if (!req) return { ok: false, error: "촬영 요청을 찾을 수 없습니다." };
  if (req.status !== "EDITED" && req.status !== "FAILED") return { ok: false, error: "편집이 끝난 뒤에 다시 편집할 수 있어요." };
  const { data: planRow } = await service.from("content_plans").select("status").eq("id", req.plan_id).maybeSingle();
  if (!planRow || !["SHOT", "RENDERED"].includes(planRow.status)) return { ok: false, error: "이미 올렸거나 끝난 기획이라 다시 편집할 수 없어요." };
  if (parsed.data.hook !== undefined || parsed.data.thumbnail !== undefined) {
    const failed = await saveHumanText(service, req.plan_id, {
      ...(parsed.data.hook !== undefined ? { hook: parsed.data.hook } : {}),
      ...(parsed.data.thumbnail !== undefined ? { thumbnail: parsed.data.thumbnail } : {}),
    });
    if (failed) return { ok: false, error: failed };
  }
  const fix = new Map(parsed.data.cuts.map((c) => [c.no, c]));
  const cuts = ((req.cuts ?? []) as Cut[]).map((c) => {
    const f = fix.get(c.no);
    if (!f) return c;
    return { ...c, on_screen_override: f.onScreen.trim(), ...(f.subtitle === undefined ? {} : { subtitle_override: f.subtitle.trim() }) };
  });
  const { data: moved, error } = await service
    .from("shoot_requests")
    .update({ cuts: cuts as unknown as Json, status: "UPLOADED", error: null })
    .eq("id", req.id)
    .in("status", ["EDITED", "FAILED"])
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!moved?.length) return { ok: false, error: "상태가 바뀌었어요. 새로 고쳐 주세요." };
  await service.from("content_plans").update({ status: "SHOT" }).eq("id", req.plan_id).in("status", ["RENDERED", "SHOT"]);
  await triggerShootEditRun(`re-edit ${req.id}`).catch((e) => console.error("[shoot] 편집 트리거 실패:", e));
  revalidatePath("/shoot/review");
  revalidatePath("/shoot/uploads");
  return { ok: true };
}

const reopenSchema = z.object({ requestId: z.string().uuid() });

/**
 * 촬영본 다시 올리기 — 편집이 실패했거나(예: 컷이 너무 짧음) 완성본에서 컷 하나를 다시 찍고 싶을 때.
 * 요청을 촬영 중(OPEN), 기획을 촬영 대기(SCRIPTED)로 되돌린다. 올린 촬영본은 남아 있어 바꿀 컷만 다시 올리면 된다.
 * 예전엔 실패하면 같은 촬영본으로 다시 편집하거나 건너뛰는 수밖에 없었다(2026-11-04).
 */
export async function reopenShootAction(input: z.infer<typeof reopenSchema>): Promise<ShootResult> {
  const parsed = reopenSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize("plan");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const req = await loadRequest(service, parsed.data.requestId, auth.orgId);
  if (!req) return { ok: false, error: "촬영 요청을 찾을 수 없습니다." };
  if (req.status !== "EDITED" && req.status !== "FAILED") return { ok: false, error: "편집이 끝났거나 실패한 칸만 다시 올릴 수 있어요." };
  const { data: planRow } = await service.from("content_plans").select("status").eq("id", req.plan_id).maybeSingle();
  if (!planRow || !["SHOT", "RENDERED"].includes(planRow.status)) return { ok: false, error: "이미 올렸거나 끝난 기획이에요." };
  const { data: moved, error } = await service
    .from("shoot_requests")
    .update({ status: "OPEN", error: null })
    .eq("id", req.id)
    .in("status", ["EDITED", "FAILED"])
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!moved?.length) return { ok: false, error: "상태가 바뀌었어요. 새로 고쳐 주세요." };
  await service.from("content_plans").update({ status: "SCRIPTED" }).eq("id", req.plan_id).in("status", ["SHOT", "RENDERED"]);
  revalidatePath("/shoot/review");
  revalidatePath("/shoot/uploads");
  revalidatePath("/shoot/plans");
  return { ok: true };
}

// ─── 받기 ─────────────────────────────────────────────────────────────────────

const LINK_SECONDS = 3600;

type PlanFiles = NonNullable<Awaited<ReturnType<typeof loadPlanForFiles>>>;

async function loadPlanForFiles(service: Service, planId: string, orgId: string) {
  const { data } = await service
    .from("content_plans")
    .select(
      "id, status, product_id, social_account_id, script, warnings_ack, social_accounts(display_name), shoot_requests(id, status, rendered_path, edit, cuts, clips)",
    )
    .eq("id", planId)
    .eq("organization_id", orgId)
    .eq("track", "A")
    .maybeSingle();
  return data;
}

/** 지금 걸리는 광고 문구 규칙 · 판매 상태. 화면(완성본 받기)과 같은 계산. */
async function currentBlocking(service: Service, plan: PlanFiles): Promise<string[]> {
  if (!plan.product_id) return [];
  const [{ data: product }, { data: ruleRows }, { data: approvals }] = await Promise.all([
    service.from("products").select("kind, stock_status, product_analyses(health_functional, summary)").eq("id", plan.product_id).maybeSingle(),
    service.from("content_rules").select("id, scope, rule_type, phrase, match_type, reason, suggestion").eq("active", true),
    service.from("product_claim_approvals").select("claim").eq("product_id", plan.product_id),
  ]);
  if (!product) return [];
  const rules: ContentRule[] = (ruleRows ?? []).map((r) => ({
    id: r.id,
    scope: r.scope as ContentRule["scope"],
    ruleType: r.rule_type as ContentRule["ruleType"],
    phrase: r.phrase,
    matchType: r.match_type as ContentRule["matchType"],
    reason: r.reason,
    suggestion: r.suggestion,
  }));
  const captionText = ((plan.script ?? {}) as SavedCaption).caption?.text ?? "";
  const segments = (plan.shoot_requests?.edit as EditResult | null)?.segments ?? [];
  return finalBlocking(
    { caption: captionText, onScreen: segments.map((s) => s.onScreen), subtitles: segments.flatMap((s) => s.subtitles.map((t) => t.text)) },
    {
      kind: (product.kind ?? "OTHER") as ProductKind,
      rules,
      approvedClaims: (approvals ?? []).map((a) => a.claim),
      stockStatus: product.stock_status,
      healthFunctional: healthFunctionalOf(product.product_analyses),
      certifiedFunctions: certifiedFunctionsOf(product.product_analyses),
    },
  );
}

const ackSchema = z.object({ planId: z.string().uuid(), items: z.array(z.string().max(500)).min(1).max(50) });

/** 광고 문구 · 판매 상태 경고를 확인했다고 남긴다 — 그래야 받을 수 있다. 새 경고가 생기면 다시 확인받는다. */
export async function ackWarningsAction(input: z.infer<typeof ackSchema>): Promise<ShootResult> {
  const parsed = ackSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize("shoot");
  if (!auth.ok) return auth;
  const { data, error } = await createServiceClient()
    .from("content_plans")
    .update({ warnings_ack: parsed.data.items as unknown as Json, warnings_ack_by: auth.userId, warnings_ack_at: new Date().toISOString() })
    .eq("id", parsed.data.planId)
    .eq("organization_id", auth.orgId)
    .eq("track", "A")
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: "기획을 찾을 수 없습니다." };
  revalidatePath("/shoot/review");
  return { ok: true };
}

export interface ShootFile {
  name: string;
  // 누르면 내려받는 주소
  downloadUrl: string;
  // ZIP으로 묶을 때 읽는 주소
  rawUrl: string;
  size: number | null;
}

export type ShootFilesResult =
  | { ok: true; zipName: string; final: ShootFile | null; thumbnail: ShootFile | null; clips: (ShootFile & { cut: number })[]; texts: TextFile[] }
  | { ok: false; error: string };

const filesSchema = z.object({ planId: z.string().uuid() });

/** 받을 파일 — 완성본 · 표지 · 컷별 촬영 원본 · 글 파일. 주소는 한 시간 뒤 만료된다. */
export async function getShootFilesAction(input: z.infer<typeof filesSchema>): Promise<ShootFilesResult> {
  const parsed = filesSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize("shoot");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const plan = await loadPlanForFiles(service, parsed.data.planId, auth.orgId);
  if (!plan) return { ok: false, error: "기획을 찾을 수 없습니다." };
  const req = plan.shoot_requests;
  if (!req) return { ok: false, error: "촬영 요청이 없어요." };
  const editFailed = plan.status === "SHOT" && req.status === "FAILED";
  if (plan.status !== "RENDERED" && plan.status !== "PUBLISHED" && !editFailed) return { ok: false, error: "편집이 끝나면 받을 수 있어요." };

  if (plan.status !== "PUBLISHED") {
    const blocking = await currentBlocking(service, plan);
    const acked = new Set((plan.warnings_ack ?? []) as string[]);
    if (blocking.some((b) => !acked.has(b))) return { ok: false, error: "걸린 내용을 먼저 확인해 주세요." };
  }

  const account = plan.social_accounts?.display_name ?? "";
  const { data: productRow } = plan.product_id ? await service.from("products").select("name").eq("id", plan.product_id).maybeSingle() : { data: null };
  const productName = productRow?.name ?? "";
  const base = safeFileName(`${account}_${productName}`);
  const sign = async (path: string, name: string, size: number | null): Promise<ShootFile> => {
    const { data: raw, error: rawErr } = await service.storage.from("media").createSignedUrl(path, LINK_SECONDS);
    if (!raw) throw new Error(rawErr?.message ?? "파일 주소를 만들지 못했어요.");
    // SDK의 download 옵션은 한글 이름을 두 번 인코딩해 저장 이름이 깨진다(2026-11-04 실측) — 직접 붙인다
    return { name, downloadUrl: `${raw.signedUrl}&download=${encodeURIComponent(name)}`, rawUrl: raw.signedUrl, size };
  };

  const edit = (req.edit ?? {}) as { thumbnail?: string | null; segments?: PackageSegment[] };
  const clipRows = ((req.clips ?? []) as Clip[]).slice().sort((a, b) => a.cut - b.cut);
  try {
    const [final, thumbnail, clips] = await Promise.all([
      req.rendered_path ? sign(req.rendered_path, `${base}_완성본.mp4`, null) : null,
      edit.thumbnail ? sign(edit.thumbnail, `${base}_표지.jpg`, null) : null,
      Promise.all(
        clipRows.map(async (c) => {
          const ext = c.path.split(".").pop() ?? "mp4";
          return { cut: c.cut, ...(await sign(c.path, `${base}_컷${String(c.cut).padStart(2, "0")}_원본.${ext}`, c.size)) };
        }),
      ),
    ]);
    const script = (plan.script ?? null) as (PackageScript & SavedCaption) | null;
    const texts = buildPackageTexts({
      account,
      productName,
      caption: script?.caption?.text ?? "",
      script,
      cuts: (req.cuts ?? []) as unknown as PackageCut[],
      segments: edit.segments ?? [],
    });
    return { ok: true, zipName: `${base}.zip`, final, thumbnail, clips, texts };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "파일 주소를 만들지 못했어요." };
  }
}

// ─── 올렸어요 ─────────────────────────────────────────────────────────────────

export interface RecentReel {
  id: string;
  caption: string | null;
  thumbnailUrl: string | null;
  permalink: string | null;
  postedAt: string | null;
  // 이미 다른 기획에 연결된 릴스
  linked: boolean;
}

// 사람이 고를 최근 게시물 범위
const RECENT_MEDIA_LIMIT = 30;

async function recentReelsOf(service: Service, accountId: string) {
  const auth = await getInstagramAuth(service, accountId);
  const media = await listRecentMedia(auth.token, RECENT_MEDIA_LIMIT);
  return media.filter((m) => m.mediaProductType === "REELS");
}

/** "올렸어요" — 인스타에 이미 올라간 이 계정의 최근 릴스를 불러온다. */
export async function listRecentReelsAction(
  input: z.infer<typeof filesSchema>,
): Promise<{ ok: true; reels: RecentReel[] } | { ok: false; error: string }> {
  const parsed = filesSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize("shoot");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const plan = await loadPlan(service, parsed.data.planId, auth.orgId);
  if (!plan) return { ok: false, error: "기획을 찾을 수 없습니다." };
  try {
    const reels = await recentReelsOf(service, plan.social_account_id);
    const { data: linkedRows } = reels.length
      ? await service.from("content_plans").select("posted_media_id").eq("social_account_id", plan.social_account_id).in("posted_media_id", reels.map((r) => r.id))
      : { data: [] };
    const linked = new Set((linkedRows ?? []).map((r) => r.posted_media_id));
    return {
      ok: true,
      reels: reels.map((r) => ({
        id: r.id,
        caption: r.caption,
        thumbnailUrl: r.thumbnailUrl,
        permalink: r.permalink,
        postedAt: r.timestamp,
        linked: linked.has(r.id),
      })),
    };
  } catch (e) {
    console.error("[shoot] 최근 릴스 불러오기 실패:", e);
    return { ok: false, error: `인스타에서 릴스를 불러오지 못했어요: ${e instanceof Error ? e.message : "알 수 없는 오류"}` };
  }
}

const postedSchema = z.object({ planId: z.string().uuid(), mediaId: z.string().min(1).max(100) });

/** 고른 릴스를 기획에 연결하고 끝낸다. 인스타에 실제로 있는 이 계정 릴스인지 서버가 다시 확인한다. */
export async function markPostedAction(input: z.infer<typeof postedSchema>): Promise<ShootResult> {
  const parsed = postedSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize("shoot");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const { data: plan } = await service
    .from("content_plans")
    .select("id, status, social_account_id, shoot_requests(status)")
    .eq("id", parsed.data.planId)
    .eq("organization_id", auth.orgId)
    .eq("track", "A")
    .maybeSingle();
  if (!plan) return { ok: false, error: "기획을 찾을 수 없습니다." };
  const fromStatus = plan.status;
  if (fromStatus !== "RENDERED" && !(fromStatus === "SHOT" && plan.shoot_requests?.status === "FAILED")) return { ok: false, error: "편집이 끝난 기획만 연결할 수 있어요." };

  let reel;
  try {
    reel = (await recentReelsOf(service, plan.social_account_id)).find((r) => r.id === parsed.data.mediaId);
  } catch (e) {
    return { ok: false, error: `인스타에서 릴스를 확인하지 못했어요: ${e instanceof Error ? e.message : "알 수 없는 오류"}` };
  }
  if (!reel) return { ok: false, error: "이 계정에 올라간 최근 릴스에서 찾지 못했어요. 목록을 다시 불러와 주세요." };

  const { data: moved, error } = await service
    .from("content_plans")
    .update({
      status: "PUBLISHED",
      posted_media_id: reel.id,
      posted_permalink: reel.permalink,
      posted_at: reel.timestamp ?? new Date().toISOString(),
      posted_by: auth.userId,
    })
    .eq("id", plan.id)
    .eq("status", fromStatus)
    .select("id");
  if (error) return { ok: false, error: error.code === "23505" ? "이미 다른 기획에 연결된 릴스예요." : error.message };
  if (!moved?.length) return { ok: false, error: "상태가 바뀌었어요. 새로 고쳐 주세요." };
  revalidateShoot();
  revalidatePath("/");
  return { ok: true };
}

/** 잘못 연결했을 때 — 연결을 풀고 받기 단계로 되돌린다. */
export async function unlinkPostedAction(input: z.infer<typeof filesSchema>): Promise<ShootResult> {
  const parsed = filesSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize("shoot");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const { data: plan } = await service
    .from("content_plans")
    .select("id, status, shoot_requests(status)")
    .eq("id", parsed.data.planId)
    .eq("organization_id", auth.orgId)
    .eq("track", "A")
    .maybeSingle();
  if (!plan || plan.status !== "PUBLISHED") return { ok: false, error: "연결된 릴스가 없어요." };
  const { error } = await service
    .from("content_plans")
    .update({
      status: plan.shoot_requests?.status === "FAILED" ? "SHOT" : "RENDERED",
      posted_media_id: null,
      posted_permalink: null,
      posted_at: null,
      posted_by: null,
    })
    .eq("id", plan.id)
    .eq("status", "PUBLISHED");
  if (error) return { ok: false, error: error.message };
  revalidateShoot();
  return { ok: true };
}

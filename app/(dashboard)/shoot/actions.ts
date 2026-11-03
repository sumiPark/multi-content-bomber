"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile, getSessionUser } from "@/lib/auth";
import { isPastSlot } from "@/lib/automation/deadline";
import { triggerShootPlanRun, triggerShotlistRun } from "@/lib/github-dispatch";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// 직접 촬영 콘텐츠(12 · 18시 칸, 0030). 사람이 기획을 고르거나 상품을 직접 지정 → 컷 리스트(워커) →
// 컷마다 촬영본을 올리고 "다 올렸어요" → 자동 편집(다음 단계) → 완성본 확인 → 예약.
// 고르기 · 지정 · 건너뛰기는 ADMIN · MANAGER, 촬영본 올리기는 조직 누구나(찍는 사람이 STAFF일 수 있다).

export type ShootResult = { ok: true } | { ok: false; error: string };
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
    .select("id, status, slot_date, slot_time, product_id, proposal, social_account_id, shoot_requests(id, clips)")
    .eq("id", planId)
    .eq("organization_id", orgId)
    .eq("track", "A")
    .maybeSingle();
  return data;
}

type LoadedPlan = NonNullable<Awaited<ReturnType<typeof loadPlan>>>;

/** 고르기 · 바꾸기가 되는 칸인지 — 촬영본을 올리기 전까지, 올릴 시각 전까지. */
function canRechoose(plan: LoadedPlan): string | null {
  if (!["PROPOSED", "CONFIRMED", "SCRIPTED", "BLOCKED"].includes(plan.status)) return "이미 촬영본을 올린 칸이라 바꿀 수 없어요.";
  const clips = (plan.shoot_requests?.clips ?? []) as unknown[];
  if (clips.length > 0) return "이미 촬영본을 올린 칸이라 바꿀 수 없어요.";
  if (isPastSlot(plan.slot_date, plan.slot_time)) return "올릴 시각이 지난 칸입니다.";
  return null;
}

/** 같은 날 다른 칸(다른 계정 포함)이 이미 쓰는 상품인지. */
async function usedSameDay(service: Service, plan: LoadedPlan, productId: string): Promise<boolean> {
  const { data } = await service
    .from("content_plans")
    .select("id")
    .eq("slot_date", plan.slot_date)
    .eq("product_id", productId)
    .neq("id", plan.id)
    .not("status", "in", "(SKIPPED,FAILED)")
    .limit(1);
  return (data?.length ?? 0) > 0;
}

/** 고른 상품으로 컷 리스트를 새로 쓰게 — 기존 촬영 요청(올린 촬영본 없음)은 지운다. */
async function confirmAndQueue(
  service: Service,
  plan: LoadedPlan,
  userId: string,
  patch: { product_id: string; product_changed: boolean; human_brief: string | null; chosen: number | null },
): Promise<ShootResult> {
  if (plan.shoot_requests) await service.from("shoot_requests").delete().eq("id", plan.shoot_requests.id);
  const proposal = { ...((plan.proposal ?? {}) as Record<string, unknown>), chosen: patch.chosen };
  const { error } = await service
    .from("content_plans")
    .update({
      status: "CONFIRMED",
      product_id: patch.product_id,
      product_changed: patch.product_changed,
      human_brief: patch.human_brief,
      proposal: proposal as unknown as Json,
      script: null,
      check_result: null,
      note: null,
      error: null,
      confirmed_by: userId,
      confirmed_at: new Date().toISOString(),
    })
    .eq("id", plan.id);
  if (error) return { ok: false, error: error.message };
  // 실패해도 다음 05시 실행이 집어 간다 — 즉시성만 손해
  await triggerShotlistRun(`plan ${plan.id}`).catch((e) => console.error("[shoot] 컷 리스트 트리거 실패:", e));
  revalidatePath("/shoot/plans");
  revalidatePath("/shoot/uploads");
  return { ok: true };
}

const chooseSchema = z.object({ planId: z.string().uuid(), ideaIndex: z.number().int().min(0).max(5) });

/** AI 후보 중 하나로 찍기. */
export async function chooseIdeaAction(input: z.infer<typeof chooseSchema>): Promise<ShootResult> {
  const parsed = chooseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize("plan");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const plan = await loadPlan(service, parsed.data.planId, auth.orgId);
  if (!plan) return { ok: false, error: "칸을 찾을 수 없습니다." };
  const blocked = canRechoose(plan);
  if (blocked) return { ok: false, error: blocked };

  const ideas = ((plan.proposal as { ideas?: { product_id: string }[] })?.ideas ?? []);
  const idea = ideas[parsed.data.ideaIndex];
  if (!idea) return { ok: false, error: "후보를 찾을 수 없습니다." };
  if (await usedSameDay(service, plan, idea.product_id)) return { ok: false, error: "같은 날 다른 칸에서 이미 쓰는 상품이에요." };
  return confirmAndQueue(service, plan, auth.userId, {
    product_id: idea.product_id,
    product_changed: parsed.data.ideaIndex !== 0,
    human_brief: null,
    chosen: parsed.data.ideaIndex,
  });
}

const pickSchema = z.object({
  planId: z.string().uuid(),
  productId: z.string().uuid(),
  brief: z.string().trim().max(300).nullable(),
});

/** 상품 직접 지정 (+ 찍고 싶은 것 메모). */
export async function pickProductAction(input: z.infer<typeof pickSchema>): Promise<ShootResult> {
  const parsed = pickSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize("plan");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const plan = await loadPlan(service, parsed.data.planId, auth.orgId);
  if (!plan) return { ok: false, error: "칸을 찾을 수 없습니다." };
  const blocked = canRechoose(plan);
  if (blocked) return { ok: false, error: blocked };

  const { data: product } = await service
    .from("products")
    .select("id, shop_code, kind, stock_status, excluded, analysis_state")
    .eq("id", parsed.data.productId)
    .maybeSingle();
  if (!product) return { ok: false, error: "상품을 찾을 수 없습니다." };
  const scopes = await accountScopes(service, plan.social_account_id);
  if (!scopes.some((s) => s.shop === product.shop_code && s.kind === product.kind)) return { ok: false, error: "이 계정에서 쓰지 않는 상품 종류예요." };
  if (product.stock_status !== "available" || product.excluded) return { ok: false, error: "지금 판매 중인 상품만 고를 수 있어요." };
  if (product.analysis_state !== "ready") return { ok: false, error: "상세페이지 분석이 끝난 상품만 고를 수 있어요." };
  if (await usedSameDay(service, plan, product.id)) return { ok: false, error: "같은 날 다른 칸에서 이미 쓰는 상품이에요." };

  return confirmAndQueue(service, plan, auth.userId, {
    product_id: product.id,
    product_changed: true,
    human_brief: parsed.data.brief || null,
    chosen: null,
  });
}

async function accountScopes(service: Service, accountId: string): Promise<{ shop: string; kind: string }[]> {
  const { data } = await service.from("track_settings").select("product_scopes").eq("social_account_id", accountId).maybeSingle();
  return (data?.product_scopes ?? []) as { shop: string; kind: string }[];
}

export interface ProductHit {
  id: string;
  name: string;
  price: number | null;
  image: string | null;
  oneLine: string | null;
}

const searchSchema = z.object({ planId: z.string().uuid(), query: z.string().trim().min(1).max(50) });

/** 직접 지정용 상품 검색 — 이 계정이 쓰는 몰 · 종류, 판매 중, 분석 완료만. */
export async function searchProductsAction(
  input: z.infer<typeof searchSchema>,
): Promise<{ ok: true; hits: ProductHit[] } | { ok: false; error: string }> {
  const parsed = searchSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "검색어를 입력하세요." };
  const auth = await authorize("plan");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const plan = await loadPlan(service, parsed.data.planId, auth.orgId);
  if (!plan) return { ok: false, error: "칸을 찾을 수 없습니다." };

  const pattern = `%${parsed.data.query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const hits: ProductHit[] = [];
  for (const scope of await accountScopes(service, plan.social_account_id)) {
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

const idSchema = z.object({ planId: z.string().uuid() });

/** AI 후보 다시 만들기 — 제안만 지우고 기획 워커를 부른다(빈 칸만 채움). */
export async function regenerateIdeasAction(input: z.infer<typeof idSchema>): Promise<ShootResult> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize("plan");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const plan = await loadPlan(service, parsed.data.planId, auth.orgId);
  if (!plan) return { ok: false, error: "칸을 찾을 수 없습니다." };
  if (plan.status !== "PROPOSED") return { ok: false, error: "고르기 전인 칸만 다시 만들 수 있어요." };
  const { error } = await service.from("content_plans").delete().eq("id", plan.id).eq("status", "PROPOSED");
  if (error) return { ok: false, error: error.message };
  try {
    await triggerShootPlanRun(`regenerate ${plan.id}`, plan.slot_date);
  } catch (e) {
    console.error("[shoot] 기획 트리거 실패:", e);
    revalidatePath("/shoot/plans");
    return { ok: false, error: "후보를 지웠지만 다시 만들기 실행을 못 했어요. 내일 새벽 5시에 다시 채워집니다." };
  }
  revalidatePath("/shoot/plans");
  return { ok: true };
}

/** 이 칸 건너뛰기 (발행 예약 전까지). */
export async function skipShootAction(input: z.infer<typeof idSchema>): Promise<ShootResult> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize("plan");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const plan = await loadPlan(service, parsed.data.planId, auth.orgId);
  if (!plan) return { ok: false, error: "칸을 찾을 수 없습니다." };
  if (["SCHEDULED", "PUBLISHED", "SKIPPED"].includes(plan.status)) return { ok: false, error: "건너뛸 수 없는 칸입니다." };
  const { error } = await service.from("content_plans").update({ status: "SKIPPED", note: "사람이 건너뜀" }).eq("id", plan.id);
  if (error) return { ok: false, error: error.message };
  if (plan.shoot_requests) await service.from("shoot_requests").update({ status: "CANCELLED" }).eq("id", plan.shoot_requests.id);
  revalidatePath("/shoot/plans");
  revalidatePath("/shoot/uploads");
  return { ok: true };
}

// ─── 촬영 · 올리기 ────────────────────────────────────────────────────────────

type Cut = { no: number; done?: boolean } & Record<string, unknown>;
type Clip = { cut: number; path: string; name: string; size: number; type: string; uploaded_at: string; uploaded_by: string };

async function loadRequest(service: Service, requestId: string, orgId: string) {
  const { data } = await service
    .from("shoot_requests")
    .select("id, plan_id, status, cuts, clips")
    .eq("id", requestId)
    .eq("organization_id", orgId)
    .maybeSingle();
  return data;
}

const cutSchema = z.object({ requestId: z.string().uuid(), no: z.number().int().min(1).max(20), done: z.boolean() });

/** 찍은 컷 체크. */
export async function toggleCutAction(input: z.infer<typeof cutSchema>): Promise<ShootResult> {
  const parsed = cutSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize("shoot");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const req = await loadRequest(service, parsed.data.requestId, auth.orgId);
  if (!req) return { ok: false, error: "촬영 요청을 찾을 수 없습니다." };
  const cuts = ((req.cuts ?? []) as Cut[]).map((c) => (c.no === parsed.data.no ? { ...c, done: parsed.data.done } : c));
  const { error } = await service.from("shoot_requests").update({ cuts: cuts as unknown as Json }).eq("id", req.id);
  if (error) return { ok: false, error: error.message };
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
  const req = await loadRequest(service, parsed.data.requestId, auth.orgId);
  if (!req) return { ok: false, error: "촬영 요청을 찾을 수 없습니다." };
  if (req.status !== "OPEN") return { ok: false, error: "이미 편집으로 넘어간 촬영 요청입니다." };
  if (!parsed.data.path.startsWith(`${auth.orgId}/${auth.userId}/shoot/${req.id}/`)) return { ok: false, error: "잘못된 파일 경로" };
  const cuts = (req.cuts ?? []) as Cut[];
  if (!cuts.some((c) => c.no === parsed.data.cut)) return { ok: false, error: "없는 컷입니다." };

  const clips = (req.clips ?? []) as Clip[];
  const old = clips.filter((c) => c.cut === parsed.data.cut);
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
  const nextCuts = cuts.map((c) => (c.no === parsed.data.cut ? { ...c, done: true } : c));
  const { error } = await service
    .from("shoot_requests")
    .update({ clips: next as unknown as Json, cuts: nextCuts as unknown as Json })
    .eq("id", req.id);
  if (error) return { ok: false, error: error.message };
  if (old.length) await service.storage.from("media").remove(old.map((c) => c.path));
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
  const req = await loadRequest(service, parsed.data.requestId, auth.orgId);
  if (!req) return { ok: false, error: "촬영 요청을 찾을 수 없습니다." };
  if (req.status !== "OPEN") return { ok: false, error: "이미 편집으로 넘어간 촬영 요청입니다." };
  const clips = (req.clips ?? []) as Clip[];
  const old = clips.filter((c) => c.cut === parsed.data.cut);
  const { error } = await service
    .from("shoot_requests")
    .update({ clips: clips.filter((c) => c.cut !== parsed.data.cut) as unknown as Json })
    .eq("id", req.id);
  if (error) return { ok: false, error: error.message };
  if (old.length) await service.storage.from("media").remove(old.map((c) => c.path));
  revalidatePath("/shoot/uploads");
  return { ok: true };
}

const finishSchema = z.object({ requestId: z.string().uuid() });

/** 다 올렸어요 → 편집 대기. 컷마다 촬영본이 있어야 한다. */
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
  const missing = cuts.filter((c) => !clips.some((k) => k.cut === c.no)).map((c) => c.no);
  if (missing.length) return { ok: false, error: `${missing.join(", ")}번 컷 촬영본이 아직 없어요.` };

  const { error } = await service
    .from("shoot_requests")
    .update({ status: "UPLOADED", uploaded_at: new Date().toISOString(), error: null })
    .eq("id", req.id)
    .eq("status", "OPEN");
  if (error) return { ok: false, error: error.message };
  await service.from("content_plans").update({ status: "SHOT" }).eq("id", req.plan_id);
  revalidatePath("/shoot/uploads");
  revalidatePath("/shoot/plans");
  return { ok: true };
}

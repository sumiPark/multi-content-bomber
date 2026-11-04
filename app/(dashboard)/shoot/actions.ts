"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile, getSessionUser } from "@/lib/auth";
import { isPastSlot } from "@/lib/automation/deadline";
import { kstToIso } from "@/lib/automation/time";
import { triggerShootEditRun, triggerShootPlanRun, triggerShotlistRun } from "@/lib/github-dispatch";
import type { ProductKind } from "@/lib/products/shops";
import type { ContentRule } from "@/lib/rules/check";
import { finalBlocking, splitHashtags } from "@/lib/shoot/final-check";
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
    const nextCuts = cuts.map((c) => (c.no === parsed.data.cut ? { ...c, done: true } : c));
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

// ─── 완성본 확인 ──────────────────────────────────────────────────────────────

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
  if (!plan) return { ok: false, error: "칸을 찾을 수 없습니다." };
  if (!["SCRIPTED", "SHOT", "RENDERED"].includes(plan.status)) return { ok: false, error: "예약된 뒤에는 고칠 수 없어요." };
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
    .array(z.object({ no: z.number().int().min(1).max(20), onScreen: z.string().max(40), subtitle: z.string().max(120).nullable() }))
    .max(20),
});

/** 고친 화면 문구 · 자막으로 다시 편집 (실패한 편집 다시 시도도 이걸로 — cuts 빈 배열). */
export async function reEditAction(input: z.infer<typeof reEditSchema>): Promise<ShootResult> {
  const parsed = reEditSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  // 완성본 확인 화면의 기능 — 화면처럼 관리자 · 매니저만(예전엔 찍는 사람도 서버에서 됐다)
  const auth = await authorize("plan");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const req = await loadRequest(service, parsed.data.requestId, auth.orgId);
  if (!req) return { ok: false, error: "촬영 요청을 찾을 수 없습니다." };
  if (req.status !== "EDITED" && req.status !== "FAILED") return { ok: false, error: "편집이 끝난 뒤에 다시 편집할 수 있어요." };
  // 이미 예약된 칸은 다시 편집하지 않는다 — 다시 편집하면 예약된 영상 파일이 지워져 발행이 실패했다(2026-11-04)
  const { data: planRow } = await service.from("content_plans").select("status").eq("id", req.plan_id).maybeSingle();
  if (!planRow || !["SHOT", "RENDERED"].includes(planRow.status)) return { ok: false, error: "이미 예약됐거나 끝난 칸이라 다시 편집할 수 없어요." };
  const fix = new Map(parsed.data.cuts.map((c) => [c.no, c]));
  const cuts = ((req.cuts ?? []) as Cut[]).map((c) => {
    const f = fix.get(c.no);
    return f ? { ...c, on_screen_override: f.onScreen.trim(), subtitle_override: f.subtitle == null ? null : f.subtitle.trim() } : c;
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
 * 요청을 촬영 중(OPEN), 칸을 촬영 대기(SCRIPTED)로 되돌린다. 올린 촬영본은 남아 있어 바꿀 컷만 다시 올리면 된다.
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
  const { data: planRow } = await service.from("content_plans").select("status, slot_date, slot_time").eq("id", req.plan_id).maybeSingle();
  if (!planRow || !["SHOT", "RENDERED"].includes(planRow.status)) return { ok: false, error: "이미 예약됐거나 끝난 칸이에요." };
  if (isPastSlot(planRow.slot_date, planRow.slot_time)) return { ok: false, error: "올릴 시각이 지난 칸이에요." };
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

/** 완성본 확인 → 올릴 시각(12 · 18시)으로 예약. 기존 발행 큐(publish_jobs)에 그대로 들어간다. */
export async function approveShootAction(input: z.infer<typeof idSchema>): Promise<ShootResult> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize("plan");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const { data: plan } = await service
    .from("content_plans")
    .select(
      "id, status, slot_date, slot_time, product_id, social_account_id, script, social_accounts(display_name, disconnected_at, is_active), shoot_requests(id, status, rendered_path, edit)",
    )
    .eq("id", parsed.data.planId)
    .eq("organization_id", auth.orgId)
    .eq("track", "A")
    .maybeSingle();
  if (!plan) return { ok: false, error: "칸을 찾을 수 없습니다." };
  if (plan.status !== "RENDERED") return { ok: false, error: "편집이 끝난 칸만 확인할 수 있어요." };
  const req = plan.shoot_requests;
  if (!req || req.status !== "EDITED" || !req.rendered_path) return { ok: false, error: "완성본이 없어요." };
  // 발행 워커가 집어 가고 컨테이너를 만들 시간 — 올릴 시각 5분 전까지만
  const scheduledFor = kstToIso(plan.slot_date, plan.slot_time);
  if (isPastSlot(plan.slot_date, plan.slot_time, 5 * 60_000)) return { ok: false, error: "올릴 시각이 너무 가까워 예약할 수 없어요." };
  const acc = plan.social_accounts;
  if (!acc || acc.disconnected_at || !acc.is_active) return { ok: false, error: "계정 연결이 끊겨 있어요. 계정 연동에서 다시 연결해 주세요." };
  if (!plan.product_id) return { ok: false, error: "상품이 없는 칸입니다." };

  const [{ data: product }, { data: ruleRows }, { data: approvals }] = await Promise.all([
    service.from("products").select("name, kind, stock_status, product_analyses(health_functional)").eq("id", plan.product_id).maybeSingle(),
    service.from("content_rules").select("id, scope, rule_type, phrase, match_type, reason, suggestion").eq("active", true),
    service.from("product_claim_approvals").select("claim").eq("product_id", plan.product_id),
  ]);
  if (!product) return { ok: false, error: "상품을 찾을 수 없습니다." };
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
  const segments = (req.edit as EditResult | null)?.segments ?? [];
  const blocking = finalBlocking(
    { caption: captionText, onScreen: segments.map((s) => s.onScreen), subtitles: segments.flatMap((s) => s.subtitles.map((t) => t.text)) },
    {
      kind: (product.kind ?? "OTHER") as ProductKind,
      rules,
      approvedClaims: (approvals ?? []).map((a) => a.claim),
      stockStatus: product.stock_status,
      healthFunctional: healthFunctionalOf(product.product_analyses),
    },
  );
  if (blocking.length) return { ok: false, error: `확인 전에 고칠 것: ${blocking.join(" · ")}` };

  // 먼저 칸을 선점한다 — 관리자 두 명 · 탭 두 개에서 동시에 눌러도 예약이 하나만 생기게(2026-11-04).
  // 아래에서 실패하면 RENDERED로 되돌린다.
  const { data: claimed } = await service
    .from("content_plans")
    .update({ status: "SCHEDULED", confirmed_by: auth.userId, confirmed_at: new Date().toISOString() })
    .eq("id", plan.id)
    .eq("status", "RENDERED")
    .select("id");
  if (!claimed?.length) return { ok: false, error: "이미 확인됐거나 상태가 바뀐 칸이에요. 새로 고쳐 주세요." };
  const release = () => service.from("content_plans").update({ status: "RENDERED", confirmed_by: null, confirmed_at: null }).eq("id", plan.id);

  const { caption, hashtags } = splitHashtags(captionText);
  const { data: content, error: cErr } = await service
    .from("contents")
    .insert({
      organization_id: auth.orgId,
      created_by: auth.userId,
      media_type: "VIDEO",
      media_urls: [req.rendered_path],
      metadata: { source: "shoot", planId: plan.id, shootRequestId: req.id } as Json,
      ai_captions: { instagram: { caption, hashtags } } as unknown as Json,
      ai_analyzed_at: new Date().toISOString(),
      internal_title: `[직접 촬영] ${product.name} · ${plan.slot_date.slice(5)} ${plan.slot_time}`.slice(0, 120),
    })
    .select("id")
    .single();
  if (cErr || !content) {
    await release();
    return { ok: false, error: `콘텐츠 저장 실패: ${cErr?.message}` };
  }
  const { data: job, error: jErr } = await service
    .from("publish_jobs")
    .insert({
      content_id: content.id,
      social_account_id: plan.social_account_id,
      post_type: "REELS",
      scheduled_for: scheduledFor,
      // 사람이 직접 찍은 영상(AI는 편집만) — 플랫폼 AI 라벨 대상 아님
      is_ai_generated: false,
    })
    .select("id")
    .single();
  if (jErr || !job) {
    await service.from("contents").delete().eq("id", content.id);
    await release();
    return { ok: false, error: `발행 예약 실패: ${jErr?.message}` };
  }
  const { error: linkErr } = await service.from("content_plans").update({ content_id: content.id, publish_job_id: job.id }).eq("id", plan.id);
  if (linkErr) {
    // 칸과 예약을 잇지 못하면 발행 직전 확인 · 편성표가 이 예약을 모른다 — 예약을 취소하고 되돌린다
    await service.from("publish_jobs").update({ status: "CANCELLED", cancelled_at: new Date().toISOString() }).eq("id", job.id);
    await release();
    return { ok: false, error: `예약을 칸에 잇지 못했어요: ${linkErr.message}` };
  }
  revalidatePath("/shoot/review");
  revalidatePath("/postings");
  return { ok: true };
}

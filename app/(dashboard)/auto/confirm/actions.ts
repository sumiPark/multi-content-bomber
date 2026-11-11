"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile, getSessionUser } from "@/lib/auth";
import { isPastSlot } from "@/lib/automation/deadline";
import { releaseOldPublish, scheduleAutoVideo } from "@/lib/auto-video/publish";
import { triggerAutoVideoRun } from "@/lib/github-dispatch";
import { duplicateWarning } from "@/lib/shoot/duplicates";
import type { Json } from "@/types/database";
import { createServiceClient } from "@/lib/supabase/service";

// AI 자동 업로드 상품 확인 (0028 content_plans). 사람은 상품만 확인하고, 확인하면 영상 워커를 바로 깨워
// 장면표(대본) → 영상까지 자동으로 만든다(0054). 같은 칸은 워커가 making_since로 한 실행만 집어 여러 번 눌러도 겹치지 않는다.
// 올릴 시각까지 확인할 수 있다. 그 2시간 전에 화면에서 알리고, 시각이 지나도록 확인이 없으면 건너뛴다(lib/automation/deadline.ts).
// 점검에 걸려 멈춘 칸(BLOCKED)은 마감이 지나도 올릴 시각 전까지 다시 쓰기 · 다른 상품으로 바꾸기 · 건너뛰기를 할 수 있다.

// warning = 겹치는 상품 경고. 막지 않고 사람에게 물은 뒤 force로 다시 부른다(직접 고른 상품만)
export type ConfirmResult = { ok: true; count?: number; soldOut?: number } | { ok: false; error: string; warning?: boolean };

// 칸에 남기는 제안 기록. original_product_id = AI가 처음 제안한 상품(사람이 바꾸면 남겨 둬 되돌리고 이유를 맞게 보인다)
type Proposal = { reason?: string; alternatives?: { product_id: string; reason: string }[]; original_product_id?: string };

async function authorize(): Promise<{ ok: true; userId: string; orgId: string } | { ok: false; error: string }> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "로그인이 필요합니다." };
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) return { ok: false, error: "소속된 조직이 없습니다." };
  if (profile.role !== "ADMIN" && profile.role !== "MANAGER") {
    return { ok: false, error: "상품 확인은 관리자 · 매니저만 할 수 있어요." };
  }
  return { ok: true, userId: user.id, orgId: profile.organization_id };
}

type Service = ReturnType<typeof createServiceClient>;

async function loadPlan(service: Service, planId: string, orgId: string) {
  const { data } = await service
    .from("content_plans")
    .select("id, status, slot_date, slot_time, product_id, product_changed, proposal, social_account_id")
    .eq("id", planId)
    .eq("organization_id", orgId)
    .eq("track", "B")
    .maybeSingle();
  if (!data) return null;
  // AI 자동 칸은 날짜 · 시각이 반드시 있다(0042 제약)
  return { ...data, slot_date: data.slot_date as string, slot_time: data.slot_time as string };
}

const confirmSchema = z.object({
  planId: z.string().uuid(),
  // 대안으로 바꿔 컨펌할 때만
  productId: z.string().uuid().nullable(),
});

export async function confirmPlanAction(input: z.infer<typeof confirmSchema>): Promise<ConfirmResult> {
  const parsed = confirmSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;

  const service = createServiceClient();
  const plan = await loadPlan(service, parsed.data.planId, auth.orgId);
  if (!plan) return { ok: false, error: "기획안을 찾을 수 없습니다." };
  const open = checkOpen(plan);
  if (!open.ok) return open;

  const nextProduct = parsed.data.productId ?? plan.product_id;
  if (!nextProduct) return { ok: false, error: "상품이 없는 칸입니다." };
  if (parsed.data.productId) {
    // 바꿀 수 있는 건 에이전트가 낸 대안과 처음 제안한 상품뿐 — 규칙(판매 중 · 분석 완료 · 최근 미사용)을 통과한 후보라서.
    // 그 밖의 상품은 직접 고르기(pickProductAction)로 경고를 보고 넣는다
    const proposal = (plan.proposal ?? {}) as Proposal;
    const allowed = [...(proposal.alternatives ?? []).map((a) => a.product_id), proposal.original_product_id].filter(Boolean);
    if (!allowed.includes(parsed.data.productId)) return { ok: false, error: "대안 목록에 없는 상품입니다." };
    const clash = await sameDayClash(service, plan, nextProduct, auth.orgId);
    if (clash) return clash;
  }
  const sellable = await checkSellable(service, nextProduct);
  if (!sellable.ok) return sellable;
  return applyConfirm(service, plan, nextProduct, auth.userId);
}

type Plan = NonNullable<Awaited<ReturnType<typeof loadPlan>>>;

/** 확인 · 바꾸기 · 직접 고르기가 되는 칸인지 — 확인 대기 · 확인됨 · 멈춘 칸, 올릴 시각 전 */
function checkOpen(plan: Plan): { ok: true } | { ok: false; error: string } {
  if (plan.status !== "PROPOSED" && plan.status !== "CONFIRMED" && plan.status !== "BLOCKED") {
    return { ok: false, error: "이미 다음 단계로 넘어간 칸이라 바꿀 수 없어요." };
  }
  if (isPastSlot(plan.slot_date, plan.slot_time)) return { ok: false, error: "올릴 시각이 지난 칸이에요." };
  return { ok: true };
}

/** 같은 날 다른 칸(직접 촬영 포함)이 이미 쓰는 상품이면 막는다 — 제안 뒤 그사이 다른 칸이 쓰게 됐을 수 있다 */
async function sameDayClash(service: Service, plan: Plan, productId: string, orgId: string): Promise<{ ok: false; error: string } | null> {
  const { data: used } = await service
    .from("content_plans")
    .select("id")
    .eq("organization_id", orgId)
    .eq("slot_date", plan.slot_date)
    .eq("product_id", productId)
    .neq("id", plan.id)
    .not("status", "in", "(SKIPPED,FAILED)")
    .limit(1);
  return used?.length ? { ok: false, error: "같은 날 다른 칸에서 쓰는 상품이에요. 다른 상품을 골라 주세요." } : null;
}

// 판매 중이 아니면 확인하지 않는다 — 확인해도 대본 단계에서 멈춘다(2026-11-04, 예전엔 그대로 확인됐다)
async function checkSellable(service: Service, productId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: product } = await service.from("products").select("stock_status").eq("id", productId).maybeSingle();
  if (product?.stock_status !== "available") return { ok: false, error: "지금 판매 중이 아닌 상품이에요. 다른 후보로 바꾸거나 건너뛰어 주세요." };
  return { ok: true };
}

/** 칸을 이 상품으로 확인하고 영상 만들기를 깨운다. 상품이 바뀌면 AI가 처음 제안한 상품을 제안 기록에 남긴다 */
async function applyConfirm(service: Service, plan: Plan, nextProduct: string, userId: string): Promise<ConfirmResult> {
  const fixing = plan.status === "BLOCKED";
  const proposal = (plan.proposal ?? {}) as Proposal;
  // 예전에 바꾼 칸(기록 전)은 처음 상품을 알 수 없어 남기지 않는다
  const keepOriginal = nextProduct !== plan.product_id && !proposal.original_product_id && !plan.product_changed && !!plan.product_id;
  // 멈춘 칸을 다시 쓰면 예전 발행 작업을 끊고, 작업이 없던 완성본 파일은 지운다
  let staleFiles: string[] = [];
  if (fixing) {
    const released = await releaseOldPublish(service, plan.id);
    if (!released.ok) return released;
    if (!released.hadJob) {
      const { data: row } = await service.from("content_plans").select("video").eq("id", plan.id).maybeSingle();
      const old = (row?.video ?? {}) as { path?: string; thumbnail?: string };
      staleFiles = [old.path, old.thumbnail].filter((p): p is string => !!p);
    }
  }
  const { data: updated, error } = await service
    .from("content_plans")
    .update({
      status: "CONFIRMED",
      product_id: nextProduct,
      product_changed: plan.product_changed || nextProduct !== plan.product_id,
      ...(keepOriginal ? { proposal: { ...proposal, original_product_id: plan.product_id } as unknown as Json } : {}),
      confirmed_by: userId,
      confirmed_at: new Date().toISOString(),
      // 멈춘 칸을 다시 쓰면 예전 대본 · 장면표 · 점검 결과는 지운다
      ...(fixing ? { script: null, storyboard: null, redo: null, making_since: null, check_result: null, note: null, error: null, video: null } : {}),
    })
    .eq("id", plan.id)
    .eq("status", plan.status)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!updated?.length) return { ok: false, error: "상태가 바뀌었어요. 새로 고쳐 주세요." };
  if (staleFiles.length) await service.storage.from("media").remove(staleFiles);
  // 확인하면 바로 장면표 · 영상을 만들기 시작한다(실패해도 매시 정기 실행이 집어 간다)
  await triggerAutoVideoRun(`${fixing ? "rewrite" : "confirm"} ${plan.id}`).catch((e) => console.error("[auto] 영상 트리거 실패:", e));
  revalidatePath("/auto/confirm");
  return { ok: true };
}

/** 이 칸 계정이 쓰는 몰 · 종류 — 자동 콘텐츠 설정과 직접 촬영이 같은 값을 쓴다(track_settings.product_scopes) */
async function accountScopes(service: Service, accountId: string, orgId: string) {
  const { data } = await service
    .from("track_settings")
    .select("product_scopes, repeat_gap_days")
    .eq("social_account_id", accountId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!data) return null;
  return { scopes: (data.product_scopes ?? []) as { shop: string; kind: string }[], gapDays: data.repeat_gap_days };
}

/** 건강기능식품은 사람이 확정한 심의 문구가 있어야 AI 자동 영상에 쓴다(AI 후보 규칙과 같다, lib/agents/select.ts) */
async function unapprovedHealth(service: Service, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const { data: health } = await service.from("product_analyses").select("product_id").in("product_id", ids).eq("health_functional", true);
  const healthIds = (health ?? []).map((h) => h.product_id);
  if (!healthIds.length) return new Set();
  const { data: approved } = await service.from("product_claim_approvals").select("product_id").in("product_id", healthIds);
  const ok = new Set((approved ?? []).map((a) => a.product_id));
  return new Set(healthIds.filter((id) => !ok.has(id)));
}

export interface AutoProductHit {
  id: string;
  name: string;
  price: number | null;
  image: string | null;
  oneLine: string | null;
}

const searchSchema = z.object({ planId: z.string().uuid(), query: z.string().trim().min(1).max(50) });

/** 칸에 넣을 상품 찾기 — 이 계정이 쓰는 몰 · 종류, 판매 중, 분석 완료, (건강기능식품이면) 심의 문구 확정만 */
export async function searchAutoProductsAction(
  input: z.infer<typeof searchSchema>,
): Promise<{ ok: true; hits: AutoProductHit[] } | { ok: false; error: string }> {
  const parsed = searchSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "검색어를 입력하세요." };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const plan = await loadPlan(service, parsed.data.planId, auth.orgId);
  if (!plan) return { ok: false, error: "칸을 찾을 수 없습니다." };
  const settings = await accountScopes(service, plan.social_account_id, auth.orgId);
  if (!settings?.scopes.length) return { ok: false, error: "자동 콘텐츠 설정에 쓸 상품 종류가 없는 계정이에요." };

  const pattern = `%${parsed.data.query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const rows = [];
  for (const scope of settings.scopes) {
    const { data } = await service
      .from("products")
      .select("id, name, price, represent_image_url, product_analyses(summary)")
      .eq("shop_code", scope.shop)
      .eq("kind", scope.kind)
      .eq("stock_status", "available")
      .eq("excluded", false)
      .eq("analysis_state", "ready")
      .ilike("name", pattern)
      .limit(20);
    rows.push(...(data ?? []));
  }
  const blocked = await unapprovedHealth(service, rows.map((r) => r.id));
  const hits = rows
    .filter((p) => !blocked.has(p.id) && p.id !== plan.product_id)
    .slice(0, 12)
    .map((p) => ({
      id: p.id,
      name: p.name,
      price: p.price,
      image: p.represent_image_url,
      oneLine: (p.product_analyses?.summary as { oneLine?: string } | null)?.oneLine ?? null,
    }));
  return { ok: true, hits };
}

const pickSchema = z.object({ planId: z.string().uuid(), productId: z.string().uuid(), force: z.boolean().optional() });

/**
 * 사람이 찾은 상품으로 칸을 확인한다. AI 후보 규칙 중 판매 중 · 분석 완료 · 계정 상품 종류 · 건강기능식품 심의 문구는 막고,
 * 최근에 쓴 상품 · 다른 계정이 진행 중인 상품은 막지 않고 경고한 뒤 진행한다(직접 촬영과 같다, lib/shoot/duplicates.ts).
 */
export async function pickProductAction(input: z.infer<typeof pickSchema>): Promise<ConfirmResult> {
  const parsed = pickSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const plan = await loadPlan(service, parsed.data.planId, auth.orgId);
  if (!plan) return { ok: false, error: "칸을 찾을 수 없습니다." };
  const open = checkOpen(plan);
  if (!open.ok) return open;
  const productId = parsed.data.productId;

  const settings = await accountScopes(service, plan.social_account_id, auth.orgId);
  const { data: product } = await service
    .from("products")
    .select("id, shop_code, kind, stock_status, excluded, analysis_state")
    .eq("id", productId)
    .maybeSingle();
  if (!product) return { ok: false, error: "상품을 찾을 수 없습니다." };
  if (!settings?.scopes.some((s) => s.shop === product.shop_code && s.kind === product.kind)) return { ok: false, error: "이 계정에서 쓰지 않는 상품 종류예요." };
  if (product.stock_status !== "available" || product.excluded) return { ok: false, error: "지금 판매 중인 상품만 고를 수 있어요." };
  if (product.analysis_state !== "ready") return { ok: false, error: "상세페이지 분석이 끝난 상품만 고를 수 있어요." };
  if ((await unapprovedHealth(service, [productId])).size) return { ok: false, error: "심의 문구를 확정하지 않은 건강기능식품이에요. 상품 화면에서 문구를 확정한 뒤 골라 주세요." };
  const clash = await sameDayClash(service, plan, productId, auth.orgId);
  if (clash) return clash;

  if (!parsed.data.force) {
    const warning = await duplicateWarning(service, { accountId: plan.social_account_id, productId, excludePlanId: plan.id, gapDays: settings.gapDays });
    if (warning) return { ok: false, error: warning, warning: true };
  }
  return applyConfirm(service, plan, productId, auth.userId);
}

const idSchema = z.object({ planId: z.string().uuid() });

/** 완성본을 보고 올린다. 올릴 시각이 지났으면 바로 올라간다. */
export async function approveVideoAction(input: z.infer<typeof idSchema>): Promise<ConfirmResult> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const plan = await loadPlan(service, parsed.data.planId, auth.orgId);
  if (!plan) return { ok: false, error: "칸을 찾을 수 없습니다." };
  const r = await scheduleAutoVideo(service, plan.id, { byUser: auth.userId });
  if (!r.ok) return r;
  revalidatePath("/auto/confirm");
  revalidatePath("/postings");
  return { ok: true };
}

const remakeSchema = z.object({
  planId: z.string().uuid(),
  // visual = 화면만 다시(말 · 후킹 · 캡션 유지), script = 대본부터 다시(메모 반영)
  kind: z.enum(["visual", "script"]),
  memo: z.string().trim().max(500).optional(),
});

/**
 * 완성본이 마음에 들지 않을 때 다시 만든다. 메모는 이 칸에만 적용한다(계정 설정은 바꾸지 않는다).
 *   화면만 다시: 저장된 장면표의 말 · 후킹 · 캡션은 그대로 두고 화면 소재만 다시 고른다.
 *   대본부터 다시: 장면표를 버리고 메모를 반영해 처음부터 쓴다.
 */
export async function remakeVideoAction(input: z.infer<typeof remakeSchema>): Promise<ConfirmResult> {
  const parsed = remakeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const plan = await loadPlan(service, parsed.data.planId, auth.orgId);
  if (!plan) return { ok: false, error: "칸을 찾을 수 없습니다." };
  if (plan.status !== "RENDERED" && plan.status !== "BLOCKED") return { ok: false, error: "완성본이 있거나 멈춘 칸만 다시 만들 수 있어요." };
  const { kind, memo } = parsed.data;
  const { data: row } = await service.from("content_plans").select("script, video, storyboard").eq("id", plan.id).maybeSingle();
  if (kind === "visual" && !row?.storyboard) return { ok: false, error: "저장된 장면표가 없는 칸이에요. '대본부터 다시'로 만들어 주세요." };
  const old = (row?.video ?? {}) as { path?: string; thumbnail?: string };
  const released = await releaseOldPublish(service, plan.id);
  if (!released.ok) return released;
  const { data: moved, error } = await service
    .from("content_plans")
    // remake · redo: 오래된 칸이어도 사람이 다시 만들라고 했으니 워커가 만든다
    .update({
      ...(kind === "visual" ? { status: "SCRIPTED" } : { status: "CONFIRMED", storyboard: null, script: null }),
      redo: { kind, ...(memo ? { memo } : {}), at: new Date().toISOString() } as Json,
      video: { remake: true },
      making_since: null,
      check_result: null,
      note: null,
      error: null,
    })
    .eq("id", plan.id)
    .eq("status", plan.status)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!moved?.length) return { ok: false, error: "상태가 바뀌었어요. 새로 고쳐 주세요." };
  // 발행 작업이 쓰던 파일은 발행 기록에 남겨 둔다
  const files = released.hadJob ? [] : [old.path, old.thumbnail].filter((p): p is string => !!p);
  if (files.length) await service.storage.from("media").remove(files);
  await triggerAutoVideoRun(`remake ${plan.id}`).catch((e) => console.error("[auto] 영상 트리거 실패:", e));
  revalidatePath("/auto/confirm");
  return { ok: true };
}

export async function skipPlanAction(input: z.infer<typeof idSchema>): Promise<ConfirmResult> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;

  const service = createServiceClient();
  const plan = await loadPlan(service, parsed.data.planId, auth.orgId);
  if (!plan) return { ok: false, error: "기획안을 찾을 수 없습니다." };
  if (plan.status !== "PROPOSED" && plan.status !== "CONFIRMED" && plan.status !== "BLOCKED" && plan.status !== "RENDERED") {
    return { ok: false, error: "이미 다음 단계로 넘어간 칸입니다." };
  }
  const released = await releaseOldPublish(service, plan.id);
  if (!released.ok) return released;
  const { data: skipped, error } = await service
    .from("content_plans")
    .update({ status: "SKIPPED", note: "사람이 건너뜀", confirmed_by: auth.userId, confirmed_at: new Date().toISOString() })
    .eq("id", plan.id)
    .eq("status", plan.status)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!skipped?.length) return { ok: false, error: "상태가 바뀌었어요. 새로 고쳐 주세요." };
  revalidatePath("/auto/confirm");
  return { ok: true };
}

// accountId가 있으면 그 계정 칸만 확인한다(계정 탭)
const dateSchema = z.object({ slotDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), accountId: z.string().uuid().optional() });

/** 그날 제안된 칸 모두 그대로 확인 (마감 전 · 판매 중인 상품만 — 판매 중이 아닌 칸은 남겨 두고 알려 준다). */
export async function confirmAllAction(input: z.infer<typeof dateSchema>): Promise<ConfirmResult> {
  const parsed = dateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;

  const service = createServiceClient();
  let query = service
    .from("content_plans")
    .select("id, slot_date, slot_time, products(stock_status)")
    .eq("organization_id", auth.orgId)
    .eq("slot_date", parsed.data.slotDate)
    .eq("track", "B")
    .eq("status", "PROPOSED")
    .not("product_id", "is", null);
  if (parsed.data.accountId) query = query.eq("social_account_id", parsed.data.accountId);
  const { data: plans, error } = await query;
  if (error) return { ok: false, error: error.message };
  const open = (plans ?? []).filter((p) => !isPastSlot(p.slot_date as string, p.slot_time as string));
  const ids = open.filter((p) => p.products?.stock_status === "available").map((p) => p.id);
  const soldOut = open.length - ids.length;
  if (ids.length === 0) return { ok: true, count: 0, soldOut };

  const { error: upErr } = await service
    .from("content_plans")
    .update({ status: "CONFIRMED", confirmed_by: auth.userId, confirmed_at: new Date().toISOString() })
    .in("id", ids)
    .eq("status", "PROPOSED");
  if (upErr) return { ok: false, error: upErr.message };
  await triggerAutoVideoRun(`confirm-all ${parsed.data.slotDate}`).catch((e) => console.error("[auto] 영상 트리거 실패:", e));
  revalidatePath("/auto/confirm");
  return { ok: true, count: ids.length, soldOut };
}

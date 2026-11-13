"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { loadAccountConcept } from "@/lib/agents/concept";
import { applyRevision, quotedTexts, revisionChanges, ruleNotes, writeEditRevision, type EditRevision, type RevisionChange, type SavedEditPlan } from "@/lib/agents/edit-revise";
import { loadProductFacts, type ProductFacts } from "@/lib/agents/product-facts";
import { getCurrentProfile, getSessionUser } from "@/lib/auth";
import { getInstagramAuth } from "@/lib/episode-alerts/server";
import { triggerShootEditRun, triggerShootPlanRun, triggerShotlistRun } from "@/lib/github-dispatch";
import { listRecentMedia } from "@/lib/platforms/instagram-insights";
import { groupNameOf, pickShopTag, withShopTagText } from "@/lib/products/shop-tag";
import { searchScopedProducts, type SearchGroup, type SearchHit } from "@/lib/products/search";
import type { ProductKind } from "@/lib/products/shops";
import type { ContentRule } from "@/lib/rules/check";
import { duplicateWarning } from "@/lib/shoot/duplicates";
import { certifiedFunctionsOf, finalBlocking } from "@/lib/shoot/final-check";
import { buildPackageTexts, safeFileName, type PackageCut, type PackageScript, type PackageSegment, type TextFile } from "@/lib/shoot/package";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// 직접 촬영 콘텐츠(0030 · 0042). 계정별 기획 목록에서 고르거나 원하는 상품을 추가 → 컷 리스트(워커) →
// 찍은 촬영본을 개수 · 순서 상관없이 올리고 "다 올렸어요" → 자동 편집(컷 리스트는 추천 대본으로만 쓴다) → 완성본 · 다시 편집용 파일 받기 → 사람이 직접 올리고 "올렸어요" + 릴스 연결.
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

const chooseSchema = z.object({ planId: z.string().uuid(), brief: z.string().trim().max(300).nullable().optional(), force: z.boolean().optional() });

/**
 * 목록의 기획으로 찍기 — 컷 리스트를 쓰게 한다. 다른 계정과 겹치거나 최근에 쓴 상품이면 경고 뒤 진행(force).
 * brief = 이 상품으로 하고 싶은 말(human_brief). 추천 대본과 편집 에이전트가 가장 먼저 따른다.
 */
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
    .update({
      status: "CONFIRMED",
      proposal: proposal as unknown as Json,
      ...(parsed.data.brief !== undefined ? { human_brief: parsed.data.brief || null } : {}),
      note: null,
      error: null,
      confirmed_by: auth.userId,
      confirmed_at: new Date().toISOString(),
    })
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

export type ProductHit = SearchHit;

const searchSchema = z.object({ accountId: z.string().uuid(), query: z.string().trim().min(1).max(50) });

/** 원하는 상품 찾기 — 이 계정이 쓰는 몰 · 종류, 판매 중, 분석 완료만. 종류별로 묶어 검색어에 가까운 순서로. */
export async function searchProductsAction(
  input: z.infer<typeof searchSchema>,
): Promise<{ ok: true; groups: SearchGroup[] } | { ok: false; error: string }> {
  const parsed = searchSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "검색어를 입력하세요." };
  const auth = await authorize("plan");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const settings = await accountSettings(service, parsed.data.accountId, auth.orgId);
  if (!settings) return { ok: false, error: "촬영 설정에 없는 계정이에요." };
  try {
    return { ok: true, groups: await searchScopedProducts(service, (settings.product_scopes ?? []) as { shop: string; kind: string }[], parsed.data.query) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "상품을 찾지 못했어요." };
  }
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
  if (plan.shoot_requests) {
    const { error: reqError } = await service.from("shoot_requests").update({ status: "CANCELLED" }).eq("id", plan.shoot_requests.id);
    if (reqError) {
      console.error("[shoot] 촬영 요청 멈추기 실패:", reqError.message);
      return { ok: false, error: "기획은 뺐지만 올린 촬영본의 편집을 멈추지 못했어요. 새로 고쳐 확인해 주세요." };
    }
  }
  revalidateShoot();
  return { ok: true };
}

// ─── 촬영 · 올리기 ────────────────────────────────────────────────────────────

/**
 * 촬영본(shoot_requests.clips). cut = 촬영본 순서 번호(1부터). 예전엔 컷마다 하나씩 올려 컷 번호와 같았다.
 * free = 컷과 상관없이 올린 촬영본(2026-11-10~). 없으면 예전 방식이라 같은 번호 컷의 설명을 편집 힌트로 쓴다.
 * on_screen_override · subtitle_override = 예전 방식(완성본 받기의 칸별 입력)으로 사람이 고친 화면 문구 · 자막.
 * 지금은 새로 저장하지 않고, 완성본 고치기로 다시 편집할 때 지운다(confirmRevisionAction).
 */
type Clip = {
  cut: number;
  path: string;
  name: string;
  size: number;
  type: string;
  uploaded_at: string;
  uploaded_by: string;
  free?: boolean;
  on_screen_override?: string | null;
  subtitle_override?: string | null;
};

// 한 촬영 요청에 올릴 수 있는 촬영본 수 — 편집 에이전트가 프레임을 한 번에 보는 양에 맞춘다
const MAX_CLIPS = 20;

/** 순서대로 1부터 다시 매긴다. 번호가 바뀌면 예전 컷과의 짝이 깨지니 모두 free로 둔다. */
function renumber(clips: Clip[]): Clip[] {
  return clips.map((c, i) => ({ ...c, cut: i + 1, free: true }));
}

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
    // 바꿀 것이 없으면(이미 등록 · 이미 지움 · 끝 칸에서 옮기기) 저장하지 않는다
    if (!Object.keys(r.patch).length) return { ok: true };
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

const MAX_CLIP_BYTES = 1024 * 1024 * 1024; // media 버킷 한도(0014)와 같게

const clipSchema = z.object({
  requestId: z.string().uuid(),
  path: z.string().min(1).max(300),
  name: z.string().max(200),
  size: z.number().int().min(1).max(MAX_CLIP_BYTES),
  type: z.string().max(100),
});

/**
 * 촬영본 등록 — 브라우저가 media 버킷에 올린 뒤 부른다. 컷과 상관없이 맨 뒤에 붙는다(2026-11-10).
 * 예전엔 컷마다 하나씩 올려야 해 컷 리스트대로 못 찍으면 편집을 못 했다. 같은 파일을 두 번 등록하면 한 번만 남긴다.
 */
export async function addClipAction(input: z.infer<typeof clipSchema>): Promise<ShootResult> {
  const parsed = clipSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize("shoot");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const r = await updateRequestJson(service, parsed.data.requestId, auth.orgId, (req) => {
    if (req.status !== "OPEN") return "이미 편집으로 넘어간 촬영 요청입니다.";
    if (!parsed.data.path.startsWith(`${auth.orgId}/${auth.userId}/shoot/${req.id}/`)) return "잘못된 파일 경로";
    const clips = ((req.clips ?? []) as Clip[]).slice().sort((a, b) => a.cut - b.cut);
    if (clips.some((c) => c.path === parsed.data.path)) return { patch: {} };
    if (clips.length >= MAX_CLIPS) return `촬영본은 ${MAX_CLIPS}개까지 올릴 수 있어요. 안 쓸 촬영본을 지워 주세요.`;
    const next: Clip[] = [
      ...clips,
      {
        cut: (clips.at(-1)?.cut ?? 0) + 1,
        path: parsed.data.path,
        name: parsed.data.name,
        size: parsed.data.size,
        type: parsed.data.type,
        uploaded_at: new Date().toISOString(),
        uploaded_by: auth.userId,
        free: true,
      },
    ];
    return { patch: { clips: next as unknown as Json } };
  });
  if (!r.ok) return r;
  revalidatePath("/shoot/uploads");
  return { ok: true };
}

const removeSchema = z.object({ requestId: z.string().uuid(), path: z.string().min(1).max(300) });

/** 촬영본 지우기 — 남은 촬영본 번호를 1부터 다시 매긴다. */
export async function removeClipAction(input: z.infer<typeof removeSchema>): Promise<ShootResult> {
  const parsed = removeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize("shoot");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const r = await updateRequestJson(service, parsed.data.requestId, auth.orgId, (req) => {
    if (req.status !== "OPEN") return "이미 편집으로 넘어간 촬영 요청입니다.";
    const clips = ((req.clips ?? []) as Clip[]).slice().sort((a, b) => a.cut - b.cut);
    const old = clips.filter((c) => c.path === parsed.data.path);
    if (!old.length) return { patch: {} };
    return {
      patch: { clips: renumber(clips.filter((c) => c.path !== parsed.data.path)) as unknown as Json },
      // 파일은 저장이 된 뒤에만 지운다
      after: async () => {
        await service.storage.from("media").remove(old.map((c) => c.path));
      },
    };
  });
  if (!r.ok) return r;
  revalidatePath("/shoot/uploads");
  return { ok: true };
}

const moveSchema = z.object({ requestId: z.string().uuid(), path: z.string().min(1).max(300), dir: z.enum(["up", "down"]) });

/** 촬영본 순서 바꾸기 — 한 칸 위 · 아래로. 편집은 이 순서를 기본 흐름으로 본다. */
export async function moveClipAction(input: z.infer<typeof moveSchema>): Promise<ShootResult> {
  const parsed = moveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize("shoot");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const r = await updateRequestJson(service, parsed.data.requestId, auth.orgId, (req) => {
    if (req.status !== "OPEN") return "이미 편집으로 넘어간 촬영 요청입니다.";
    const clips = ((req.clips ?? []) as Clip[]).slice().sort((a, b) => a.cut - b.cut);
    const i = clips.findIndex((c) => c.path === parsed.data.path);
    const j = parsed.data.dir === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= clips.length) return { patch: {} };
    [clips[i], clips[j]] = [clips[j], clips[i]];
    return { patch: { clips: renumber(clips) as unknown as Json } };
  });
  if (!r.ok) return r;
  revalidatePath("/shoot/uploads");
  return { ok: true };
}

const briefSchema = z.object({ planId: z.string().uuid(), brief: z.string().trim().max(300) });

/** 이 상품으로 하고 싶은 말(human_brief) — 촬영 화면에서 고친다. 편집 에이전트가 추천 대본보다 먼저 따른다. */
export async function saveBriefAction(input: z.infer<typeof briefSchema>): Promise<ShootResult> {
  const parsed = briefSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "하고 싶은 말은 300자까지 넣을 수 있어요." };
  const auth = await authorize("shoot");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const { data: moved, error } = await service
    .from("content_plans")
    .update({ human_brief: parsed.data.brief || null })
    .eq("id", parsed.data.planId)
    .eq("organization_id", auth.orgId)
    .eq("track", "A")
    .neq("status", "PUBLISHED")
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!moved?.length) return { ok: false, error: "기획을 찾을 수 없거나 이미 올린 기획이에요." };
  revalidatePath("/shoot/uploads");
  return { ok: true };
}

const remakeShotlistSchema = z.object({ requestId: z.string().uuid() });

/**
 * 촬영 가이드 다시 만들기 — 바뀐 하고 싶은 말로 추천 대본(컷 목록)을 다시 쓴다. 하고 싶은 말을 고쳐도 자동으로 다시 쓰지 않는다.
 * 컷 목록 워커가 촬영 요청을 새로 쓰며 촬영본 · 편집본을 비우므로, 촬영본을 올리기 전(OPEN · 촬영본 0개)에만 된다.
 * 기획을 CONFIRMED로 돌리면 워커(write-a-shotlists)가 다시 집는다. 사람이 적은 후킹 · 표지 문구는 워커가 그대로 둔다.
 */
export async function remakeShotlistAction(input: z.infer<typeof remakeShotlistSchema>): Promise<ShootResult> {
  const parsed = remakeShotlistSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize("shoot");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const { data: request, error: reqErr } = await service
    .from("shoot_requests")
    .select("id, status, clips, plan_id")
    .eq("id", parsed.data.requestId)
    .eq("organization_id", auth.orgId)
    .maybeSingle();
  if (reqErr) return { ok: false, error: reqErr.message };
  if (!request) return { ok: false, error: "촬영 요청을 찾을 수 없습니다." };
  if (request.status !== "OPEN" || ((request.clips ?? []) as unknown[]).length > 0) {
    return { ok: false, error: "촬영본을 올린 뒤에는 촬영 가이드를 다시 만들 수 없어요. 하고 싶은 말은 편집할 때 반영돼요." };
  }
  const { data: moved, error } = await service
    .from("content_plans")
    .update({ status: "CONFIRMED", note: null, error: null })
    .eq("id", request.plan_id)
    .eq("organization_id", auth.orgId)
    .eq("track", "A")
    .eq("status", "SCRIPTED")
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!moved?.length) return { ok: false, error: "이미 다시 만드는 중이거나 촬영 대기가 아닌 기획이에요." };
  // 실패해도 다음 05시 실행이 집어 간다 — 즉시성만 손해
  await triggerShotlistRun(`plan ${request.plan_id}`).catch((e) => console.error("[shoot] 컷 리스트 트리거 실패:", e));
  revalidateShoot();
  return { ok: true };
}

const finishSchema = z.object({ requestId: z.string().uuid() });

/** 다 올렸어요 → 편집 대기. 촬영본이 하나 이상 있으면 된다. */
export async function finishUploadAction(input: z.infer<typeof finishSchema>): Promise<ShootResult> {
  const parsed = finishSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize("shoot");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const req = await loadRequest(service, parsed.data.requestId, auth.orgId);
  if (!req) return { ok: false, error: "촬영 요청을 찾을 수 없습니다." };
  if (req.status !== "OPEN") return { ok: false, error: "이미 편집으로 넘어간 촬영 요청입니다." };
  const clips = (req.clips ?? []) as Clip[];
  if (!clips.length) return { ok: false, error: "촬영본을 하나 이상 올려 주세요." };

  const { data: moved, error } = await service
    .from("shoot_requests")
    .update({ status: "UPLOADED", uploaded_at: new Date().toISOString(), error: null })
    .eq("id", req.id)
    .eq("status", "OPEN")
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!moved?.length) return { ok: false, error: "이미 편집으로 넘어간 촬영 요청입니다." };
  const { error: planError } = await service.from("content_plans").update({ status: "SHOT" }).eq("id", req.plan_id).in("status", ["SCRIPTED", "SHOT"]);
  if (planError) {
    console.error("[shoot] 기획 상태(SHOT) 저장 실패:", planError.message);
    return { ok: false, error: "기획 상태를 바꾸지 못했어요. 새로 고쳐 주세요." };
  }
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

const reEditSchema = z.object({ requestId: z.string().uuid() });

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

/**
 * 다시 편집 시작 — 촬영 요청을 편집 대기(UPLOADED), 기획을 SHOT으로 돌리고 편집 워커를 깨운다.
 * patch = 상태와 함께 저장할 값(고친 편집 계획 등). 그사이 상태가 바뀌었으면 아무것도 저장하지 않는다.
 */
async function startReEdit(
  service: Service,
  req: { id: string; plan_id: string },
  from: ("EDITED" | "FAILED")[],
  patch: { clips?: Json; cuts?: Json; edit?: Json },
  reason: string,
): Promise<ShootResult> {
  const { data: moved, error } = await service
    .from("shoot_requests")
    .update({ ...patch, status: "UPLOADED", error: null })
    .eq("id", req.id)
    .in("status", from)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!moved?.length) return { ok: false, error: "상태가 바뀌었어요. 새로 고쳐 주세요." };
  const { error: planError } = await service.from("content_plans").update({ status: "SHOT" }).eq("id", req.plan_id).in("status", ["RENDERED", "SHOT"]);
  if (planError) {
    console.error("[shoot] 기획 상태(SHOT) 저장 실패:", planError.message);
    return { ok: false, error: "기획 상태를 바꾸지 못했어요. 새로 고쳐 주세요." };
  }
  await triggerShootEditRun(reason).catch((e) => console.error("[shoot] 편집 트리거 실패:", e));
  revalidatePath("/shoot/review");
  revalidatePath("/shoot/uploads");
  return { ok: true };
}

/**
 * 같은 촬영본으로 다시 편집 — 실패한 편집을 다시 시도하거나, 편집 계획 없이(기본 편집) 만든 완성본을 다시 만들 때.
 * 완성본의 글 · 장면 · 음악을 고치는 것은 proposeRevisionAction → confirmRevisionAction이 한다.
 */
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
  return startReEdit(service, req, ["EDITED", "FAILED"], {}, `re-edit ${req.id}`);
}

// ─── 완성본 고치기 ────────────────────────────────────────────────────────────
// 고칠 내용을 적으면 → AI가 저장된 편집 계획에서 바꿀 곳만 답하고(앱에서 바로) → 전 → 후 목록을 확인한 뒤 → 다시 편집한다.
// 확인 전까지는 완성본 · 편집 계획이 바뀌지 않는다. 고친 계획은 shoot_requests.edit.revision에 잠깐 둔다.

/** 워커가 저장한 편집 키트 결과(shoot_requests.edit.kit). replan = 촬영본을 다시 보고 계획을 다시 세울 요청(워커가 읽는다). */
type SavedKit = { plan?: SavedEditPlan; replan?: { request: string; items: string[] } } & Record<string, unknown>;
/** 확인을 기다리는 고친 계획(shoot_requests.edit.revision). */
type SavedRevision = {
  id: string;
  request: string;
  plan: SavedEditPlan;
  // 촬영본을 다시 봐야 하는 요청 — 확인하면 워커가 프레임을 다시 보고 계획을 다시 세운다
  footage: string[];
  repickMusic: boolean;
  repickDesign: boolean;
  // 다시 편집할 때 사람이 정한 글(script.human)로 저장할 후킹 · 표지. null이면 저장하지 않는다
  humanHook: string | null;
  humanThumbnail: string | null;
  createdAt: string;
};
type SavedEdit = { kit?: SavedKit | null; revision?: SavedRevision | null } & Record<string, unknown>;
type FixedScript = { fixed?: { hook?: { text?: string } | null; ending?: { text?: string } | null }; human?: { hook?: string | null; thumbnail?: string | null } };

async function loadRequestWithEdit(service: Service, requestId: string, orgId: string) {
  const { data } = await service
    .from("shoot_requests")
    .select("id, plan_id, status, cuts, clips, edit, updated_at")
    .eq("id", requestId)
    .eq("organization_id", orgId)
    .maybeSingle();
  return data;
}

async function loadActiveRules(service: Service): Promise<ContentRule[]> {
  const { data } = await service.from("content_rules").select("id, scope, rule_type, phrase, match_type, reason, suggestion").eq("active", true);
  return (data ?? []).map((r) => ({
    id: r.id,
    scope: r.scope as ContentRule["scope"],
    ruleType: r.rule_type as ContentRule["ruleType"],
    phrase: r.phrase,
    matchType: r.match_type as ContentRule["matchType"],
    reason: r.reason,
    suggestion: r.suggestion,
  }));
}

// Vercel 함수 제한(60초, review/page.tsx의 maxDuration)보다 먼저 멈추고 안내한다
const REVISE_TIMEOUT_MS = 50_000;
const REVISE_TIMEOUT = "revise-timeout";

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(REVISE_TIMEOUT)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

const proposeSchema = z.object({ requestId: z.string().uuid(), request: z.string().trim().min(1).max(500) });

export type RevisionProposal =
  | {
      ok: true;
      // 확인을 누를 때 보내는 번호. 바뀌는 내용이 없으면 null(저장하지 않음)
      revisionId: string | null;
      changes: RevisionChange[];
      // 촬영본을 다시 보고 고를 요청
      footage: string[];
      // 반영하지 못한 요청과 이유
      cannot: { request: string; reason: string }[];
      // 요청한 말을 고쳐 쓴 이유 · 광고 문구 규칙 경고
      notes: string[];
    }
  | { ok: false; error: string };

/**
 * 고칠 내용 → 바뀔 내용 확인. AI가 저장된 편집 계획에서 바꿀 곳만 답하고, 코드가 계획 사본에 적용해 전 → 후 목록을 만든다.
 * 고친 계획은 edit.revision에 두고, 완성본 · 편집 계획 · 상태는 confirmRevisionAction 전까지 그대로다.
 */
export async function proposeRevisionAction(input: z.infer<typeof proposeSchema>): Promise<RevisionProposal> {
  const parsed = proposeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "고칠 내용을 500자 안으로 적어 주세요." };
  const auth = await authorize("plan");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const req = await loadRequestWithEdit(service, parsed.data.requestId, auth.orgId);
  if (!req) return { ok: false, error: "촬영 요청을 찾을 수 없습니다." };
  if (req.status !== "EDITED") return { ok: false, error: "편집이 끝난 완성본만 고칠 수 있어요." };
  const edit = (req.edit ?? {}) as SavedEdit;
  const plan = edit.kit?.plan;
  if (!plan?.beats?.length) return { ok: false, error: "편집 계획이 없어요. 기본 편집으로 만든 완성본은 ‘다시 편집’으로 새로 만들어 주세요." };
  const { data: planRow } = await service
    .from("content_plans")
    .select("status, product_id, social_account_id, script, social_accounts(display_name)")
    .eq("id", req.plan_id)
    .maybeSingle();
  if (!planRow || !["SHOT", "RENDERED"].includes(planRow.status)) return { ok: false, error: "이미 올렸거나 끝난 기획이라 다시 편집할 수 없어요." };
  if (!planRow.product_id) return { ok: false, error: "상품이 없는 기획이에요." };
  const script = (planRow.script ?? {}) as FixedScript;
  const pins = { humanHook: script.human?.hook, humanThumbnail: script.human?.thumbnail, fixedHook: script.fixed?.hook?.text, fixedEnding: script.fixed?.ending?.text };

  let revision: EditRevision;
  let facts: ProductFacts;
  let rules: ContentRule[];
  try {
    const [loadedFacts, loadedRules, concept] = await Promise.all([loadProductFacts(service, planRow.product_id), loadActiveRules(service), loadAccountConcept(service, planRow.social_account_id)]);
    facts = loadedFacts;
    rules = loadedRules;
    const res = await withTimeout(
      writeEditRevision({
        service,
        planId: req.plan_id,
        accountName: planRow.social_accounts?.display_name ?? "",
        facts,
        rules,
        plan,
        request: parsed.data.request,
        pins,
        tone: concept.shootTone,
      }),
      REVISE_TIMEOUT_MS,
    );
    revision = res.output;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[shoot] 바뀔 내용 확인 실패:", message);
    if (message === REVISE_TIMEOUT) return { ok: false, error: "AI 응답이 늦어서 멈췄어요. 고칠 내용을 나눠 적거나 잠시 뒤 다시 해 주세요." };
    return { ok: false, error: `바뀔 내용을 정리하지 못했어요. 다시 해 주세요. (${message.slice(0, 160)})` };
  }

  const quoted = quotedTexts(parsed.data.request);
  const applied = applyRevision(plan, revision, { pins, quoted });
  const changes = revisionChanges(plan, applied);
  const clean = (list: string[]) => [...new Set(list.map((t) => t.trim()).filter(Boolean))];
  const footage = clean(revision.footage).slice(0, 8);
  const cannot = [...revision.cannot.map((c) => ({ request: c.request.trim(), reason: c.reason.trim() })).filter((c) => c.request || c.reason), ...applied.rejected];
  const notes = clean([...revision.notes, ...ruleNotes(plan, applied.plan, { facts, rules, quoted })]);
  // 바뀌는 것이 없으면 저장하지 않고, 반영하지 못한 이유만 알려 준다
  if (!changes.length && !footage.length) return { ok: true, revisionId: null, changes: [], footage: [], cannot, notes };

  const saved: SavedRevision = {
    id: crypto.randomUUID(),
    request: parsed.data.request,
    plan: applied.plan,
    footage,
    repickMusic: applied.repickMusic,
    repickDesign: applied.repickDesign,
    humanHook: applied.humanHook,
    humanThumbnail: applied.humanThumbnail,
    createdAt: new Date().toISOString(),
  };
  // AI를 기다리는 사이 다시 편집 · 다시 올리기가 시작됐으면 저장하지 않는다
  const { data: stored, error } = await service
    .from("shoot_requests")
    .update({ edit: { ...edit, revision: saved } as unknown as Json })
    .eq("id", req.id)
    .eq("status", "EDITED")
    .eq("updated_at", req.updated_at)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!stored?.length) return { ok: false, error: "그사이 상태가 바뀌었어요. 새로 고쳐 주세요." };
  return { ok: true, revisionId: saved.id, changes, footage, cannot, notes };
}

const confirmSchema = z.object({ requestId: z.string().uuid(), revisionId: z.string().uuid() });

/**
 * 이대로 다시 편집 — 확인한 고친 계획을 저장하고 편집 워커를 깨운다.
 * 촬영본을 다시 봐야 하는 요청이 있으면 edit.kit.replan에 남겨, 워커가 프레임을 다시 보고 계획을 다시 세운다.
 */
export async function confirmRevisionAction(input: z.infer<typeof confirmSchema>): Promise<ShootResult> {
  const parsed = confirmSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize("plan");
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const req = await loadRequestWithEdit(service, parsed.data.requestId, auth.orgId);
  if (!req) return { ok: false, error: "촬영 요청을 찾을 수 없습니다." };
  if (req.status !== "EDITED") return { ok: false, error: "편집이 끝난 완성본만 고칠 수 있어요." };
  const { revision, kit, ...restEdit } = (req.edit ?? {}) as SavedEdit;
  if (!revision || revision.id !== parsed.data.revisionId || !kit?.plan) return { ok: false, error: "확인한 내용이 바뀌었어요. ‘바뀔 내용 확인’을 다시 눌러 주세요." };
  const { data: planRow } = await service.from("content_plans").select("status").eq("id", req.plan_id).maybeSingle();
  if (!planRow || !["SHOT", "RENDERED"].includes(planRow.status)) return { ok: false, error: "이미 올렸거나 끝난 기획이라 다시 편집할 수 없어요." };

  // 바뀐 후킹 · 표지 글자가 사람이 정한 글이면 그 글로 저장한다 — 안 그러면 워커가 예전에 정한 글로 되돌린다(applyHumanText)
  if (revision.humanHook != null || revision.humanThumbnail != null) {
    const failed = await saveHumanText(service, req.plan_id, {
      ...(revision.humanHook != null ? { hook: revision.humanHook } : {}),
      ...(revision.humanThumbnail != null ? { thumbnail: revision.humanThumbnail } : {}),
    });
    if (failed) return { ok: false, error: failed };
  }
  // 예전 방식(칸별 입력)으로 저장된 컷별 문구는 지운다 — 저장된 계획에 이미 반영돼 있고, 남기면 워커가 방금 고친 글을 다시 덮어쓴다
  const dropOverrides = <T extends { on_screen_override?: string | null; subtitle_override?: string | null }>(rows: T[]) =>
    rows.map(({ on_screen_override: _onScreen, subtitle_override: _subtitle, ...row }) => {
      void _onScreen;
      void _subtitle;
      return row;
    });
  const { replan: _replan, ...restKit } = kit;
  void _replan;
  const nextEdit = {
    ...restEdit,
    kit: { ...restKit, plan: revision.plan, ...(revision.footage.length ? { replan: { request: revision.request, items: revision.footage } } : {}) },
  };
  return startReEdit(
    service,
    req,
    ["EDITED"],
    {
      edit: nextEdit as unknown as Json,
      ...(Array.isArray(req.clips) ? { clips: dropOverrides(req.clips as Clip[]) as unknown as Json } : {}),
      // 예전 촬영본은 컷 목록에 문구가 남아 있을 수 있다
      ...(Array.isArray(req.cuts) ? { cuts: dropOverrides(req.cuts as { on_screen_override?: string | null; subtitle_override?: string | null }[]) as unknown as Json } : {}),
    },
    `revise ${req.id}`,
  );
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
  const { error: planError } = await service.from("content_plans").update({ status: "SCRIPTED" }).eq("id", req.plan_id).in("status", ["SHOT", "RENDERED"]);
  if (planError) {
    console.error("[shoot] 기획 상태(SCRIPTED) 저장 실패:", planError.message);
    return { ok: false, error: "기획 상태를 바꾸지 못했어요. 새로 고쳐 주세요." };
  }
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
      "id, status, product_id, social_account_id, script, warnings_ack, social_accounts(display_name, account_groups(name)), shoot_requests(id, status, rendered_path, edit, cuts, clips)",
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
    if (blocking.some((b) => !acked.has(b))) return { ok: false, error: "경고 내용을 먼저 확인해 주세요." };
  }

  const account = plan.social_accounts?.display_name ?? "";
  const { data: productRow } = plan.product_id ? await service.from("products").select("name, shop_code").eq("id", plan.product_id).maybeSingle() : { data: null };
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
      caption: withShopTagText(script?.caption?.text ?? "", pickShopTag(productRow?.shop_code, groupNameOf(plan.social_accounts?.account_groups))),
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

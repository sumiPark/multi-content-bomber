"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile, getSessionUser } from "@/lib/auth";
import { isPastDeadline, isPastSlot } from "@/lib/automation/deadline";
import { triggerAutoScriptRun } from "@/lib/github-dispatch";
import { createServiceClient } from "@/lib/supabase/service";

// AI 자동 업로드 상품 확인 (0028 content_plans). 사람은 상품만 확인하고, 이후 대본 · 점검은 자동(영상 · 게시는 준비 중).
// 확인 마감(올리는 날 track_settings.b_confirm_deadline, 기본 07:00)이 지나면 고칠 수 없다.
// 점검에 걸려 멈춘 칸(BLOCKED)은 마감이 지나도 올릴 시각 전까지 다시 쓰기 · 다른 상품으로 바꾸기 · 건너뛰기를 할 수 있다.

export type ConfirmResult = { ok: true; count?: number; soldOut?: number } | { ok: false; error: string };

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

/** 계정별 확인 마감 (track_settings, 기본 07:00 — 올리는 날). */
async function deadlines(service: Service, accountIds: string[]): Promise<Map<string, string>> {
  const { data } = await service
    .from("track_settings")
    .select("social_account_id, b_confirm_deadline")
    .in("social_account_id", accountIds);
  return new Map((data ?? []).map((r) => [r.social_account_id, r.b_confirm_deadline]));
}

async function loadPlan(service: Service, planId: string, orgId: string) {
  const { data } = await service
    .from("content_plans")
    .select("id, status, slot_date, slot_time, product_id, product_changed, proposal, social_account_id")
    .eq("id", planId)
    .eq("organization_id", orgId)
    .eq("track", "B")
    .maybeSingle();
  if (!data) return null;
  const d = await deadlines(service, [data.social_account_id]);
  return { ...data, deadline: d.get(data.social_account_id) ?? "07:00" };
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
  const fixing = plan.status === "BLOCKED";
  if (plan.status !== "PROPOSED" && plan.status !== "CONFIRMED" && !fixing) {
    return { ok: false, error: "이미 다음 단계로 넘어간 칸이라 바꿀 수 없어요." };
  }
  if (fixing ? isPastSlot(plan.slot_date, plan.slot_time) : isPastDeadline(plan.slot_date, plan.deadline)) {
    return { ok: false, error: fixing ? "올릴 시각이 지난 칸이에요." : "확인 마감이 지났어요. 이 칸은 건너뜁니다." };
  }

  const nextProduct = parsed.data.productId ?? plan.product_id;
  if (!nextProduct) return { ok: false, error: "상품이 없는 칸입니다." };
  if (parsed.data.productId) {
    // 바꿀 수 있는 건 에이전트가 낸 대안뿐 — 규칙(판매 중 · 분석 완료 · 최근 미사용)을 통과한 후보라서.
    const alts = ((plan.proposal as { alternatives?: { product_id: string }[] })?.alternatives ?? []).map((a) => a.product_id);
    if (!alts.includes(parsed.data.productId)) return { ok: false, error: "대안 목록에 없는 상품입니다." };
    // 대안은 제안할 때의 후보라 그사이 다른 칸이 쓰게 됐을 수 있다 — 같은 날 겹치지 않게
    const { data: used } = await service
      .from("content_plans")
      .select("id")
      .eq("organization_id", auth.orgId)
      .eq("slot_date", plan.slot_date)
      .eq("product_id", nextProduct)
      .neq("id", plan.id)
      .not("status", "in", "(SKIPPED,FAILED)")
      .limit(1);
    if (used?.length) return { ok: false, error: "같은 날 다른 칸에서 쓰는 상품이에요. 다른 후보를 골라 주세요." };
  }
  // 판매 중이 아니면 확인하지 않는다 — 확인해도 대본 단계에서 멈춘다(2026-11-04, 예전엔 그대로 확인됐다)
  const { data: product } = await service.from("products").select("stock_status").eq("id", nextProduct).maybeSingle();
  if (product?.stock_status !== "available") return { ok: false, error: "지금 판매 중이 아닌 상품이에요. 다른 후보로 바꾸거나 건너뛰어 주세요." };

  const { data: updated, error } = await service
    .from("content_plans")
    .update({
      status: "CONFIRMED",
      product_id: nextProduct,
      product_changed: plan.product_changed || nextProduct !== plan.product_id,
      confirmed_by: auth.userId,
      confirmed_at: new Date().toISOString(),
      // 멈춘 칸을 다시 쓰면 예전 대본 · 점검 결과는 지운다
      ...(fixing ? { script: null, check_result: null, note: null, error: null } : {}),
    })
    .eq("id", plan.id)
    .eq("status", plan.status)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!updated?.length) return { ok: false, error: "상태가 바뀌었어요. 새로 고쳐 주세요." };
  // 멈춘 칸은 시간이 없을 수 있어 바로 다시 쓴다(실패해도 다음 정기 실행이 집어 간다)
  if (fixing) await triggerAutoScriptRun(`rewrite ${plan.id}`).catch((e) => console.error("[auto] 대본 트리거 실패:", e));
  revalidatePath("/auto/confirm");
  return { ok: true };
}

const idSchema = z.object({ planId: z.string().uuid() });

export async function skipPlanAction(input: z.infer<typeof idSchema>): Promise<ConfirmResult> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;

  const service = createServiceClient();
  const plan = await loadPlan(service, parsed.data.planId, auth.orgId);
  if (!plan) return { ok: false, error: "기획안을 찾을 수 없습니다." };
  if (plan.status !== "PROPOSED" && plan.status !== "CONFIRMED" && plan.status !== "BLOCKED") {
    return { ok: false, error: "이미 다음 단계로 넘어간 칸입니다." };
  }
  const { error } = await service
    .from("content_plans")
    .update({ status: "SKIPPED", note: "사람이 건너뜀", confirmed_by: auth.userId, confirmed_at: new Date().toISOString() })
    .eq("id", plan.id)
    .eq("status", plan.status);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/auto/confirm");
  return { ok: true };
}

const dateSchema = z.object({ slotDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

/** 그날 제안된 칸 모두 그대로 확인 (마감 전 · 판매 중인 상품만 — 판매 중이 아닌 칸은 남겨 두고 알려 준다). */
export async function confirmAllAction(input: z.infer<typeof dateSchema>): Promise<ConfirmResult> {
  const parsed = dateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;

  const service = createServiceClient();
  const { data: plans, error } = await service
    .from("content_plans")
    .select("id, slot_date, social_account_id, products(stock_status)")
    .eq("organization_id", auth.orgId)
    .eq("slot_date", parsed.data.slotDate)
    .eq("track", "B")
    .eq("status", "PROPOSED")
    .not("product_id", "is", null);
  if (error) return { ok: false, error: error.message };
  const d = await deadlines(service, [...new Set((plans ?? []).map((p) => p.social_account_id))]);
  const open = (plans ?? []).filter((p) => !isPastDeadline(p.slot_date, d.get(p.social_account_id) ?? "07:00"));
  const ids = open.filter((p) => p.products?.stock_status === "available").map((p) => p.id);
  const soldOut = open.length - ids.length;
  if (ids.length === 0) return { ok: true, count: 0, soldOut };

  const { error: upErr } = await service
    .from("content_plans")
    .update({ status: "CONFIRMED", confirmed_by: auth.userId, confirmed_at: new Date().toISOString() })
    .in("id", ids)
    .eq("status", "PROPOSED");
  if (upErr) return { ok: false, error: upErr.message };
  revalidatePath("/auto/confirm");
  return { ok: true, count: ids.length, soldOut };
}

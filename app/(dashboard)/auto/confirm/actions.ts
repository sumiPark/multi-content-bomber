"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile, getSessionUser } from "@/lib/auth";
import { isPastDeadline } from "@/lib/automation/deadline";
import { createServiceClient } from "@/lib/supabase/service";

// B 상품 컨펌 (0028 content_plans). 사람은 상품만 확인하고, 이후 대본 · 영상 · 점검 · 예약은 자동.
// 확인 마감(올리는 날 track_settings.b_confirm_deadline, 기본 07:00)이 지나면 고칠 수 없다.

export type ConfirmResult = { ok: true; count?: number } | { ok: false; error: string };

async function authorize(): Promise<{ ok: true; userId: string; orgId: string } | { ok: false; error: string }> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "로그인이 필요합니다." };
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) return { ok: false, error: "소속된 조직이 없습니다." };
  if (profile.role !== "ADMIN" && profile.role !== "MANAGER") {
    return { ok: false, error: "컨펌 권한이 없습니다." };
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
    .select("id, status, slot_date, product_id, proposal, social_account_id")
    .eq("id", planId)
    .eq("organization_id", orgId)
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
  if (plan.status !== "PROPOSED" && plan.status !== "CONFIRMED") {
    return { ok: false, error: "이미 다음 단계로 넘어간 칸이라 바꿀 수 없어요." };
  }
  if (isPastDeadline(plan.slot_date, plan.deadline)) {
    return { ok: false, error: "컨펌 마감이 지났어요. 이 칸은 건너뜁니다." };
  }

  const nextProduct = parsed.data.productId ?? plan.product_id;
  if (!nextProduct) return { ok: false, error: "상품이 없는 칸입니다." };
  if (parsed.data.productId) {
    // 바꿀 수 있는 건 에이전트가 낸 대안뿐 — 규칙(판매 중 · 분석 완료 · 최근 미사용)을 통과한 후보라서.
    const alts = ((plan.proposal as { alternatives?: { product_id: string }[] })?.alternatives ?? []).map((a) => a.product_id);
    if (!alts.includes(parsed.data.productId)) return { ok: false, error: "대안 목록에 없는 상품입니다." };
  }

  const { error } = await service
    .from("content_plans")
    .update({
      status: "CONFIRMED",
      product_id: nextProduct,
      product_changed: nextProduct !== plan.product_id,
      confirmed_by: auth.userId,
      confirmed_at: new Date().toISOString(),
    })
    .eq("id", plan.id);
  if (error) return { ok: false, error: error.message };
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
  if (plan.status !== "PROPOSED" && plan.status !== "CONFIRMED") {
    return { ok: false, error: "이미 다음 단계로 넘어간 칸입니다." };
  }
  const { error } = await service
    .from("content_plans")
    .update({ status: "SKIPPED", note: "사람이 건너뜀", confirmed_by: auth.userId, confirmed_at: new Date().toISOString() })
    .eq("id", plan.id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/auto/confirm");
  return { ok: true };
}

const dateSchema = z.object({ slotDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

/** 그날 제안된 칸 모두 그대로 컨펌 (마감 전인 것만). */
export async function confirmAllAction(input: z.infer<typeof dateSchema>): Promise<ConfirmResult> {
  const parsed = dateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;

  const service = createServiceClient();
  const { data: plans, error } = await service
    .from("content_plans")
    .select("id, slot_date, social_account_id")
    .eq("organization_id", auth.orgId)
    .eq("slot_date", parsed.data.slotDate)
    .eq("track", "B")
    .eq("status", "PROPOSED")
    .not("product_id", "is", null);
  if (error) return { ok: false, error: error.message };
  const d = await deadlines(service, [...new Set((plans ?? []).map((p) => p.social_account_id))]);
  const ids = (plans ?? [])
    .filter((p) => !isPastDeadline(p.slot_date, d.get(p.social_account_id) ?? "07:00"))
    .map((p) => p.id);
  if (ids.length === 0) return { ok: true, count: 0 };

  const { error: upErr } = await service
    .from("content_plans")
    .update({ status: "CONFIRMED", confirmed_by: auth.userId, confirmed_at: new Date().toISOString() })
    .in("id", ids);
  if (upErr) return { ok: false, error: upErr.message };
  revalidatePath("/auto/confirm");
  return { ok: true, count: ids.length };
}

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile, getSessionUser } from "@/lib/auth";
import type { ProductKind } from "@/lib/products/shops";
import { checkText, isValidRegex, type ContentRule, type RuleHit } from "@/lib/rules/check";
import { createServiceClient } from "@/lib/supabase/service";

// 표현 규칙 · 건기식 심의 문구 (0026). 사람만 고치는 잠긴 항목이라 에이전트 피드백 경로는 없다.

export type RuleActionResult = { ok: true } | { ok: false; error: string };

async function authorize(): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "로그인이 필요합니다." };
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) return { ok: false, error: "소속된 조직이 없습니다." };
  if (profile.role !== "ADMIN" && profile.role !== "MANAGER") {
    return { ok: false, error: "표현 규칙을 고칠 권한이 없습니다." };
  }
  return { ok: true, userId: user.id };
}

const SCOPES = ["ALL", "FRUIT", "FOOD", "COSMETIC", "HEALTH_FOOD", "CLOTHING"] as const;

const ruleSchema = z
  .object({
    scope: z.enum(SCOPES),
    ruleType: z.enum(["BANNED", "REQUIRED"]),
    phrase: z.string().trim().min(1, "표현을 입력해 주세요.").max(200),
    matchType: z.enum(["CONTAINS", "REGEX"]),
    reason: z.string().trim().max(300).nullable(),
    suggestion: z.string().trim().max(200).nullable(),
  })
  .refine((v) => v.matchType !== "REGEX" || isValidRegex(v.phrase), {
    message: "정규식이 올바르지 않아요.",
  });

export async function createRuleAction(input: z.infer<typeof ruleSchema>): Promise<RuleActionResult> {
  const parsed = ruleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;

  const { error } = await createServiceClient().from("content_rules").insert({
    scope: parsed.data.scope,
    rule_type: parsed.data.ruleType,
    phrase: parsed.data.phrase,
    match_type: parsed.data.matchType,
    reason: parsed.data.reason || null,
    suggestion: parsed.data.suggestion || null,
    created_by: auth.userId,
  });
  if (error) {
    return { ok: false, error: error.code === "23505" ? "같은 규칙이 이미 있어요." : error.message };
  }
  revalidatePath("/rules");
  return { ok: true };
}

const toggleSchema = z.object({ id: z.string().uuid(), active: z.boolean() });

export async function setRuleActiveAction(input: z.infer<typeof toggleSchema>): Promise<RuleActionResult> {
  const parsed = toggleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const { error } = await createServiceClient()
    .from("content_rules")
    .update({ active: parsed.data.active })
    .eq("id", parsed.data.id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/rules");
  return { ok: true };
}

const idSchema = z.object({ id: z.string().uuid() });

export async function deleteRuleAction(input: z.infer<typeof idSchema>): Promise<RuleActionResult> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const { error } = await createServiceClient().from("content_rules").delete().eq("id", parsed.data.id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/rules");
  return { ok: true };
}

const claimSchema = z.object({
  productId: z.string().uuid(),
  claim: z.string().trim().min(1).max(500),
  source: z.enum(["ANALYSIS", "MANUAL"]),
});

/** 건기식 심의 문구 확정 — 분석 후보를 그대로, 또는 사람이 직접 입력. */
export async function approveClaimAction(input: z.infer<typeof claimSchema>): Promise<RuleActionResult> {
  const parsed = claimSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const { error } = await createServiceClient().from("product_claim_approvals").upsert(
    {
      product_id: parsed.data.productId,
      claim: parsed.data.claim,
      source: parsed.data.source,
      approved_by: auth.userId,
      approved_at: new Date().toISOString(),
    },
    { onConflict: "product_id,claim" },
  );
  if (error) return { ok: false, error: error.message };
  revalidatePath("/rules");
  revalidatePath(`/products/${parsed.data.productId}`);
  return { ok: true };
}

export async function removeClaimAction(input: z.infer<typeof idSchema>): Promise<RuleActionResult> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const { error } = await createServiceClient().from("product_claim_approvals").delete().eq("id", parsed.data.id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/rules");
  return { ok: true };
}

const previewSchema = z.object({
  text: z.string().max(5000),
  kind: z.enum(["FRUIT", "FOOD", "COSMETIC", "HEALTH_FOOD", "CLOTHING"]),
});

/** 미리 검사 — 문장을 넣으면 지금 켜진 규칙으로 검사해 걸린 것을 돌려준다. */
export async function previewCheckAction(
  input: z.infer<typeof previewSchema>,
): Promise<{ ok: true; hits: RuleHit[] } | { ok: false; error: string }> {
  const parsed = previewSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "로그인이 필요합니다." };

  const { data, error } = await createServiceClient()
    .from("content_rules")
    .select("id, scope, rule_type, phrase, match_type, reason, suggestion")
    .eq("active", true);
  if (error) return { ok: false, error: error.message };
  const rules: ContentRule[] = (data ?? []).map((r) => ({
    id: r.id,
    scope: r.scope as ContentRule["scope"],
    ruleType: r.rule_type as ContentRule["ruleType"],
    phrase: r.phrase,
    matchType: r.match_type as ContentRule["matchType"],
    reason: r.reason,
    suggestion: r.suggestion,
  }));
  return { ok: true, hits: checkText(parsed.data.text, parsed.data.kind as ProductKind, rules) };
}

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { interpretEditStyle } from "@/lib/agents/concept";
import { templateProblem } from "@/lib/agents/fixed-phrases";
import { getCurrentProfile, getSessionUser } from "@/lib/auth";
import { triggerShootPlanRun } from "@/lib/github-dispatch";
import {
  cancelPlans,
  clearScheduleCancelled,
  futureCounts,
  futurePlans,
  movePlans,
  SCOPE_OPTIONS,
  validateSlots,
} from "@/lib/schedule/slot-admin";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// 자동 업로드 일정 "편성 관리" (slot_rules 0031, track_settings 0028) — ADMIN · MANAGER. 칸은 AI 자동 칸만(직접 촬영은 0042부터 칸이 아니다).
//   촬영 설정의 계정 켜기 · 끄기(track_settings.shoot_enabled)와 계정 컨셉 저장도 여기서 한다.
//   · 칸: 주제 · 켜기/끄기 · 시각 · 방식 바꾸기, 칸 추가 · 삭제
//   · 계정: 편성에 넣기(쓸 상품 + 기본 칸) · 쓸 상품 바꾸기 · 빼기
// 시각을 바꾸면 앞으로의 기획도 새 시각으로 옮기고, 칸 · 계정을 빼면 앞으로의 기획 · 예약 발행을 취소한다
// (화면이 먼저 예약 건 수로 경고한다). 규칙은 lib/schedule/slot-admin.ts.

export type ScheduleResult = { ok: true; message?: string } | { ok: false; error: string };
type Service = ReturnType<typeof createServiceClient>;

async function authorize(): Promise<{ ok: true; orgId: string; userId: string } | { ok: false; error: string }> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "로그인이 필요합니다." };
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) return { ok: false, error: "소속된 조직이 없습니다." };
  if (profile.role !== "ADMIN" && profile.role !== "MANAGER") return { ok: false, error: "자동 업로드 일정을 바꿀 권한이 없습니다." };
  return { ok: true, orgId: profile.organization_id, userId: user.id };
}

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "시각 형식이 올바르지 않아요.");
const trackSchema = z.literal("B");
const scopesSchema = z.array(z.enum(SCOPE_OPTIONS.map((o) => o.key) as [string, ...string[]])).min(1, "쓸 상품을 하나 이상 골라 주세요.");

function scopesJson(keys: string[]): Json {
  return SCOPE_OPTIONS.filter((o) => keys.includes(o.key)).map((o) => ({ shop: o.shop, kind: o.kind })) as unknown as Json;
}

async function accountRules(service: Service, accountId: string) {
  const { data } = await service.from("slot_rules").select("id, slot_time, track").eq("social_account_id", accountId).eq("track", "B");
  return data ?? [];
}

function cancelMessage(c: { plans: number; jobs: number; uploading: number }): string | undefined {
  const parts: string[] = [];
  if (c.plans) parts.push(`앞으로의 기획 ${c.plans}개${c.jobs ? ` · 예약 발행 ${c.jobs}건` : ""}을 취소했어요.`);
  if (c.uploading) parts.push(`${c.uploading}건은 지금 올리는 중이라 막지 못했어요(그대로 올라가요).`);
  return parts.length ? parts.join(" ") : undefined;
}

function done(message?: string): ScheduleResult {
  revalidatePath("/schedule");
  revalidatePath("/shoot/settings");
  revalidatePath("/shoot/plans");
  revalidatePath("/");
  return { ok: true, message };
}

// ── 칸 ───────────────────────────────────────────────────────────────────────

const updateSchema = z.object({
  ruleId: z.string().uuid(),
  topic: z.string().trim().max(60, "주제는 60자까지 쓸 수 있어요.").nullable().optional(),
  active: z.boolean().optional(),
  time: timeSchema.optional(),
  track: trackSchema.optional(),
});

export async function updateSlotRuleAction(input: z.infer<typeof updateSchema>): Promise<ScheduleResult> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "입력값이 올바르지 않아요." };
  const auth = await authorize();
  if (!auth.ok) return auth;

  const { ruleId, topic, active, time } = parsed.data;
  const service = createServiceClient();
  const { data: rule } = await service
    .from("slot_rules")
    .select("id, social_account_id, slot_time, track")
    .eq("id", ruleId)
    .eq("organization_id", auth.orgId)
    .maybeSingle();
  if (!rule) return { ok: false, error: "칸을 찾지 못했어요." };

  const patch: { topic?: string | null; active?: boolean; slot_time?: string } = {};
  if (topic !== undefined) patch.topic = topic ? topic : null;
  if (active !== undefined) patch.active = active;
  const newTime = time ?? rule.slot_time;
  let message: string | undefined;

  if (newTime !== rule.slot_time) {
    const others = (await accountRules(service, rule.social_account_id)).filter((r) => r.id !== rule.id);
    const invalid = validateSlots([...others.map((r) => ({ time: r.slot_time, track: r.track })), { time: newTime, track: "B" }]);
    if (invalid) return { ok: false, error: invalid };
    // 앞으로의 기획도 새 시각으로(예약된 발행은 예약 시각도) — 옮기지 못하면 칸 시각도 그대로 둔다
    const moved = await movePlans(service, rule.social_account_id, rule.slot_time, newTime);
    if (!moved.ok) return { ok: false, error: moved.error };
    patch.slot_time = newTime;
    message = moved.moved > 0 ? `앞으로의 기획 ${moved.moved}개도 ${newTime}로 옮겼어요.` : undefined;
  }
  if (Object.keys(patch).length === 0) return { ok: true };

  const { error } = await service.from("slot_rules").update(patch).eq("id", rule.id);
  if (error) return { ok: false, error: `저장하지 못했어요: ${error.message}` };
  return done(message);
}

export async function addSlotAction(input: { accountId: string; time: string; track: string }): Promise<ScheduleResult> {
  const parsed = z.object({ accountId: z.string().uuid(), time: timeSchema, track: trackSchema }).safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "입력값이 올바르지 않아요." };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const { data: ts } = await service
    .from("track_settings")
    .select("social_account_id")
    .eq("social_account_id", parsed.data.accountId)
    .eq("organization_id", auth.orgId)
    .maybeSingle();
  if (!ts) return { ok: false, error: "편성에 없는 계정이에요." };
  const rules = await accountRules(service, parsed.data.accountId);
  const invalid = validateSlots([...rules.map((r) => ({ time: r.slot_time, track: r.track })), { time: parsed.data.time, track: parsed.data.track }]);
  if (invalid) return { ok: false, error: invalid };
  const { error } = await service.from("slot_rules").insert({
    organization_id: auth.orgId,
    social_account_id: parsed.data.accountId,
    slot_time: parsed.data.time,
    track: parsed.data.track,
  });
  if (error) return { ok: false, error: `저장하지 못했어요: ${error.message}` };
  await clearScheduleCancelled(service, parsed.data.accountId, parsed.data.time);
  return done("칸을 추가했어요. 다음 상품 제안(매일 오전 9시)부터 채워요.");
}

/** 빼기 전 경고용 — 앞으로의 기획 · 예약 건 수. ruleId를 주면 그 칸만. */
export async function removalImpactAction(input: { accountId?: string; ruleId?: string }): Promise<
  { ok: true; plans: number; scheduled: number } | { ok: false; error: string }
> {
  const auth = await authorize();
  if (!auth.ok) return auth;
  const service = createServiceClient();
  if (input.ruleId) {
    const { data: rule } = await service
      .from("slot_rules")
      .select("social_account_id, slot_time")
      .eq("id", input.ruleId)
      .eq("organization_id", auth.orgId)
      .maybeSingle();
    if (!rule) return { ok: false, error: "칸을 찾지 못했어요." };
    return { ok: true, ...(await futureCounts(service, rule.social_account_id, rule.slot_time)) };
  }
  if (!input.accountId) return { ok: false, error: "입력값이 올바르지 않아요." };
  const { data: ts } = await service.from("track_settings").select("social_account_id").eq("social_account_id", input.accountId).eq("organization_id", auth.orgId).maybeSingle();
  if (!ts) return { ok: false, error: "편성에 없는 계정이에요." };
  return { ok: true, ...(await futureCounts(service, input.accountId)) };
}

export async function deleteSlotAction(input: { ruleId: string }): Promise<ScheduleResult> {
  const parsed = z.object({ ruleId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "입력값이 올바르지 않아요." };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const { data: rule } = await service
    .from("slot_rules")
    .select("id, social_account_id, slot_time")
    .eq("id", parsed.data.ruleId)
    .eq("organization_id", auth.orgId)
    .maybeSingle();
  if (!rule) return { ok: false, error: "칸을 찾지 못했어요." };
  // 칸 규칙을 먼저 지운다 — 지우기가 실패했는데 기획 · 예약만 취소되는 일이 없게(2026-11-04)
  const { error } = await service.from("slot_rules").delete().eq("id", rule.id);
  if (error) return { ok: false, error: `지우지 못했어요: ${error.message}` };
  const cancelled = await cancelPlans(service, await futurePlans(service, rule.social_account_id, rule.slot_time), `편성표에서 ${rule.slot_time} 칸을 지워 취소`);
  return done(cancelMessage(cancelled));
}

// ── 계정 ─────────────────────────────────────────────────────────────────────

export async function addAccountAction(input: { accountId: string; scopes: string[]; slots: { time: string; track: string }[] }): Promise<ScheduleResult> {
  const parsed = z
    .object({
      accountId: z.string().uuid(),
      scopes: scopesSchema,
      slots: z.array(z.object({ time: timeSchema, track: trackSchema })).min(1, "칸을 하나 이상 만들어 주세요."),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "입력값이 올바르지 않아요." };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const invalid = validateSlots(parsed.data.slots);
  if (invalid) return { ok: false, error: invalid };

  const service = createServiceClient();
  const { data: acc } = await service
    .from("social_accounts")
    .select("id, platform, disconnected_at, display_name")
    .eq("id", parsed.data.accountId)
    .eq("organization_id", auth.orgId)
    .maybeSingle();
  if (!acc || acc.disconnected_at) return { ok: false, error: "연결된 계정을 찾지 못했어요." };
  if (acc.platform !== "INSTAGRAM") return { ok: false, error: "지금은 인스타그램 계정만 편성에 넣을 수 있어요." };
  const { data: exists } = await service.from("track_settings").select("social_account_id, product_scopes").eq("social_account_id", acc.id).maybeSingle();
  // 직접 촬영만 쓰던 계정은 설정이 이미 있다 — 칸이 있어야 이미 편성에 있는 계정이다
  if (exists && (await accountRules(service, acc.id)).length > 0) return { ok: false, error: "이미 편성에 있는 계정이에요." };

  const { error } = exists
    ? await service.from("track_settings").update({ product_scopes: scopesJson(parsed.data.scopes) }).eq("social_account_id", acc.id)
    : await service.from("track_settings").insert({ social_account_id: acc.id, organization_id: auth.orgId, product_scopes: scopesJson(parsed.data.scopes) });
  if (error) return { ok: false, error: `저장하지 못했어요: ${error.message}` };
  // 예전에 빼면서 남은 칸이 없게(빼기는 칸도 지운다) — 그래도 남아 있으면 지우고 새로
  await service.from("slot_rules").delete().eq("social_account_id", acc.id);
  const { error: rErr } = await service.from("slot_rules").insert(
    parsed.data.slots.map((s) => ({ organization_id: auth.orgId, social_account_id: acc.id, slot_time: s.time, track: s.track })),
  );
  if (rErr) {
    // 직접 촬영 설정이 있던 계정의 행은 지우지 않는다
    if (!exists) await service.from("track_settings").delete().eq("social_account_id", acc.id);
    else await service.from("track_settings").update({ product_scopes: exists.product_scopes }).eq("social_account_id", acc.id);
    return { ok: false, error: `칸을 만들지 못했어요: ${rErr.message}` };
  }
  for (const slot of parsed.data.slots) await clearScheduleCancelled(service, acc.id, slot.time);
  return done(`@${acc.display_name ?? ""} 계정을 편성에 넣었어요. 다음 상품 제안(매일 오전 9시)부터 칸이 채워져요.`);
}

export async function updateScopesAction(input: { accountId: string; scopes: string[] }): Promise<ScheduleResult> {
  const parsed = z.object({ accountId: z.string().uuid(), scopes: scopesSchema }).safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "입력값이 올바르지 않아요." };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const { data, error } = await createServiceClient()
    .from("track_settings")
    .update({ product_scopes: scopesJson(parsed.data.scopes) })
    .eq("social_account_id", parsed.data.accountId)
    .eq("organization_id", auth.orgId)
    .select("social_account_id");
  if (error) return { ok: false, error: `저장하지 못했어요: ${error.message}` };
  if (!data?.length) return { ok: false, error: "편성에 없는 계정이에요." };
  return done("다음 기획부터 이 상품들에서 골라요.");
}

export async function removeAccountAction(input: { accountId: string }): Promise<ScheduleResult> {
  const parsed = z.object({ accountId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "입력값이 올바르지 않아요." };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const { data: ts } = await service
    .from("track_settings")
    .select("social_account_id, shoot_enabled, social_accounts(display_name)")
    .eq("social_account_id", parsed.data.accountId)
    .eq("organization_id", auth.orgId)
    .maybeSingle();
  if (!ts) return { ok: false, error: "편성에 없는 계정이에요." };
  // 계정 설정 · 칸을 먼저 지운다(기획 워커가 더는 이 계정을 돌지 않는다) → 앞으로의 기획 · 예약 발행 취소(지난 기록은 남긴다)
  // 직접 촬영을 쓰는 계정은 설정(쓸 상품)을 함께 쓰므로 칸만 지운다
  if (!ts.shoot_enabled) {
    const { error } = await service.from("track_settings").delete().eq("social_account_id", ts.social_account_id);
    if (error) return { ok: false, error: `빼지 못했어요: ${error.message}` };
  }
  await service.from("slot_rules").delete().eq("social_account_id", ts.social_account_id);
  const cancelled = await cancelPlans(service, await futurePlans(service, ts.social_account_id), "편성에서 계정을 빼 취소");
  const tail = cancelMessage(cancelled);
  return done(`@${ts.social_accounts?.display_name ?? ""} 계정을 편성에서 뺐어요.${tail ? ` ${tail}` : ""}`);
}

// ── 촬영 설정: 직접 촬영 기획을 만들 계정 ─────────────────────────────────────

/** 기획 목록을 만들 계정 추가 — 쓸 상품 범위는 AI 자동과 함께 쓴다. 저장하면 바로 목록을 채운다. */
export async function enableShootAccountAction(input: { accountId: string; scopes: string[] }): Promise<ScheduleResult> {
  const parsed = z.object({ accountId: z.string().uuid(), scopes: scopesSchema }).safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "입력값이 올바르지 않아요." };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const { data: acc } = await service
    .from("social_accounts")
    .select("id, platform, disconnected_at, display_name")
    .eq("id", parsed.data.accountId)
    .eq("organization_id", auth.orgId)
    .maybeSingle();
  if (!acc || acc.disconnected_at) return { ok: false, error: "연결된 계정을 찾지 못했어요." };
  if (acc.platform !== "INSTAGRAM") return { ok: false, error: "지금은 인스타그램 계정만 추가할 수 있어요." };
  const { error } = await service
    .from("track_settings")
    .upsert({ social_account_id: acc.id, organization_id: auth.orgId, product_scopes: scopesJson(parsed.data.scopes), shoot_enabled: true }, { onConflict: "social_account_id" });
  if (error) return { ok: false, error: `저장하지 못했어요: ${error.message}` };
  await triggerShootPlanRun(`account enabled ${acc.id}`).catch((e) => console.error("[schedule] 기획 트리거 실패:", e));
  return done(`@${acc.display_name ?? ""} 계정을 추가했어요. 몇 분 뒤 기획이 생겨요.`);
}

/** 기획 목록 끄기 — 고르기 전 기획은 빼고, 이미 고른 기획은 끝까지 진행한다. */
export async function disableShootAccountAction(input: { accountId: string }): Promise<ScheduleResult> {
  const parsed = z.object({ accountId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "입력값이 올바르지 않아요." };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const { data: ts } = await service
    .from("track_settings")
    .select("social_account_id, social_accounts(display_name)")
    .eq("social_account_id", parsed.data.accountId)
    .eq("organization_id", auth.orgId)
    .maybeSingle();
  if (!ts) return { ok: false, error: "촬영 설정에 없는 계정이에요." };
  const { error } = await service.from("track_settings").update({ shoot_enabled: false }).eq("social_account_id", ts.social_account_id);
  if (error) return { ok: false, error: `저장하지 못했어요: ${error.message}` };
  await service
    .from("content_plans")
    .update({ status: "SKIPPED", note: "촬영 설정에서 계정을 꺼 목록에서 뺐어요" })
    .eq("social_account_id", ts.social_account_id)
    .eq("track", "A")
    .eq("status", "PROPOSED");
  // AI 자동 칸도 없는 계정은 설정을 남겨 둘 이유가 없다
  if ((await accountRules(service, ts.social_account_id)).length === 0) await service.from("track_settings").delete().eq("social_account_id", ts.social_account_id);
  return done(`@${ts.social_accounts?.display_name ?? ""} 계정을 뺐어요. 이미 고른 기획은 끝까지 진행돼요.`);
}

const conceptText = z.string().trim().max(1000, "1,000자 안으로 줄여 주세요.");
// 한 줄에 문구 하나 — 빈 줄 · 같은 문구는 뺀다
const phraseLines = z
  .string()
  .max(2000)
  .transform((v) => [...new Set(v.split("\n").map((l) => l.trim()).filter(Boolean))])
  .refine((l) => l.length <= 10, "문구는 10개까지 저장할 수 있어요.")
  .refine((l) => l.every((t) => t.length <= 100), "문구 하나는 100자 안으로 적어 주세요.")
  .superRefine((l, ctx) => {
    const problem = l.map(templateProblem).find(Boolean);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });
const conceptSchema = z.object({
  accountId: z.string().uuid(),
  autoConcept: conceptText,
  autoHooks: phraseLines,
  autoEndings: phraseLines,
  autoTone: conceptText,
  autoVideoStyle: conceptText,
  shootConcept: conceptText,
  shootHooks: phraseLines,
  shootEndings: phraseLines,
  shootTone: conceptText,
  shootEditStyle: conceptText,
});

/**
 * 계정 컨셉 저장(0038) — 다음 기획부터 AI가 읽는다. 편집 스타일 글이 바뀌었을 때만 AI가 편집 값으로 다시 옮긴다.
 * 옮기기가 실패해도 글은 저장하고, 옛 글의 값이 남지 않게 편집 값은 비운다(기본 편집).
 */
export async function saveConceptAction(input: z.input<typeof conceptSchema>): Promise<ScheduleResult> {
  const parsed = conceptSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const { accountId, autoConcept, autoHooks, autoEndings, autoTone, autoVideoStyle, shootConcept, shootHooks, shootEndings, shootTone, shootEditStyle } = parsed.data;
  const { data: account } = await service.from("social_accounts").select("id").eq("id", accountId).eq("organization_id", auth.orgId).maybeSingle();
  if (!account) return { ok: false, error: "계정을 찾을 수 없어요." };
  const { data: prev } = await service.from("account_concepts").select("shoot_edit_style, shoot_edit_params").eq("social_account_id", accountId).maybeSingle();

  let params: Json | null = prev?.shoot_edit_params ?? null;
  let message: string | undefined;
  if (!shootEditStyle) params = null;
  else if (shootEditStyle !== prev?.shoot_edit_style || params == null) {
    try {
      params = (await interpretEditStyle(shootEditStyle)) as unknown as Json;
    } catch (e) {
      console.error("[schedule] 편집 스타일 읽기 실패:", e);
      params = null;
      message = "저장했어요. 다만 편집 스타일을 읽지 못해 편집은 기본으로 나가요. 잠시 뒤 다시 저장해 주세요.";
    }
  }

  const { error } = await service.from("account_concepts").upsert({
    social_account_id: accountId,
    organization_id: auth.orgId,
    auto_concept: autoConcept,
    auto_hooks: autoHooks,
    auto_endings: autoEndings,
    auto_tone: autoTone,
    auto_video_style: autoVideoStyle,
    shoot_concept: shootConcept,
    shoot_hooks: shootHooks,
    shoot_endings: shootEndings,
    shoot_tone: shootTone,
    shoot_edit_style: shootEditStyle,
    shoot_edit_params: params,
    updated_by: auth.userId,
  });
  if (error) return { ok: false, error: error.message };
  return done(message ?? "저장했어요. 다음에 쓰는 대본부터 AI가 읽어요.");
}

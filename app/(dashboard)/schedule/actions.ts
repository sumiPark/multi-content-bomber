"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile, getSessionUser } from "@/lib/auth";
import {
  cancelPlans,
  futureCounts,
  futurePlans,
  movePlans,
  SCOPE_OPTIONS,
  validateSlots,
} from "@/lib/schedule/slot-admin";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// 편성표 "편성 관리" (slot_rules 0031, track_settings 0028) — ADMIN · MANAGER.
//   · 칸: 주제 · 켜기/끄기 · 시각 · 방식 바꾸기, 칸 추가 · 삭제
//   · 계정: 편성에 넣기(쓸 상품 + 기본 칸) · 쓸 상품 바꾸기 · 빼기
// 시각을 바꾸면 앞으로의 기획도 새 시각으로 옮기고, 칸 · 계정을 빼면 앞으로의 기획 · 예약 발행을 취소한다
// (화면이 먼저 예약 건 수로 경고한다). 규칙은 lib/schedule/slot-admin.ts.

export type ScheduleResult = { ok: true; message?: string } | { ok: false; error: string };
type Service = ReturnType<typeof createServiceClient>;

async function authorize(): Promise<{ ok: true; orgId: string } | { ok: false; error: string }> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "로그인이 필요합니다." };
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) return { ok: false, error: "소속된 조직이 없습니다." };
  if (profile.role !== "ADMIN" && profile.role !== "MANAGER") return { ok: false, error: "편성표를 바꿀 권한이 없습니다." };
  return { ok: true, orgId: profile.organization_id };
}

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "시각 형식이 올바르지 않아요.");
const trackSchema = z.enum(["A", "B"]);
const scopesSchema = z.array(z.enum(SCOPE_OPTIONS.map((o) => o.key) as [string, ...string[]])).min(1, "쓸 상품을 하나 이상 골라 주세요.");

function scopesJson(keys: string[]): Json {
  return SCOPE_OPTIONS.filter((o) => keys.includes(o.key)).map((o) => ({ shop: o.shop, kind: o.kind })) as unknown as Json;
}

async function accountRules(service: Service, accountId: string) {
  const { data } = await service.from("slot_rules").select("id, slot_time, track").eq("social_account_id", accountId);
  return data ?? [];
}

function done(message?: string): ScheduleResult {
  revalidatePath("/schedule");
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

  const { ruleId, topic, active, time, track } = parsed.data;
  const service = createServiceClient();
  const { data: rule } = await service
    .from("slot_rules")
    .select("id, social_account_id, slot_time, track")
    .eq("id", ruleId)
    .eq("organization_id", auth.orgId)
    .maybeSingle();
  if (!rule) return { ok: false, error: "칸을 찾지 못했어요." };

  const patch: { topic?: string | null; active?: boolean; slot_time?: string; track?: string } = {};
  if (topic !== undefined) patch.topic = topic ? topic : null;
  if (active !== undefined) patch.active = active;
  const newTime = time ?? rule.slot_time;
  const newTrack = track ?? rule.track;
  let message: string | undefined;

  if (newTime !== rule.slot_time || newTrack !== rule.track) {
    const others = (await accountRules(service, rule.social_account_id)).filter((r) => r.id !== rule.id);
    const invalid = validateSlots([...others.map((r) => ({ time: r.slot_time, track: r.track })), { time: newTime, track: newTrack }]);
    if (invalid) return { ok: false, error: invalid };
    if (newTrack !== rule.track) patch.track = newTrack;
    if (newTime !== rule.slot_time) {
      // 앞으로의 기획도 새 시각으로(예약된 발행은 예약 시각도) — 옮기지 못하면 칸 시각도 그대로 둔다
      const moved = await movePlans(service, rule.social_account_id, rule.slot_time, newTime);
      if (!moved.ok) return { ok: false, error: moved.error };
      patch.slot_time = newTime;
      message = moved.moved > 0 ? `앞으로의 기획 ${moved.moved}개도 ${newTime}로 옮겼어요.` : undefined;
    }
    if (newTrack !== rule.track) message = `${message ? `${message} ` : ""}이미 기획이 있는 날은 예전 방식 그대로이고, 기획이 없는 날부터 새 방식으로 기획해요.`;
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
  return done("다음 기획부터 이 칸도 채워요.");
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
  const cancelled = await cancelPlans(service, await futurePlans(service, rule.social_account_id, rule.slot_time), `편성표에서 ${rule.slot_time} 칸을 지워 취소`);
  const { error } = await service.from("slot_rules").delete().eq("id", rule.id);
  if (error) return { ok: false, error: `지우지 못했어요: ${error.message}` };
  return done(cancelled.plans ? `앞으로의 기획 ${cancelled.plans}개${cancelled.jobs ? ` · 예약 발행 ${cancelled.jobs}건` : ""}을 취소했어요.` : undefined);
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
  const { data: exists } = await service.from("track_settings").select("social_account_id").eq("social_account_id", acc.id).maybeSingle();
  if (exists) return { ok: false, error: "이미 편성에 있는 계정이에요." };

  const { error } = await service
    .from("track_settings")
    .insert({ social_account_id: acc.id, organization_id: auth.orgId, product_scopes: scopesJson(parsed.data.scopes) });
  if (error) return { ok: false, error: `저장하지 못했어요: ${error.message}` };
  // 예전에 빼면서 남은 칸이 없게(빼기는 칸도 지운다) — 그래도 남아 있으면 지우고 새로
  await service.from("slot_rules").delete().eq("social_account_id", acc.id);
  const { error: rErr } = await service.from("slot_rules").insert(
    parsed.data.slots.map((s) => ({ organization_id: auth.orgId, social_account_id: acc.id, slot_time: s.time, track: s.track })),
  );
  if (rErr) {
    await service.from("track_settings").delete().eq("social_account_id", acc.id);
    return { ok: false, error: `칸을 만들지 못했어요: ${rErr.message}` };
  }
  return done(`@${acc.display_name ?? ""}을 편성에 넣었어요. 다음 기획(매일 05시 · 09시)부터 칸이 채워져요.`);
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
    .select("social_account_id, social_accounts(display_name)")
    .eq("social_account_id", parsed.data.accountId)
    .eq("organization_id", auth.orgId)
    .maybeSingle();
  if (!ts) return { ok: false, error: "편성에 없는 계정이에요." };
  // 앞으로의 기획 · 예약 발행 취소(지난 기록은 남긴다) → 칸 · 계정 설정 지우기 — 기획 워커가 더는 이 계정을 돌지 않는다
  const cancelled = await cancelPlans(service, await futurePlans(service, ts.social_account_id), "편성에서 계정을 빼 취소");
  await service.from("slot_rules").delete().eq("social_account_id", ts.social_account_id);
  const { error } = await service.from("track_settings").delete().eq("social_account_id", ts.social_account_id);
  if (error) return { ok: false, error: `빼지 못했어요: ${error.message}` };
  return done(
    `@${ts.social_accounts?.display_name ?? ""}을 편성에서 뺐어요.${cancelled.plans ? ` 앞으로의 기획 ${cancelled.plans}개${cancelled.jobs ? ` · 예약 발행 ${cancelled.jobs}건` : ""}을 취소했어요.` : ""}`,
  );
}

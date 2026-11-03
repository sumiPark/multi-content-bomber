"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { applyFeedback, LEARNING_AGENTS, savePlaybookVersion } from "@/lib/agents/playbook";
import { getCurrentProfile, getSessionUser } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";

// 에이전트 · 학습(0032): 반영 방식 · 플레이북 고치기 · 되돌리기 · 피드백 제안 반영 / 거절. ADMIN · MANAGER만.

export type AgentsResult = { ok: true; version?: number } | { ok: false; error: string };

async function authorize(): Promise<{ ok: true; userId: string; orgId: string } | { ok: false; error: string }> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "로그인이 필요합니다." };
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) return { ok: false, error: "소속된 조직이 없습니다." };
  if (profile.role !== "ADMIN" && profile.role !== "MANAGER") return { ok: false, error: "에이전트 설정을 바꿀 권한이 없습니다." };
  return { ok: true, userId: user.id, orgId: profile.organization_id };
}

const agentSchema = z.enum(LEARNING_AGENTS as [string, ...string[]]);

export async function setApprovalModeAction(input: { agent: string; mode: "HUMAN" | "AUTO" }): Promise<AgentsResult> {
  const parsed = z.object({ agent: agentSchema, mode: z.enum(["HUMAN", "AUTO"]) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "입력값이 올바르지 않아요." };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const { error } = await createServiceClient()
    .from("agent_settings")
    .upsert({ organization_id: auth.orgId, agent: parsed.data.agent, approval_mode: parsed.data.mode, updated_by: auth.userId });
  if (error) return { ok: false, error: `저장하지 못했어요: ${error.message}` };
  revalidatePath("/agents");
  return { ok: true };
}

export async function savePlaybookAction(input: { agent: string; body: string; note: string }): Promise<AgentsResult> {
  const parsed = z
    .object({
      agent: agentSchema,
      body: z.string().max(4000, "플레이북은 4,000자까지 쓸 수 있어요."),
      note: z.string().trim().max(200, "바꾼 이유는 200자까지예요."),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "입력값이 올바르지 않아요." };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const r = await savePlaybookVersion(createServiceClient(), {
    orgId: auth.orgId,
    agent: parsed.data.agent as (typeof LEARNING_AGENTS)[number],
    body: parsed.data.body.trim(),
    note: parsed.data.note || null,
    source: "HUMAN",
    userId: auth.userId,
  });
  if (!r.ok) return r;
  revalidatePath("/agents");
  return r;
}

export async function rollbackPlaybookAction(input: { agent: string; version: number }): Promise<AgentsResult> {
  const parsed = z.object({ agent: agentSchema, version: z.number().int().min(0) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "입력값이 올바르지 않아요." };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const service = createServiceClient();
  // version 0 = 기본 규칙만(빈 플레이북)으로 되돌리기
  let body = "";
  if (parsed.data.version > 0) {
    const { data } = await service
      .from("agent_playbooks")
      .select("body")
      .eq("organization_id", auth.orgId)
      .eq("agent", parsed.data.agent)
      .eq("version", parsed.data.version)
      .maybeSingle();
    if (!data) return { ok: false, error: "그 버전을 찾지 못했어요." };
    body = data.body;
  }
  const r = await savePlaybookVersion(service, {
    orgId: auth.orgId,
    agent: parsed.data.agent as (typeof LEARNING_AGENTS)[number],
    body,
    note: parsed.data.version > 0 ? `v${parsed.data.version}으로 되돌림` : "기본 규칙만 쓰도록 되돌림",
    source: "ROLLBACK",
    userId: auth.userId,
  });
  if (!r.ok) return r;
  revalidatePath("/agents");
  return r;
}

export async function applyFeedbackAction(input: { feedbackId: string; body?: string | null }): Promise<AgentsResult> {
  const parsed = z.object({ feedbackId: z.string().uuid(), body: z.string().max(4000).nullable().optional() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "입력값이 올바르지 않아요." };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const r = await applyFeedback(createServiceClient(), { orgId: auth.orgId, feedbackId: parsed.data.feedbackId, body: parsed.data.body, userId: auth.userId });
  if (!r.ok) return r;
  revalidatePath("/agents");
  return r;
}

export async function rejectFeedbackAction(input: { feedbackId: string; reason: string }): Promise<AgentsResult> {
  const parsed = z
    .object({ feedbackId: z.string().uuid(), reason: z.string().trim().min(1, "거절 이유를 적어 주세요. 다음 제안에 반영돼요.").max(300) })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "입력값이 올바르지 않아요." };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const { data, error } = await createServiceClient()
    .from("agent_feedback")
    .update({ status: "REJECTED", reject_reason: parsed.data.reason, decided_by: auth.userId, decided_at: new Date().toISOString() })
    .eq("id", parsed.data.feedbackId)
    .eq("organization_id", auth.orgId)
    .eq("status", "PENDING")
    .select("id");
  if (error) return { ok: false, error: `저장하지 못했어요: ${error.message}` };
  if (!data?.length) return { ok: false, error: "이미 처리했거나 없는 제안이에요." };
  revalidatePath("/agents");
  return { ok: true };
}

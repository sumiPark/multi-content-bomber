"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile, getSessionUser } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";

// 편성표 칸 설정 (slot_rules, 0031). 칸 주제와 켜기 · 끄기만 바꾼다 — 시각 · 방식(AI 자동 / 직접 촬영)은 고정.
// 바꾼 값은 다음 기획부터 반영된다(이미 만든 기획안은 그대로). ADMIN · MANAGER만.

export type ScheduleResult = { ok: true } | { ok: false; error: string };

const updateSchema = z.object({
  ruleId: z.string().uuid(),
  topic: z.string().trim().max(60, "주제는 60자까지 쓸 수 있어요.").nullable().optional(),
  active: z.boolean().optional(),
});

export async function updateSlotRuleAction(input: z.infer<typeof updateSchema>): Promise<ScheduleResult> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "입력값이 올바르지 않아요." };
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "로그인이 필요합니다." };
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) return { ok: false, error: "소속된 조직이 없습니다." };
  if (profile.role !== "ADMIN" && profile.role !== "MANAGER") return { ok: false, error: "편성표를 바꿀 권한이 없습니다." };

  const { ruleId, topic, active } = parsed.data;
  const patch: { topic?: string | null; active?: boolean } = {};
  if (topic !== undefined) patch.topic = topic ? topic : null;
  if (active !== undefined) patch.active = active;
  if (Object.keys(patch).length === 0) return { ok: true };

  const service = createServiceClient();
  const { data, error } = await service
    .from("slot_rules")
    .update(patch)
    .eq("id", ruleId)
    .eq("organization_id", profile.organization_id)
    .select("id");
  if (error) return { ok: false, error: `저장하지 못했어요: ${error.message}` };
  if (!data?.length) return { ok: false, error: "칸을 찾지 못했어요." };
  revalidatePath("/schedule");
  return { ok: true };
}

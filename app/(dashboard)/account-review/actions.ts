"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ProfileManualInput } from "@/lib/account-review/types";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { triggerProfileReviewRun } from "@/lib/github-dispatch";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// 계정 점검 — 프로필 점수 "채점하기". 요청(profile_reviews PENDING)을 만들고 워커를 깨운다.
// 채점은 GitHub Actions에서 1~2분 걸리고, 화면은 새로고침으로 확인한다. 인스타에는 아무것도 쓰지 않는다.

export type ReviewRequestResult = { ok: true } | { ok: false; error: string };

// 이 시간 안의 대기 · 채점 중 요청이 있으면 새로 만들지 않는다(워커의 멈춤 판정과 같은 20분).
const BUSY_MS = 20 * 60_000;

const manualSchema = z.object({
  highlights: z.array(z.string().trim().max(30, "하이라이트 이름은 30자까지예요.")).max(20).nullable(),
  pinnedCount: z.number().int().min(0).max(3).nullable(),
  storyDaysPerWeek: z.number().int().min(0).max(7).nullable(),
  contact: z.boolean().nullable(),
  category: z.string().trim().max(40, "카테고리는 40자까지예요.").nullable(),
  name: z.string().trim().max(60, "이름 칸은 60자까지 넣을 수 있어요.").nullable(),
  bio: z.string().max(400, "소개는 400자까지 넣을 수 있어요.").nullable(),
  links: z.array(z.string().trim().max(300)).max(5, "링크는 5개까지예요.").nullable(),
});

export async function requestProfileReviewAction(input: {
  accountId: string;
  manual: ProfileManualInput;
}): Promise<ReviewRequestResult> {
  const parsed = z.object({ accountId: z.string().uuid(), manual: manualSchema }).safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "입력값이 올바르지 않아요." };

  const user = await getSessionUser();
  if (!user) return { ok: false, error: "로그인이 필요합니다." };
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) return { ok: false, error: "소속된 조직이 없습니다." };

  // 같은 조직 계정인지는 RLS가 걸러 준다.
  const supabase = await getServerSupabase();
  const { data: account } = await supabase
    .from("social_accounts")
    .select("id")
    .eq("id", parsed.data.accountId)
    .eq("platform", "INSTAGRAM")
    .is("disconnected_at", null)
    .maybeSingle();
  if (!account) return { ok: false, error: "연결된 인스타 계정을 찾지 못했어요." };

  const service = createServiceClient();
  const { data: busy } = await service
    .from("profile_reviews")
    .select("id")
    .eq("social_account_id", account.id)
    .in("status", ["PENDING", "RUNNING"])
    .gte("created_at", new Date(Date.now() - BUSY_MS).toISOString())
    .limit(1);
  if (busy?.length) return { ok: false, error: "이미 채점 중이에요. 1~2분 뒤 새로고침하세요." };

  const m = parsed.data.manual;
  const manual: ProfileManualInput = {
    highlights: m.highlights?.filter(Boolean) ?? null,
    pinnedCount: m.pinnedCount,
    storyDaysPerWeek: m.storyDaysPerWeek,
    contact: m.contact,
    category: m.category || null,
    name: m.name || null,
    bio: m.bio?.trim() ? m.bio.replace(/\r\n/g, "\n").trim() : null,
    links: m.links?.filter(Boolean) ?? null,
  };

  const { data: row, error } = await service
    .from("profile_reviews")
    .insert({
      organization_id: profile.organization_id,
      social_account_id: account.id,
      manual_input: manual as unknown as Json,
      requested_by: user.id,
    })
    .select("id")
    .single();
  if (error || !row) return { ok: false, error: `요청을 저장하지 못했어요: ${error?.message ?? ""}` };

  try {
    await triggerProfileReviewRun(`profile-review:${user.id}`);
  } catch (err) {
    // 정해진 시각에 도는 run이 없어서, 못 깨우면 영영 대기로 남는다 — 실패로 바꿔 둔다.
    const message = err instanceof Error ? err.message : String(err);
    await service
      .from("profile_reviews")
      .update({ status: "FAILED", error: `채점을 시작하지 못했어요: ${message.slice(0, 200)}`, finished_at: new Date().toISOString() })
      .eq("id", row.id);
    revalidatePath("/account-review");
    return { ok: false, error: "채점을 시작하지 못했어요. 잠시 뒤 다시 눌러 주세요." };
  }

  revalidatePath("/account-review");
  return { ok: true };
}

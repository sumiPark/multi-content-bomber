"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { readProfileScreenshot } from "@/lib/account-review/read-screenshot";
import type { ProfileManualInput } from "@/lib/account-review/types";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { triggerProfileReviewRun } from "@/lib/github-dispatch";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// 분석 · 프로필 점수 — 프로필 캡처 한 장으로 인스타가 주지 않는 값(하이라이트 · 고정 게시물 ·
// 연락 버튼 · 카테고리)을 채운다. 1) 캡처 읽기 → 화면에서 사람이 확인 · 고침 → 2) 저장하면 그 계정만
// 다시 채점(워커). 채점 자체는 매일 04:30 자동이라 버튼이 없다. 인스타에는 아무것도 쓰지 않는다.

export type ScreenshotReadResult =
  | { ok: true; manual: ProfileManualInput; notes: string[] }
  | { ok: false; error: string };
export type SaveFactsResult = { ok: true } | { ok: false; error: string };

// 화면이 줄여서 보낸다(가로 1080px JPEG ≈ 0.3MB). 서버 액션 본문 한도(1MB) 안.
const MAX_IMAGE_BYTES = 950_000;
const BUSY_MS = 20 * 60_000;

async function authorizeAccount(accountId: string) {
  const user = await getSessionUser();
  if (!user) return { ok: false as const, error: "로그인이 필요합니다." };
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) return { ok: false as const, error: "소속된 조직이 없습니다." };
  // 같은 조직 계정인지는 RLS가 걸러 준다.
  const supabase = await getServerSupabase();
  const { data: account } = await supabase
    .from("social_accounts")
    .select("id, display_name")
    .eq("id", accountId)
    .eq("platform", "INSTAGRAM")
    .is("disconnected_at", null)
    .maybeSingle();
  if (!account) return { ok: false as const, error: "연결된 인스타 계정을 찾지 못했어요." };
  return { ok: true as const, userId: user.id, orgId: profile.organization_id, account };
}

export async function readProfileScreenshotAction(formData: FormData): Promise<ScreenshotReadResult> {
  const accountId = String(formData.get("accountId") ?? "");
  const file = formData.get("image");
  if (!z.string().uuid().safeParse(accountId).success) return { ok: false, error: "계정을 골라 주세요." };
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "캡처 이미지를 골라 주세요." };
  if (!file.type.startsWith("image/")) return { ok: false, error: "이미지 파일만 올릴 수 있어요." };
  if (file.size > MAX_IMAGE_BYTES) return { ok: false, error: "이미지가 너무 커요. 다시 골라 주세요." };

  const auth = await authorizeAccount(accountId);
  if (!auth.ok) return auth;

  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const read = await readProfileScreenshot(`data:${file.type};base64,${buf.toString("base64")}`);
    const notes = [...read.notes];
    // 인스타 계정의 display_name은 아이디다
    const name = auth.account.display_name?.replace(/^@/, "").toLowerCase();
    if (read.handle && name && read.handle.toLowerCase() !== name) {
      notes.unshift(`캡처의 아이디(@${read.handle})가 이 계정(@${name})과 달라요. 다른 계정 캡처인지 확인하세요`);
    }
    return { ok: true, manual: read.manual, notes };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/insufficient_quota|exceeded your current quota/i.test(msg)) return { ok: false, error: "OpenAI 크레딧이 부족해요." };
    return { ok: false, error: "캡처를 읽지 못했어요. 잠시 뒤 다시 올려 주세요." };
  }
}

const manualSchema = z.object({
  highlights: z.array(z.string().trim().max(30, "하이라이트 이름은 30자까지예요.")).max(20).nullable(),
  pinnedCount: z.number().int().min(0).max(3).nullable(),
  contact: z.boolean().nullable(),
  category: z.string().trim().max(40, "카테고리는 40자까지예요.").nullable(),
  name: z.string().trim().max(60, "이름 칸은 60자까지예요.").nullable(),
  bio: z.string().max(400, "소개는 400자까지예요.").nullable(),
  links: z.array(z.string().trim().max(300)).max(5, "링크는 5개까지예요.").nullable(),
});

export async function saveProfileFactsAction(input: { accountId: string; manual: ProfileManualInput }): Promise<SaveFactsResult> {
  const parsed = z.object({ accountId: z.string().uuid(), manual: manualSchema }).safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "입력값이 올바르지 않아요." };
  const auth = await authorizeAccount(parsed.data.accountId);
  if (!auth.ok) return auth;

  const service = createServiceClient();
  const { data: busy } = await service
    .from("profile_reviews")
    .select("id")
    .eq("social_account_id", auth.account.id)
    .in("status", ["PENDING", "RUNNING"])
    .gte("created_at", new Date(Date.now() - BUSY_MS).toISOString())
    .limit(1);
  if (busy?.length) return { ok: false, error: "지금 채점 중이에요. 1~2분 뒤 다시 저장하세요." };

  const m = parsed.data.manual;
  const manual: ProfileManualInput = {
    highlights: m.highlights?.filter(Boolean) ?? null,
    pinnedCount: m.pinnedCount,
    contact: m.contact,
    category: m.category || null,
    name: m.name || null,
    bio: m.bio?.trim() ? m.bio.replace(/\r\n/g, "\n").trim() : null,
    links: m.links?.filter(Boolean) ?? null,
  };

  const { data: row, error } = await service
    .from("profile_reviews")
    .insert({
      organization_id: auth.orgId,
      social_account_id: auth.account.id,
      manual_input: manual as unknown as Json,
      requested_by: auth.userId,
    })
    .select("id")
    .single();
  if (error || !row) return { ok: false, error: `저장하지 못했어요: ${error?.message ?? ""}` };

  try {
    await triggerProfileReviewRun(`profile-facts:${auth.userId}`, auth.account.id);
  } catch {
    // 못 깨워도 값은 저장됐다 — 다음 04:30 자동 채점이 이 대기 요청을 집는다.
    revalidatePath("/analytics");
    return { ok: true };
  }
  revalidatePath("/analytics");
  return { ok: true };
}

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { triggerBenchmarkRun } from "@/lib/github-dispatch";
import { createServiceClient } from "@/lib/supabase/service";

// 다른 계정 비교(0037) — 비교 계정 추가 · 빼기. 관리자 · 매니저만.
// 실제로 조회되는지는 워커가 읽어 봐야 안다 — 추가 직후 워커를 깨우고, 화면은 1~2분 뒤 결과를 보여 준다.

export type BenchmarkResult = { ok: true } | { ok: false; error: string };

const MAX_LINKS_PER_ACCOUNT = 20;

async function authorize() {
  const user = await getSessionUser();
  if (!user) return { ok: false as const, error: "로그인이 필요합니다." };
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) return { ok: false as const, error: "소속된 조직이 없습니다." };
  if (profile.role !== "ADMIN" && profile.role !== "MANAGER") {
    return { ok: false as const, error: "비교 계정은 관리자 · 매니저만 바꿀 수 있어요." };
  }
  return { ok: true as const, userId: user.id, orgId: profile.organization_id };
}

/** "@abc", "instagram.com/abc/", "abc" 모두 아이디로. 형식이 틀리면 null. */
function parseUsername(input: string): string | null {
  let s = input.trim().toLowerCase();
  const url = s.match(/instagram\.com\/([^/?#\s]+)/);
  if (url) s = url[1];
  s = s.replace(/^@/, "");
  return /^[a-z0-9._]{1,30}$/.test(s) ? s : null;
}

export async function addBenchmarkAction(input: {
  socialAccountId: string;
  username: string;
  groupType: string;
  reason: string;
}): Promise<BenchmarkResult> {
  const parsed = z
    .object({
      socialAccountId: z.string().uuid(),
      username: z.string().max(200),
      groupType: z.enum(["SAME", "ADJACENT", "LARGE"]),
      reason: z.string().trim().max(300, "이유는 300자까지예요."),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "입력값이 올바르지 않아요." };
  const username = parseUsername(parsed.data.username);
  if (!username) return { ok: false, error: "인스타 아이디나 프로필 주소를 넣어 주세요." };

  const auth = await authorize();
  if (!auth.ok) return auth;

  // 같은 조직 계정인지는 RLS가 걸러 준다.
  const supabase = await getServerSupabase();
  const { data: account } = await supabase
    .from("social_accounts")
    .select("id")
    .eq("id", parsed.data.socialAccountId)
    .eq("platform", "INSTAGRAM")
    .is("disconnected_at", null)
    .maybeSingle();
  if (!account) return { ok: false, error: "연결된 인스타 계정을 찾지 못했어요." };

  const service = createServiceClient();
  const { count } = await service
    .from("benchmark_links")
    .select("id", { count: "exact", head: true })
    .eq("social_account_id", account.id);
  if ((count ?? 0) >= MAX_LINKS_PER_ACCOUNT) return { ok: false, error: `계정마다 ${MAX_LINKS_PER_ACCOUNT}개까지 넣을 수 있어요. 하나를 뺀 뒤 추가하세요.` };

  const { data: row, error: accErr } = await service
    .from("benchmark_accounts")
    .upsert({ organization_id: auth.orgId, username }, { onConflict: "organization_id,username" })
    .select("id, own_account_id")
    .single();
  if (accErr || !row) return { ok: false, error: `저장하지 못했어요: ${accErr?.message ?? ""}` };
  if (row.own_account_id === account.id) return { ok: false, error: "이 계정 자신은 비교 계정으로 넣을 수 없어요." };

  const { error } = await service.from("benchmark_links").insert({
    organization_id: auth.orgId,
    social_account_id: account.id,
    benchmark_account_id: row.id,
    group_type: parsed.data.groupType,
    reason: parsed.data.reason || null,
    source: "MANUAL",
    created_by: auth.userId,
  });
  if (error) {
    if (error.code === "23505") return { ok: false, error: "이미 비교 목록에 있는 계정이에요." };
    return { ok: false, error: `저장하지 못했어요: ${error.message}` };
  }

  // 못 깨워도 다음 04:50 수집이 읽는다
  await triggerBenchmarkRun(`benchmark-add:${auth.userId}`).catch(() => undefined);
  revalidatePath("/analytics");
  return { ok: true };
}

export async function removeBenchmarkAction(input: { linkId: string }): Promise<BenchmarkResult> {
  const parsed = z.object({ linkId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "입력값이 올바르지 않아요." };
  const auth = await authorize();
  if (!auth.ok) return auth;

  const { data, error } = await createServiceClient()
    .from("benchmark_links")
    .delete()
    .eq("id", parsed.data.linkId)
    .eq("organization_id", auth.orgId)
    .select("id");
  if (error) return { ok: false, error: `빼지 못했어요: ${error.message}` };
  if (!data?.length) return { ok: false, error: "이미 빠졌거나 없는 계정이에요." };
  revalidatePath("/analytics");
  return { ok: true };
}

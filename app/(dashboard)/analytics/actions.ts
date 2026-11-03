"use server";

import { triggerMetricsRun } from "@/lib/github-dispatch";
import { getCurrentProfile, getSessionUser } from "@/lib/auth";

export type CollectNowResult = { ok: true } | { ok: false; error: string };

// "지금 수집" — 성과 수집 워크플로(metrics.yml)를 즉시 깨운다. 실제 수집은 GitHub Actions
// 러너에서 1~3분 걸려 끝나고, 화면은 새로고침으로 확인한다. 평소엔 매일 04시에 돈다.
export async function collectMetricsNowAction(): Promise<CollectNowResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "로그인이 필요합니다." };
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) {
    return { ok: false, error: "소속된 조직이 없습니다." };
  }

  try {
    await triggerMetricsRun(`manual:${user.id}`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "수집 시작 실패",
    };
  }
}

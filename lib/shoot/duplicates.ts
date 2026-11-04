import { addDays, kstDate } from "@/lib/automation/time";
import type { createServiceClient } from "@/lib/supabase/service";

// 사람이 직접 고른 상품의 중복 경고(2026-11-04 사용자 결정) — AI 후보에서는 빼고(lib/agents/select.ts),
// 사람이 고르면 막지 않고 경고한 뒤 진행한다.

type Service = ReturnType<typeof createServiceClient>;

const OPEN_STATUSES = ["PROPOSED", "CONFIRMED", "SCRIPTED", "SHOT", "RENDERED", "BLOCKED", "SCHEDULED"];

export async function duplicateWarning(
  service: Service,
  input: { accountId: string; productId: string; excludePlanId?: string; gapDays: number },
  now = Date.now(),
): Promise<string | null> {
  const { data, error } = await service
    .from("content_plans")
    .select("id, social_account_id, track, status, slot_date, created_at, posted_at, social_accounts(display_name)")
    .eq("product_id", input.productId)
    .not("status", "in", "(SKIPPED,FAILED)");
  if (error) throw new Error(`상품 중복 확인 실패: ${error.message}`);

  const today = kstDate(0, now);
  const sinceMs = now - input.gapDays * 86_400_000;
  const sinceDate = addDays(today, -input.gapDays);
  for (const p of data ?? []) {
    if (p.id === input.excludePlanId) continue;
    if (p.social_account_id === input.accountId) {
      const recent = p.track === "A" ? Date.parse(p.posted_at ?? p.created_at) >= sinceMs : !!p.slot_date && p.slot_date >= sinceDate;
      if (recent) return `이 계정에서 최근 ${input.gapDays}일 안에 쓴 상품이에요.`;
    } else if (OPEN_STATUSES.includes(p.status) && (p.track === "A" || (!!p.slot_date && p.slot_date >= today))) {
      return `@${p.social_accounts?.display_name ?? "다른 계정"} 계정에서 진행 중인 상품이에요.`;
    }
  }
  return null;
}

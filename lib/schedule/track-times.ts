import type { getServerSupabase } from "@/lib/auth";
import { trackTimesLabel } from "@/lib/schedule/slot-admin";

// 화면 안내 문구용 — 지금 켜진 칸 시각(편성표에서 바뀐다). 예: { B: "08 · 21시", A: "12 · 18시" }

type Supabase = Awaited<ReturnType<typeof getServerSupabase>>;

export async function loadTrackTimes(supabase: Supabase): Promise<{ A: string; B: string }> {
  const { data } = await supabase.from("slot_rules").select("slot_time, track, social_accounts(disconnected_at)").eq("active", true);
  const rules = (data ?? []).filter((r) => r.social_accounts && !r.social_accounts.disconnected_at);
  return { A: trackTimesLabel(rules, "A"), B: trackTimesLabel(rules, "B") };
}

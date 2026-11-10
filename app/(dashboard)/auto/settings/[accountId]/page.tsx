import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { AccountConceptCard } from "@/components/schedule/account-concept";
import { AccountScheduleCard } from "@/components/schedule/account-schedule";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { CONCEPT_SELECT, conceptCardData, type ConceptRow } from "@/lib/schedule/concept-data";
import { MAX_SLOTS_PER_DAY, MIN_GAP_MINUTES, SCOPE_OPTIONS, scopeKeysOf } from "@/lib/schedule/slot-admin";

// 자동 콘텐츠 설정 상세 — 계정 하나의 쓸 상품 · 하루 칸과 AI 자동 영상의 참고 내용(영상 방향 · 후킹 문구 · 말투 · 영상 스타일 · 메모).

export const metadata = { title: "자동 콘텐츠 설정 | MCB" };

export default async function AutoSettingsDetailPage({ params }: { params: Promise<{ accountId: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");
  const canManage = profile.role === "ADMIN" || profile.role === "MANAGER";
  const { accountId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) notFound();

  const supabase = await getServerSupabase();
  const [{ data: setting }, { data: rules }, { data: concept }] = await Promise.all([
    supabase.from("track_settings").select("social_account_id, product_scopes, shoot_enabled, social_accounts(display_name, disconnected_at)").eq("social_account_id", accountId).maybeSingle(),
    supabase.from("slot_rules").select("id, slot_time, track, topic, active").eq("social_account_id", accountId).eq("track", "B").order("slot_time"),
    supabase.from("account_concepts").select(CONCEPT_SELECT).eq("social_account_id", accountId).maybeSingle(),
  ]);
  const acc = setting?.social_accounts;
  // 뺀 계정, 직접 촬영만 쓰는 계정은 목록으로
  if (!setting || !acc || acc.disconnected_at || (setting.shoot_enabled && !rules?.length)) redirect("/auto/settings");

  const name = acc.display_name ?? "";
  const scopes = scopeKeysOf(setting.product_scopes);

  return (
    <main className="space-y-4 p-4 sm:p-6">
      <Link href="/auto/settings" className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground">
        <ChevronLeft className="size-4" /> 자동 콘텐츠 설정 목록
      </Link>
      <h1 className="text-xl font-bold tracking-[-0.01em]">@{name}</h1>
      <AccountScheduleCard
        accountId={accountId}
        name={name}
        scopes={scopes}
        rules={(rules ?? []).map((r) => ({ id: r.id, time: r.slot_time, track: r.track, topic: r.topic, active: r.active }))}
        options={SCOPE_OPTIONS}
        limits={{ maxSlots: MAX_SLOTS_PER_DAY, minGapHours: MIN_GAP_MINUTES / 60 }}
        canManage={canManage}
        hideName
      />
      <AccountConceptCard data={conceptCardData({ accountId, name, row: concept as unknown as ConceptRow | null })} canManage={canManage} mode="auto" hideName />
    </main>
  );
}

import { redirect } from "next/navigation";
import { AddAccountPanel } from "@/components/schedule/account-schedule";
import { SettingsList } from "@/components/shoot/settings-list";
import { Card, CardContent } from "@/components/ui/card";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { CONCEPT_SELECT, roleLabel, savedConceptItems, type ConceptRow } from "@/lib/schedule/concept-data";
import { MAX_SLOTS_PER_DAY, MIN_GAP_MINUTES, SCOPE_OPTIONS, scopeLabelsOf } from "@/lib/schedule/slot-admin";

// 자동 콘텐츠 설정 목록 — AI가 영상까지 자동으로 만드는 계정. 줄을 누르면 상세(/auto/settings/[accountId])에서 고친다.
// 직접 촬영(촬영 설정)과 영상 참고 내용이 섞이지 않는다. 쓸 상품만 함께 쓴다(2026-11-04 사용자 결정).

export const metadata = { title: "자동 콘텐츠 설정 | MCB" };

export default async function AutoSettingsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");
  const canManage = profile.role === "ADMIN" || profile.role === "MANAGER";
  const supabase = await getServerSupabase();

  const [{ data: settings }, { data: ruleRows }, { data: igAccounts }, { data: conceptRows }] = await Promise.all([
    supabase.from("track_settings").select("social_account_id, product_scopes, shoot_enabled, social_accounts(display_name, disconnected_at)"),
    supabase.from("slot_rules").select("social_account_id, slot_time, active").eq("track", "B").order("slot_time"),
    supabase.from("social_accounts").select("id, display_name").eq("platform", "INSTAGRAM").is("disconnected_at", null).order("display_name"),
    supabase.from("account_concepts").select(CONCEPT_SELECT),
  ]);

  const conceptOf = new Map((conceptRows ?? []).map((c) => [c.social_account_id, c as unknown as ConceptRow]));
  const rulesOf = new Map<string, { slot_time: string; active: boolean }[]>();
  for (const r of ruleRows ?? []) rulesOf.set(r.social_account_id, [...(rulesOf.get(r.social_account_id) ?? []), r]);

  // 직접 촬영만 쓰는 계정(칸 없음 + shoot_enabled)은 이 화면 소속이 아니다
  const rows = (settings ?? [])
    .filter((s) => s.social_accounts && !s.social_accounts.disconnected_at && (rulesOf.has(s.social_account_id) || !s.shoot_enabled))
    .map((s) => {
      const on = (rulesOf.get(s.social_account_id) ?? []).filter((r) => r.active);
      const c = conceptOf.get(s.social_account_id);
      return {
        accountId: s.social_account_id,
        name: s.social_accounts!.display_name ?? "",
        role: roleLabel(c?.auto_role_focus),
        meta: on.length ? `하루 ${on.length}칸 · ${on.map((r) => r.slot_time).join(" · ")}` : "켜진 칸 없음",
        scopeLabels: scopeLabelsOf(s.product_scopes),
        saved: savedConceptItems(c, "auto"),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const inList = new Set(rows.map((r) => r.accountId));
  const candidates = (igAccounts ?? []).filter((a) => !inList.has(a.id)).map((a) => ({ id: a.id, name: a.display_name ?? "" }));
  const limits = { maxSlots: MAX_SLOTS_PER_DAY, minGapHours: MIN_GAP_MINUTES / 60 };

  return (
    <main className="space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-[-0.01em]">자동 콘텐츠 설정</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            AI가 영상까지 자동으로 만드는 계정이에요. 계정을 눌러 올릴 시각과 후킹 문구 · 말투 · 영상 스타일을 정하면 상품 제안과 대본에 계속 씁니다. 직접 촬영 설정과는 따로 저장되고, 쓸 상품만 함께 써요.
            {!canManage && " 관리자 · 매니저만 바꿀 수 있어요."}
          </p>
        </div>
        {canManage && <AddAccountPanel candidates={candidates} options={SCOPE_OPTIONS} limits={limits} />}
      </header>

      {rows.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center text-sm text-muted-foreground">자동 콘텐츠를 만들 계정이 없어요. 계정을 넣으면 다음 상품 제안부터 칸이 채워져요.</CardContent>
        </Card>
      ) : (
        <SettingsList rows={rows} basePath="/auto/settings" emptyNote="참고할 내용을 아직 안 정했어요. AI가 기본으로 만들어요." />
      )}
    </main>
  );
}

import { redirect } from "next/navigation";
import { SettingsList } from "@/components/shoot/settings-list";
import { ShootAddAccount } from "@/components/shoot/shoot-settings";
import { Card, CardContent } from "@/components/ui/card";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { CONCEPT_SELECT, roleLabel, savedConceptItems, type ConceptRow } from "@/lib/schedule/concept-data";
import { SCOPE_OPTIONS, scopeLabel } from "@/lib/schedule/slot-admin";

// 촬영 설정 목록 — 직접 촬영 기획을 만들 계정(관리자 · 매니저가 추가)을 짧은 줄로 보여 주고, 줄을 누르면 상세(/shoot/settings/[accountId])에서 고친다.
// AI 자동의 참고 내용은 자동 콘텐츠 설정에 따로 있어 섞이지 않는다. 쓸 상품만 함께 쓴다(2026-11-04 사용자 결정).

export const metadata = { title: "촬영 설정 | MCB" };

export default async function ShootSettingsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");
  const canManage = profile.role === "ADMIN" || profile.role === "MANAGER";
  const supabase = await getServerSupabase();

  const [{ data: settings }, { data: igAccounts }, { data: conceptRows }, { data: ideas }] = await Promise.all([
    supabase.from("track_settings").select("social_account_id, product_scopes, shoot_enabled, social_accounts(display_name, disconnected_at)"),
    supabase.from("social_accounts").select("id, display_name").eq("platform", "INSTAGRAM").is("disconnected_at", null).order("display_name"),
    supabase.from("account_concepts").select(CONCEPT_SELECT),
    supabase.from("content_plans").select("social_account_id").eq("track", "A").eq("status", "PROPOSED"),
  ]);

  const scopesOf = (raw: unknown) => (raw ?? []) as { shop: string; kind: string }[];
  const conceptOf = new Map((conceptRows ?? []).map((c) => [c.social_account_id, c as unknown as ConceptRow]));
  const settingOf = new Map((settings ?? []).map((s) => [s.social_account_id, s]));
  const ideaCount = new Map<string, number>();
  for (const i of ideas ?? []) ideaCount.set(i.social_account_id, (ideaCount.get(i.social_account_id) ?? 0) + 1);

  const rows = (settings ?? [])
    .filter((s) => s.shoot_enabled && s.social_accounts && !s.social_accounts.disconnected_at)
    .map((s) => {
      const acc = s.social_accounts!;
      const c = conceptOf.get(s.social_account_id);
      return {
        accountId: s.social_account_id,
        name: acc.display_name ?? "",
        role: roleLabel(c?.shoot_role_focus),
        meta: `기획 ${ideaCount.get(s.social_account_id) ?? 0}개`,
        scopeLabels: scopesOf(s.product_scopes).map(scopeLabel),
        saved: savedConceptItems(c, "shoot"),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const candidates = (igAccounts ?? [])
    .filter((a) => !settingOf.get(a.id)?.shoot_enabled)
    .map((a) => ({ id: a.id, name: a.display_name ?? "", scopes: scopesOf(settingOf.get(a.id)?.product_scopes).map((x) => `${x.shop}:${x.kind}`) }));

  return (
    <main className="space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-[-0.01em]">촬영 설정</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            직접 찍어 올리는 영상의 기획을 만들 계정이에요. 계정을 눌러 후킹 문구 · 말투 · 편집 스타일을 정하면 기획 · 컷 리스트 · 편집에 계속 씁니다. 자동 콘텐츠 설정과는 따로 저장되고, 쓸 상품만 함께 써요.
            {!canManage && " 관리자 · 매니저만 바꿀 수 있어요."}
          </p>
        </div>
        {canManage && <ShootAddAccount candidates={candidates} options={SCOPE_OPTIONS} />}
      </header>

      {rows.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center text-sm text-muted-foreground">기획을 만들 계정이 없어요. 계정을 추가하면 몇 분 뒤 기획이 생겨요.</CardContent>
        </Card>
      ) : (
        <SettingsList rows={rows} basePath="/shoot/settings" emptyNote="참고할 내용을 아직 안 정했어요. AI가 기본으로 기획해요." />
      )}
    </main>
  );
}

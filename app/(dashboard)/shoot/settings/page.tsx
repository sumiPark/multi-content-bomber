import { redirect } from "next/navigation";
import { AccountConceptCard } from "@/components/schedule/account-concept";
import { ShootAccountHeader, ShootAddAccount } from "@/components/shoot/shoot-settings";
import { Card, CardContent } from "@/components/ui/card";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { conceptCardData } from "@/lib/schedule/concept-data";
import { SCOPE_OPTIONS } from "@/lib/schedule/slot-admin";

// 촬영 설정 — 직접 촬영 기획을 만들 계정(관리자 · 매니저가 추가 · 빼기)과 계정별 직접 촬영 컨셉.
// AI 자동 업로드의 컨셉은 자동 업로드 일정에 따로 있고, 쓸 상품 범위만 함께 쓴다(2026-11-04 사용자 결정).

export const metadata = { title: "촬영 설정 | MCB" };

export default async function ShootSettingsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");
  const canManage = profile.role === "ADMIN" || profile.role === "MANAGER";
  const supabase = await getServerSupabase();

  const [{ data: settings }, { data: igAccounts }, { data: conceptRows }] = await Promise.all([
    supabase.from("track_settings").select("social_account_id, product_scopes, shoot_enabled, social_accounts(display_name, disconnected_at, role_focus)"),
    supabase.from("social_accounts").select("id, display_name").eq("platform", "INSTAGRAM").is("disconnected_at", null).order("display_name"),
    supabase.from("account_concepts").select("social_account_id, auto_concept, auto_hooks, auto_endings, auto_tone, auto_video_style, shoot_concept, shoot_hooks, shoot_endings, shoot_tone, shoot_edit_style, shoot_edit_params, updated_at"),
  ]);

  const scopeKeys = (raw: unknown) => ((raw ?? []) as { shop: string; kind: string }[]).map((x) => `${x.shop}:${x.kind}`);
  const conceptOf = new Map((conceptRows ?? []).map((c) => [c.social_account_id, c]));
  const settingOf = new Map((settings ?? []).map((s) => [s.social_account_id, s]));

  const enabled = (settings ?? [])
    .filter((s) => s.shoot_enabled && s.social_accounts && !s.social_accounts.disconnected_at)
    .map((s) => {
      const acc = s.social_accounts!;
      const role = acc.role_focus === "PERSON" ? "사람 중심" : acc.role_focus === "PRODUCT" ? "상품 중심" : null;
      return {
        accountId: s.social_account_id,
        name: acc.display_name ?? "",
        scopes: scopeKeys(s.product_scopes),
        concept: conceptCardData({ accountId: s.social_account_id, name: acc.display_name ?? "", role, autoSlots: 0, row: conceptOf.get(s.social_account_id) }),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const candidates = (igAccounts ?? [])
    .filter((a) => !settingOf.get(a.id)?.shoot_enabled)
    .map((a) => ({ id: a.id, name: a.display_name ?? "", scopes: scopeKeys(settingOf.get(a.id)?.product_scopes) }));

  return (
    <main className="space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-[-0.01em]">촬영 설정</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            어느 계정에 촬영 기획을 만들지 정하고, 계정마다 후킹 문구 · 말투 · 편집 스타일을 저장해요. AI가 기획 · 컷 리스트 · 편집에 계속 씁니다. 광고 문구 규칙과 상품 사실이 항상 먼저예요.
            {!canManage && " 관리자 · 매니저만 바꿀 수 있어요."}
          </p>
        </div>
        {canManage && <ShootAddAccount candidates={candidates} options={SCOPE_OPTIONS} />}
      </header>

      {enabled.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center text-sm text-muted-foreground">기획을 만들 계정이 없어요. 계정을 추가하면 몇 분 뒤 기획이 생겨요.</CardContent>
        </Card>
      ) : (
        enabled.map((a) => (
          <section key={a.accountId} className="space-y-2" aria-label={`@${a.name} 촬영 설정`}>
            <AccountConceptCard
              data={a.concept}
              canManage={canManage}
              mode="shoot"
              top={<ShootAccountHeader accountId={a.accountId} name={a.name} scopes={a.scopes} options={SCOPE_OPTIONS} canManage={canManage} />}
            />
          </section>
        ))
      )}
    </main>
  );
}

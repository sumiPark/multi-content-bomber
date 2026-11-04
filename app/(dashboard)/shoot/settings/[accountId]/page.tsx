import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { AccountConceptCard } from "@/components/schedule/account-concept";
import { ShootAccountHeader } from "@/components/shoot/shoot-settings";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { conceptCardData } from "@/lib/schedule/concept-data";
import { SCOPE_OPTIONS } from "@/lib/schedule/slot-admin";

// 촬영 설정 상세 — 계정 하나의 쓸 상품과 직접 촬영 컨셉(후킹 문구 · 마지막 문구 · 말투 · 편집 스타일 · 메모)을 고친다.

export const metadata = { title: "촬영 설정 | MCB" };

export default async function ShootSettingsDetailPage({ params }: { params: Promise<{ accountId: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");
  const canManage = profile.role === "ADMIN" || profile.role === "MANAGER";
  const { accountId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) notFound();

  const supabase = await getServerSupabase();
  const [{ data: setting }, { data: concept }] = await Promise.all([
    supabase.from("track_settings").select("social_account_id, product_scopes, shoot_enabled, social_accounts(display_name, disconnected_at, role_focus)").eq("social_account_id", accountId).maybeSingle(),
    supabase
      .from("account_concepts")
      .select("social_account_id, auto_concept, auto_hooks, auto_endings, auto_tone, auto_video_style, shoot_concept, shoot_hooks, shoot_endings, shoot_tone, shoot_edit_style, shoot_edit_params, updated_at")
      .eq("social_account_id", accountId)
      .maybeSingle(),
  ]);
  const acc = setting?.social_accounts;
  // 뺀 계정은 목록으로
  if (!setting?.shoot_enabled || !acc || acc.disconnected_at) redirect("/shoot/settings");

  const name = acc.display_name ?? "";
  const role = acc.role_focus === "PERSON" ? "사람 중심" : acc.role_focus === "PRODUCT" ? "상품 중심" : null;
  const scopes = ((setting.product_scopes ?? []) as { shop: string; kind: string }[]).map((x) => `${x.shop}:${x.kind}`);

  return (
    <main className="space-y-4 p-4 sm:p-6">
      <Link href="/shoot/settings" className="inline-flex items-center gap-1 text-[13px] font-medium text-muted-foreground hover:text-foreground">
        <ChevronLeft className="size-4" /> 촬영 설정 목록
      </Link>
      <h1 className="text-xl font-bold tracking-[-0.01em]">@{name}</h1>
      <AccountConceptCard
        data={conceptCardData({ accountId, name, role, autoSlots: 0, row: concept ?? undefined })}
        canManage={canManage}
        mode="shoot"
        hideName
        top={<ShootAccountHeader accountId={accountId} name={name} scopes={scopes} options={SCOPE_OPTIONS} canManage={canManage} />}
      />
    </main>
  );
}

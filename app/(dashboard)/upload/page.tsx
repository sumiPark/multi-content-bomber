import { redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { UploadWizard } from "@/components/upload/wizard/upload-wizard";
import { createClient } from "@/lib/supabase/server";

export default async function UploadPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("organization_id, role")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile?.organization_id) redirect("/onboarding");

  const { data: organization } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", profile.organization_id)
    .single();

  const [accountsRes, presetsRes] = await Promise.all([
    supabase
      .from("social_accounts")
      .select("id, platform, display_name, is_active, token_expires_at")
      .eq("is_active", true),
    supabase
      .from("caption_presets")
      .select("id, name, description")
      .order("created_at", { ascending: false }),
  ]);

  return (
    <main className="container mx-auto max-w-5xl px-6 py-10 space-y-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            새 콘텐츠 만들기
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            이미지 1~10장 또는 영상 1개를 업로드하면 AI가 플랫폼별 캡션을
            생성합니다.
          </p>
        </div>
        {organization && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>{organization.name}</span>
            <Badge variant="outline">{profile.role}</Badge>
          </div>
        )}
      </header>
      <UploadWizard
        organizationId={profile.organization_id}
        userId={user.id}
        socialAccounts={accountsRes.data ?? []}
        presets={presetsRes.data ?? []}
      />
    </main>
  );
}

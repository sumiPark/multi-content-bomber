import { redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { UploadWizard } from "@/components/upload/wizard/upload-wizard";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";

export default async function UploadPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");

  const supabase = await getServerSupabase();

  const { data: organization } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", profile.organization_id)
    .single();

  // group_id / account_groups는 0009 마이그레이션 이후. 타입 재생성 전이라 cast.
  type AccountRow = {
    id: string;
    platform: "YOUTUBE" | "INSTAGRAM" | "TIKTOK";
    display_name: string | null;
    is_active: boolean;
    token_expires_at: string | null;
    group_id: string | null;
  };
  type GroupRow = {
    id: string;
    name: string;
    color: string;
  };

  const untypedSupabase = supabase as unknown as {
    from: (t: string) => {
      select: (cols: string) => {
        order: (
          col: string,
          opts: { ascending: boolean },
        ) => Promise<{ data: GroupRow[] | null }>;
      };
    };
  };

  const [accountsRes, presetsRes, groupsRes] = await Promise.all([
    supabase
      .from("social_accounts")
      .select(
        "id, platform, display_name, is_active, token_expires_at, group_id",
      )
      .eq("is_active", true) as unknown as Promise<{
      data: AccountRow[] | null;
    }>,
    supabase
      .from("caption_presets")
      .select("id, name, description")
      .order("created_at", { ascending: false }),
    untypedSupabase
      .from("account_groups")
      .select("id, name, color")
      .order("created_at", { ascending: true }),
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
        accountGroups={groupsRes.data ?? []}
        presets={presetsRes.data ?? []}
      />
    </main>
  );
}

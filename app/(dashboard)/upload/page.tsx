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

  // 토큰 만료(is_active=false) 계정도 목록에 남겨 마법사가 "비활성"으로 회색 표시한다
  // (선택은 불가). 연결 해제(0016)한 계정만 뺀다.
  const [accountsRes, presetsRes, groupsRes, seriesRes] = await Promise.all([
    supabase
      .from("social_accounts")
      .select(
        "id, platform, display_name, is_active, token_expires_at, group_id",
      )
      .is("disconnected_at", null) as unknown as Promise<{
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
    // 시리즈 댓글 자동화(0017) — 마지막 단계의 "다음 화로 올리기" 선택지. 인스타 계정별 시리즈.
    supabase
      .from("series")
      .select("id, name, social_account_id, series_episodes(episode_no)")
      .is("deleted_at", null)
      .order("created_at", { ascending: true }),
  ]);

  const seriesOptions = (seriesRes.data ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    socialAccountId: s.social_account_id,
    nextEpisodeNo:
      Math.max(0, ...s.series_episodes.map((e) => e.episode_no)) + 1,
  }));

  return (
    <main className="container mx-auto max-w-5xl px-6 py-10 space-y-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            콘텐츠 생성
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
        seriesOptions={seriesOptions}
      />
    </main>
  );
}

import { SidebarShell } from "@/components/layout/sidebar-shell";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getSessionUser();

  // No user yet (e.g. mid-redirect from a protected page) — render bare.
  if (!user) return <>{children}</>;

  const [failedJobCount, org, profileScoredAt] = await Promise.all([
    loadFailedJobCount(),
    loadOrganization(),
    loadProfileScoredAt(),
  ]);

  return (
    <SidebarShell
      userEmail={user.email ?? null}
      failedJobCount={failedJobCount}
      orgName={org?.name ?? null}
      role={org?.role ?? null}
      analyticsUpdatedAt={profileScoredAt}
    >
      {children}
    </SidebarShell>
  );
}

// 사이드바 "배포 관리" 빨간 뱃지에 표시할 미처리 실패 건수.
// RLS가 organization scope를 강제하므로 조직 외 데이터는 자동 제외된다.
async function loadFailedJobCount(): Promise<number> {
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) return 0;

  const supabase = await getServerSupabase();
  // 대시보드 · 배포 관리와 같은 기준(최근 90일) — 전체를 세면 눌러 들어가도 안 보이는 옛 실패까지 셌다
  const { count } = await supabase
    .from("publish_jobs")
    .select("id", { count: "exact", head: true })
    .eq("status", "FAILED")
    .is("deleted_at", null)
    .gte("created_at", new Date(Date.now() - 90 * 86_400_000).toISOString());

  return count ?? 0;
}

// 사이드바 "분석" 새 결과 점 — 가장 최근 프로필 채점이 끝난 시각(0034). 못 읽으면 점 없음.
async function loadProfileScoredAt(): Promise<string | null> {
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) return null;
  const supabase = await getServerSupabase();
  const { data } = await supabase
    .from("profile_reviews")
    .select("finished_at")
    .eq("status", "DONE")
    .not("finished_at", "is", null)
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.finished_at ?? null;
}

// 사이드바 조직 카드(조직 이름 + 내 역할). 못 읽어도 화면은 그대로 뜬다.
async function loadOrganization(): Promise<{ name: string | null; role: string } | null> {
  const profile = await getCurrentProfile();
  if (!profile) return null;
  if (!profile.organization_id) return { name: null, role: profile.role };
  const supabase = await getServerSupabase();
  const { data } = await supabase.from("organizations").select("name").eq("id", profile.organization_id).maybeSingle();
  return { name: data?.name ?? null, role: profile.role };
}

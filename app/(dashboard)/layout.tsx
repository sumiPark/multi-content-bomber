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

  const [failedJobCount, org] = await Promise.all([loadFailedJobCount(), loadOrganization()]);

  return (
    <SidebarShell
      userEmail={user.email ?? null}
      failedJobCount={failedJobCount}
      orgName={org?.name ?? null}
      role={org?.role ?? null}
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
  const { count } = await supabase
    .from("publish_jobs")
    .select("id", { count: "exact", head: true })
    .eq("status", "FAILED")
    .is("deleted_at", null);

  return count ?? 0;
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

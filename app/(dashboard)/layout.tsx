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

  const [failedJobCount, alertWaitingCount] = await Promise.all([
    loadFailedJobCount(),
    loadAlertWaitingCount(),
  ]);

  return (
    <SidebarShell
      userEmail={user.email ?? null}
      failedJobCount={failedJobCount}
      alertWaitingCount={alertWaitingCount}
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

// 사이드바 "시리즈 댓글 자동화" 뱃지 — 사람이 확인하고 보내기를 눌러야 하는 알림 수.
async function loadAlertWaitingCount(): Promise<number> {
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) return 0;

  const supabase = await getServerSupabase();
  const { count } = await supabase
    .from("episode_alert_tasks")
    .select("id", { count: "exact", head: true })
    .eq("status", "AWAITING_APPROVAL");

  return count ?? 0;
}

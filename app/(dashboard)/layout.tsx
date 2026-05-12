import { SidebarShell } from "@/components/layout/sidebar-shell";
import { getSessionUser } from "@/lib/auth";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getSessionUser();

  // No user yet (e.g. mid-redirect from a protected page) — render bare.
  if (!user) return <>{children}</>;

  return (
    <SidebarShell userEmail={user.email ?? null}>{children}</SidebarShell>
  );
}

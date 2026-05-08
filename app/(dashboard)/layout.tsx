import { SidebarShell } from "@/components/layout/sidebar-shell";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // No user yet (e.g. mid-redirect from a protected page) — render bare.
  if (!user) return <>{children}</>;

  return (
    <SidebarShell userEmail={user.email ?? null}>{children}</SidebarShell>
  );
}

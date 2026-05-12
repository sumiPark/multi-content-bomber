import { redirect } from "next/navigation";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { AccountsPage } from "@/components/accounts/accounts-page";

interface AccountsPageProps {
  searchParams: Promise<{ connected?: string; error?: string }>;
}

export default async function Page({ searchParams }: AccountsPageProps) {
  const params = await searchParams;

  const user = await getSessionUser();
  if (!user) redirect("/login");

  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");

  const supabase = await getServerSupabase();
  const canManage =
    profile.role === "ADMIN" || profile.role === "MANAGER";

  // group_id는 0009 마이그레이션 이후 추가. 타입 재생성 전이라 cast.
  type AccountRow = {
    id: string;
    platform: "YOUTUBE" | "INSTAGRAM" | "TIKTOK";
    display_name: string | null;
    is_active: boolean;
    token_expires_at: string | null;
    created_at: string;
    group_id: string | null;
  };

  const { data: accounts } = (await supabase
    .from("social_accounts")
    .select(
      "id, platform, display_name, is_active, token_expires_at, created_at, group_id",
    )
    .order("created_at", { ascending: false })) as unknown as {
    data: AccountRow[] | null;
  };

  type GroupRow = {
    id: string;
    name: string;
    description: string | null;
    color: string;
    created_at: string;
  };

  // 0009 이후 신설 테이블. 타입 재생성 전이므로 from 자체에서 supabase가 모름 → cast.
  const untyped = supabase as unknown as {
    from: (t: string) => {
      select: (cols: string) => {
        order: (
          col: string,
          opts: { ascending: boolean },
        ) => Promise<{ data: GroupRow[] | null }>;
      };
    };
  };
  const { data: groups } = await untyped
    .from("account_groups")
    .select("id, name, description, color, created_at")
    .order("created_at", { ascending: true });

  return (
    <AccountsPage
      accounts={accounts ?? []}
      groups={groups ?? []}
      canManage={canManage}
      flashMessage={
        params.connected
          ? `${params.connected.toUpperCase()} 계정이 연결되었습니다.`
          : null
      }
      flashError={params.error ? decodeURIComponent(params.error) : null}
    />
  );
}

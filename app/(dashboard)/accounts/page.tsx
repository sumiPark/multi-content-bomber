import { redirect } from "next/navigation";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { AccountsPage } from "@/components/accounts/accounts-page";
import type {
  InstagramRoleRow,
  RoleFocus,
} from "@/components/accounts/account-roles";

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

  // 연결 해제(0016)한 계정만 숨긴다. 토큰 만료(is_active=false)는 "비활성"으로 계속
  // 보여야 재연결할 수 있다. 해제된 계정의 발행 이력은 배포 관리에 남는다.
  const { data: accounts } = (await supabase
    .from("social_accounts")
    .select(
      "id, platform, display_name, is_active, token_expires_at, created_at, group_id",
    )
    .is("disconnected_at", null)
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

  // 인스타 계정 역할 · 성과 권한 (0024). 마지막 수집 행의 도달(reach)이 채워져 있으면
  // 성과 권한이 실제로 통한 것 — 0024 이전 연결이라 동의 목록이 없는 계정의 근거로 쓴다.
  const instagramIds = (accounts ?? [])
    .filter((a) => a.platform === "INSTAGRAM")
    .map((a) => a.id);
  let instagramRoles: InstagramRoleRow[] = [];
  if (instagramIds.length > 0) {
    const [{ data: roleRows }, { data: dailyRows }] = await Promise.all([
      supabase
        .from("social_accounts")
        .select("id, display_name, role_focus, role_note, granted_scopes")
        .in("id", instagramIds),
      supabase
        .from("account_daily")
        .select("social_account_id, day, reach")
        .in("social_account_id", instagramIds)
        .order("day", { ascending: false })
        .limit(instagramIds.length * 7),
    ]);
    const latestDaily = new Map<string, { day: string; reach: number | null }>();
    for (const d of dailyRows ?? []) {
      if (!latestDaily.has(d.social_account_id)) {
        latestDaily.set(d.social_account_id, d);
      }
    }
    instagramRoles = (roleRows ?? []).map((r) => ({
      id: r.id,
      display_name: r.display_name,
      role_focus: (r.role_focus as RoleFocus | null) ?? null,
      role_note: r.role_note,
      granted_scopes: r.granted_scopes,
      insights_seen: latestDaily.get(r.id)?.reach != null,
      last_collected_on: latestDaily.get(r.id)?.day ?? null,
    }));
  }

  return (
    <AccountsPage
      accounts={accounts ?? []}
      groups={groups ?? []}
      instagramRoles={instagramRoles}
      canManage={canManage}
      flashMessage={
        params.connected
          ? `${({ YOUTUBE: "유튜브", INSTAGRAM: "인스타그램", TIKTOK: "틱톡" } as Record<string, string>)[params.connected.toUpperCase()] ?? params.connected} 계정을 연결했어요.`
          : null
      }
      flashError={params.error ?? null}
    />
  );
}

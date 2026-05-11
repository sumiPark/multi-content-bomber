import Link from "next/link";
import { redirect } from "next/navigation";
import { Plug, Unplug } from "lucide-react";
import { disconnectAccountAction } from "./actions";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";

const PLATFORMS = [
  {
    id: "INSTAGRAM" as const,
    name: "Instagram",
    color: "bg-pink-500",
    enabled: true,
  },
  {
    id: "TIKTOK" as const,
    name: "TikTok",
    color: "bg-zinc-900",
    enabled: true,
  },
  {
    id: "YOUTUBE" as const,
    name: "YouTube",
    color: "bg-red-500",
    enabled: true,
  },
];

interface AccountsPageProps {
  searchParams: Promise<{ connected?: string; error?: string }>;
}

type AccountStatus = {
  label: string;
  variant: "secondary" | "destructive" | "outline";
};

// TikTok/YouTube는 access_token이 짧지만 refresh_token으로 자동 갱신되므로
// access_token 만료 시간을 사용자에게 노출하지 않음. refresh_token 자체의
// 만료/회수는 별도 모니터링이 필요(Phase 4c 자동 갱신 작업에서 처리).
const PLATFORMS_WITH_REFRESH = new Set(["TIKTOK", "YOUTUBE"]);

function getStatus(
  isActive: boolean,
  expiresAt: string | null,
  platform: string,
): AccountStatus {
  if (!isActive) return { label: "비활성", variant: "destructive" };
  if (PLATFORMS_WITH_REFRESH.has(platform))
    return { label: "활성", variant: "secondary" };
  if (!expiresAt) return { label: "활성", variant: "secondary" };
  const expires = new Date(expiresAt).getTime();
  const now = Date.now();
  const daysToExpiry = (expires - now) / (24 * 3600 * 1000);
  if (daysToExpiry < 0) return { label: "토큰 만료", variant: "destructive" };
  if (daysToExpiry < 7) return { label: "만료 임박", variant: "outline" };
  return { label: "활성", variant: "secondary" };
}

export default async function AccountsPage({ searchParams }: AccountsPageProps) {
  const params = await searchParams;

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

  const canManage =
    profile.role === "ADMIN" || profile.role === "MANAGER";

  const { data: accounts } = await supabase
    .from("social_accounts")
    .select(
      "id, platform, display_name, is_active, token_expires_at, created_at",
    )
    .order("created_at", { ascending: false });

  const list = accounts ?? [];

  return (
    <main className="container mx-auto max-w-4xl px-6 py-10 space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">계정 관리</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          업로드할 소셜 채널을 연동하세요. 워크스페이스 멤버 모두가 사용합니다.
        </p>
      </header>

      {params.connected && (
        <div className="rounded-md border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm">
          {params.connected.toUpperCase()} 계정이 연결되었습니다.
        </div>
      )}
      {params.error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {decodeURIComponent(params.error)}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>연동된 계정 ({list.length}개)</CardTitle>
        </CardHeader>
        <CardContent>
          {list.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              아직 연동된 계정이 없어요. 아래에서 플랫폼을 선택해 추가하세요.
            </p>
          ) : (
            <ul className="space-y-2">
              {list.map((acc) => {
                const status = getStatus(
                  acc.is_active,
                  acc.token_expires_at,
                  acc.platform,
                );
                const platform = PLATFORMS.find((p) => p.id === acc.platform);
                return (
                  <li key={acc.id}>
                    <div className="flex items-center gap-3 rounded-md border p-3">
                      <div
                        className={`flex size-9 items-center justify-center rounded-full text-xs font-semibold text-white ${platform?.color ?? "bg-zinc-500"}`}
                      >
                        {platform?.name.charAt(0) ?? "?"}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="truncate text-sm font-medium">
                          {acc.display_name ?? "(이름 없음)"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {platform?.name ?? acc.platform}
                        </p>
                      </div>
                      <Badge variant={status.variant}>{status.label}</Badge>
                      {canManage && (
                        <form action={disconnectAccountAction}>
                          <input
                            type="hidden"
                            name="accountId"
                            value={acc.id}
                          />
                          <button
                            type="submit"
                            className="flex items-center gap-1 rounded-md p-2 text-xs text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                            aria-label="연결 해제"
                          >
                            <Unplug className="size-4" />
                            연결 해제
                          </button>
                        </form>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>계정 추가</CardTitle>
          <CardDescription>플랫폼을 선택해 OAuth 인증을 시작하세요.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-3">
            {PLATFORMS.map((p) =>
              p.enabled ? (
                <Link
                  key={p.id}
                  href={`/api/auth/connect/${p.id.toLowerCase()}`}
                  className={buttonVariants({ variant: "outline" })}
                  style={{
                    flexDirection: "column",
                    height: "auto",
                    padding: "1.5rem",
                    gap: "0.5rem",
                  }}
                >
                  <div
                    className={`flex size-12 items-center justify-center rounded-full text-base font-semibold text-white ${p.color}`}
                  >
                    {p.name.charAt(0)}
                  </div>
                  <span className="text-sm font-medium">{p.name}</span>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Plug className="size-3" /> 연결
                  </span>
                </Link>
              ) : (
                <button
                  key={p.id}
                  type="button"
                  disabled
                  className="group flex flex-col items-center gap-2 rounded-md border bg-muted/20 p-6 text-center opacity-60"
                >
                  <div
                    className={`flex size-12 items-center justify-center rounded-full text-base font-semibold text-white ${p.color}`}
                  >
                    {p.name.charAt(0)}
                  </div>
                  <span className="text-sm font-medium">{p.name}</span>
                  <Badge variant="outline" className="text-xs">
                    곧 지원
                  </Badge>
                </button>
              ),
            )}
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            OAuth 콜백 URL은 환경변수 <code>NEXT_PUBLIC_SITE_URL</code>{" "}
            기준입니다. 각 플랫폼 개발자 콘솔에 동일한 URL을 등록하세요.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}

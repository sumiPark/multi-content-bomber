import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { RelativeTime } from "@/components/ui/relative-time";
import { ScrollArea } from "@/components/ui/scroll-area";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";

const STATUS_META: Record<
  string,
  { label: string; variant: "secondary" | "destructive" | "outline" | "default" }
> = {
  PENDING: { label: "대기", variant: "outline" },
  PROCESSING: { label: "진행중", variant: "secondary" },
  SUCCESS: { label: "성공", variant: "default" },
  FAILED: { label: "실패", variant: "destructive" },
  RETRYING: { label: "재시도", variant: "outline" },
};

const PAGE_LIMIT = 100;

export default async function UploadsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");

  const supabase = await getServerSupabase();

  const { data: jobs } = await supabase
    .from("publish_jobs")
    .select(
      "id, status, post_type, scheduled_for, attempts, last_error, content_id, social_account_id, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(PAGE_LIMIT);

  const list = jobs ?? [];

  const contentIds = [...new Set(list.map((j) => j.content_id))];
  const accountIds = [...new Set(list.map((j) => j.social_account_id))];

  const [contentsRes, accountsRes] = await Promise.all([
    contentIds.length > 0
      ? supabase
          .from("contents")
          .select("id, media_urls")
          .in("id", contentIds)
      : Promise.resolve({ data: [] as { id: string; media_urls: string[] }[] }),
    accountIds.length > 0
      ? supabase
          .from("social_accounts")
          .select("id, platform, display_name")
          .in("id", accountIds)
      : Promise.resolve({
          data: [] as {
            id: string;
            platform: string;
            display_name: string | null;
          }[],
        }),
  ]);

  const contentsById = new Map(
    (contentsRes.data ?? []).map((c) => [c.id, c]),
  );
  const accountsById = new Map(
    (accountsRes.data ?? []).map((a) => [a.id, a]),
  );

  return (
    <main className="container mx-auto max-w-4xl px-6 py-10 space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">업로드 이력</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          플랫폼별 게시 작업과 상태를 확인하세요. 워커는 Phase 4에서 활성화될
          예정입니다 — 지금은 작업이 등록되어도 PENDING 상태로 대기합니다.
        </p>
      </header>

      {list.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            아직 등록된 업로드 작업이 없어요.
            <br />새 콘텐츠를 만들 때 계정을 선택하면 여기 표시됩니다.
          </CardContent>
        </Card>
      ) : (
        <ScrollArea className="h-[calc(100vh-220px)] rounded-md">
          <ul className="space-y-2 pr-3">
            {list.map((job) => {
              const account = accountsById.get(job.social_account_id);
              const status =
                STATUS_META[job.status] ?? STATUS_META.PENDING;
              return (
                <li key={job.id}>
                  <Card>
                    <CardContent className="flex items-center gap-4 p-4">
                      <Badge variant={status.variant}>{status.label}</Badge>
                      <div className="flex-1 min-w-0 space-y-1">
                        <p className="truncate text-sm font-medium">
                          {account?.platform ?? "?"} ·{" "}
                          {account?.display_name ?? "(이름 없음)"} ·{" "}
                          {job.post_type}
                        </p>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          {job.scheduled_for ? (
                            <>
                              예약: <RelativeTime iso={job.scheduled_for} />
                            </>
                          ) : (
                            "즉시"
                          )}
                          <span>·</span>
                          <span>시도 {job.attempts}회</span>
                          {job.last_error && (
                            <span className="text-destructive">
                              · {job.last_error}
                            </span>
                          )}
                        </div>
                      </div>
                      <Link
                        href={`/?content=${job.content_id}`}
                        className="shrink-0 text-xs text-muted-foreground transition hover:text-foreground"
                      >
                        콘텐츠 보기 →
                      </Link>
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      )}
    </main>
  );
}

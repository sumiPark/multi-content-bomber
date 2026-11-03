import Link from "next/link";
import { redirect } from "next/navigation";
import { ScanSearch } from "lucide-react";
import { ProfileReviewView, type ReviewRow } from "@/components/account-review/profile-review";
import { ReviewForm } from "@/components/account-review/review-form";
import { Card, CardContent } from "@/components/ui/card";
import type { ProfileManualInput, ProfileSnapshot } from "@/lib/account-review/types";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { cn } from "@/lib/utils";

// 계정 점검 — 우리 인스타 계정 프로필을 12개 기준 100점으로 채점(ig-profile-ko, 0034).
// 채점은 워커(worker/review-profiles.ts)가 GitHub Actions에서 한다. 이 화면은 요청 · 결과 보기만.
// 게시물 분석(ig-audit-ko) · 다른 계정 비교(ig-viral-ko)는 성과 권한을 받은 뒤 이 화면에 붙인다.

const HISTORY = 8;
const BUSY_MS = 20 * 60_000;

// 20분 넘게 대기 · 채점 중이면 멈춘 것 — 다시 누를 수 있게 한다(워커도 그때 다시 집는다).
function isBusy(row: ReviewRow | null): boolean {
  if (!row || (row.status !== "PENDING" && row.status !== "RUNNING")) return false;
  return Date.now() - Date.parse(row.created_at) < BUSY_MS;
}

export default async function AccountReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ account?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");

  const { account: accountParam } = await searchParams;
  const supabase = await getServerSupabase();

  const { data: accountRows } = await supabase
    .from("social_accounts")
    .select("id, display_name, role_focus")
    .eq("platform", "INSTAGRAM")
    .is("disconnected_at", null)
    .order("created_at", { ascending: true });
  const accounts = accountRows ?? [];
  const selected = accounts.find((a) => a.id === accountParam) ?? accounts[0] ?? null;

  const { data: reviewRows } = selected
    ? await supabase
        .from("profile_reviews")
        .select("id, status, total_score, rescore, items, rewrites, summary, snapshot, manual_input, error, created_at, finished_at")
        .eq("social_account_id", selected.id)
        .order("created_at", { ascending: false })
        .limit(HISTORY)
    : { data: [] };
  const reviews = (reviewRows ?? []) as unknown as ReviewRow[];

  const latest = reviews[0] ?? null;
  const latestDone = reviews.find((r) => r.status === "DONE") ?? null;
  const busy = isBusy(latest);
  const failed = latest?.status === "FAILED" ? latest : null;
  // 입력칸은 마지막 요청 값으로 다시 채운다
  const lastManual = (latest?.manual_input ?? {}) as ProfileManualInput;
  const lastSnapshot = (latestDone?.snapshot ?? null) as ProfileSnapshot | null;

  return (
    <main className="space-y-6 p-4 sm:p-6">
      <header>
        <h1 className="text-xl font-bold tracking-[-0.01em]">계정 점검</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          인스타 프로필을 12개 기준 100점으로 채점하고, 점수를 가장 많이 깎는 곳부터 고칠 문구를 드려요.
          인스타에는 아무것도 바꾸지 않아요. 마음에 드는 문구를 직접 붙여 넣으세요.
        </p>
      </header>

      {accounts.length === 0 || !selected ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <ScanSearch className="size-10 text-muted-foreground" aria-hidden />
            <h2 className="text-lg font-semibold">연결된 인스타 계정이 없어요</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              <Link href="/accounts" className="underline underline-offset-2">
                계정 연동
              </Link>
              에서 인스타 계정을 먼저 연결하세요.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <nav aria-label="계정 고르기" className="inline-flex w-fit max-w-full items-center overflow-x-auto rounded-md border bg-surface-2 p-[2px]">
            {accounts.map((a) => {
              const on = a.id === selected.id;
              return (
                <Link
                  key={a.id}
                  href={`/account-review?account=${a.id}`}
                  aria-current={on ? "page" : undefined}
                  className={cn(
                    "inline-flex h-[30px] items-center rounded-[6px] px-3 text-[12.5px] font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    on && "bg-card font-semibold text-foreground shadow-[0_1px_2px_rgb(16_24_40/0.12)]",
                  )}
                >
                  {a.display_name ?? "(이름 없음)"}
                </Link>
              );
            })}
          </nav>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
            <ProfileReviewView latest={latestDone} history={reviews} busy={!!busy} failed={failed} />
            <ReviewForm
              key={selected.id}
              accountId={selected.id}
              initial={lastManual}
              snapshot={lastSnapshot}
              busy={!!busy}
            />
          </div>
        </>
      )}
    </main>
  );
}

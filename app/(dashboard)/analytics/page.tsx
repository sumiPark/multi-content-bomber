import Link from "next/link";
import { redirect } from "next/navigation";
import { BarChart3 } from "lucide-react";
import {
  AccountBaselineCard,
  type BaselineAccount,
  type BaselinePost,
} from "@/components/analytics/account-baseline";
import { collectMetricsNowAction } from "@/app/(dashboard)/analytics/actions";
import {
  ProfileScoreCard,
  ProfileScoreOverview,
  type ProfileScoreAccount,
  type ReviewRow,
} from "@/components/account-review/profile-review";
import { BenchmarkView } from "@/components/benchmark/benchmark-view";
import { AnalyticsTabs, type AnalyticsTab } from "@/components/analytics/analytics-tabs";
import { CollectNowButton } from "@/components/analytics/collect-now-button";
import { PostPerformance } from "@/components/posts/post-performance";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { ProfileSnapshot } from "@/lib/account-review/types";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { loadBenchmark } from "@/lib/benchmark/load";
import { loadPostPerformance } from "@/lib/post-analysis/load";
import { parsePostPeriod, periodStart } from "@/lib/post-analysis/stats";
import { cn } from "@/lib/utils";

// 분석 — 탭 셋: 프로필 점수(매일 04:30 자동 채점, 0034) · 게시물 성과(계정별 지난 게시물 + 기준선, 0040 · 0045) · 다른 계정 비교(0037).
// 게시물 성과 데이터는 성과 수집 워커(worker/collect-metrics.ts, 매일 04시)와 지난 게시물 워커(worker/sync-post-history.ts, 05:10)가 쌓는다.
// 트랙(A 혼합 / B 자동)별 비교는 운영 시작 뒤(7 첫 리포트)에 붙인다.

const BASELINE_POSTS = 30;
const FOLLOWER_COMPARE_DAYS = 7;
const PROFILE_HISTORY = 4;

// "며칠 전" 계산 기준 시각 — 요청마다 새로 그리는 서버 컴포넌트
const pageNow = () => Date.now();

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; account?: string; period?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");

  const { tab: tabParam, account: accountParam, period: periodParam } = await searchParams;

  const supabase = await getServerSupabase();

  const { data: accountRows } = await supabase
    .from("social_accounts")
    .select("id, display_name, role_focus, role_note, created_at, is_active")
    .eq("platform", "INSTAGRAM")
    .is("disconnected_at", null)
    .order("created_at", { ascending: true });
  const accounts = accountRows ?? [];

  const baselines: BaselineAccount[] = await Promise.all(
    accounts.map(async (acc) => {
      const { data: daily } = await supabase
        .from("account_daily")
        .select("day, followers_count, reach")
        .eq("social_account_id", acc.id)
        .order("day", { ascending: false })
        .limit(FOLLOWER_COMPARE_DAYS + 1);

      const latest = daily?.[0] ?? null;
      // 가장 오래된 비교 대상 (최대 7일 전). 하루치만 있으면 증감 없음.
      const before = daily && daily.length > 1 ? daily[daily.length - 1] : null;

      return {
        id: acc.id,
        name: acc.display_name ?? "(이름 없음)",
        roleFocus: (acc.role_focus as BaselineAccount["roleFocus"]) ?? null,
        roleNote: acc.role_note,
        followers: latest?.followers_count ?? null,
        followersBefore:
          before?.followers_count != null
            ? { day: before.day, count: before.followers_count }
            : null,
        lastCollectedOn: latest?.day ?? null,
        // 계정 도달이 채워졌으면 성과 권한이 통한 것. 게시물은 게시물 성과 탭에서 고른 계정만 아래에서 읽는다.
        hasInsights: latest?.reach != null,
        posts: [],
      };
    }),
  );

  const collected = baselines.some((b) => b.lastCollectedOn);

  // 프로필 점수(0034) — 계정마다 최근 채점 몇 개 (점수 변화 · 캡처 값 이어받기용)
  const reviewsByAccount = new Map<string, ReviewRow[]>(
    await Promise.all(
      accounts.map(async (acc) => {
        const { data } = await supabase
          .from("profile_reviews")
          .select("id, status, total_score, rescore, items, rewrites, summary, manual_input, snapshot, error, created_at, started_at, finished_at")
          .eq("social_account_id", acc.id)
          .order("created_at", { ascending: false })
          .limit(PROFILE_HISTORY);
        return [acc.id, (data ?? []) as unknown as ReviewRow[]] as const;
      }),
    ),
  );

  // 프로필 점수 순서: 연결된 계정 먼저 → 팔로워 많은 순. 팔로워는 마지막 채점의 인스타 값, 없으면 성과 수집 값
  const followersOf = (id: string): number | null => {
    const snap = reviewsByAccount.get(id)?.find((r) => r.status === "DONE")?.snapshot as { followers_count?: number | null } | undefined;
    return snap?.followers_count ?? baselines.find((b) => b.id === id)?.followers ?? null;
  };
  const scoreAccounts: ProfileScoreAccount[] = accounts
    .map((a) => ({ id: a.id, name: a.display_name ?? "(이름 없음)", active: a.is_active, followers: followersOf(a.id) }))
    .sort((a, b) => Number(b.active) - Number(a.active) || (b.followers ?? -1) - (a.followers ?? -1));
  // 위쪽 계정별 기준선도 같은 순서로
  const order = new Map(scoreAccounts.map((a, i) => [a.id, i]));
  baselines.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  // 탭 — 주소에 있으면 그대로, 없으면 데이터가 있는 탭. 둘 다 있으면 고칠 일이 보이는 프로필 점수
  const scoredCount = scoreAccounts.filter((a) => reviewsByAccount.get(a.id)?.some((r) => r.status === "DONE")).length;
  const collectedCount = baselines.filter((b) => b.lastCollectedOn).length;
  const tab: AnalyticsTab =
    tabParam === "profile" || tabParam === "posts" || tabParam === "compare" ? tabParam : collected && scoredCount === 0 ? "posts" : "profile";

  // 피드 진열 분석 이미지 — 비공개 저장소라 프로필 점수 탭을 열 때 서명 주소를 만든다
  const feedImages = new Map<string, string>();
  if (tab === "profile") {
    const paths = scoreAccounts.flatMap((a) => {
      const snap = reviewsByAccount.get(a.id)?.find((r) => r.status === "DONE")?.snapshot as ProfileSnapshot | undefined;
      return snap?.feed_review?.mosaic_path ? [{ id: a.id, path: snap.feed_review.mosaic_path }] : [];
    });
    if (paths.length) {
      const { data: signed } = await supabase.storage.from("media").createSignedUrls(paths.map((p) => p.path), 3600);
      for (const p of paths) {
        const url = signed?.find((x) => x.path === p.path)?.signedUrl;
        if (url) feedImages.set(p.id, url);
      }
    }
  }

  // 다른 계정 비교(0037) — 탭 숫자용 건수는 항상, 내용은 그 탭을 열 때만 읽는다
  const { data: linkRows } = await supabase.from("benchmark_links").select("social_account_id, benchmark_account_id");
  const compareCount = new Set((linkRows ?? []).map((l) => l.benchmark_account_id)).size;
  const compareAccounts = scoreAccounts
    .filter((a) => a.active)
    .map((a) => ({ id: a.id, name: a.name, linkCount: (linkRows ?? []).filter((l) => l.social_account_id === a.id).length }));
  // 고른 계정이 없으면 비교 목록이 있는 첫 계정
  const compareSelected = compareAccounts.find((a) => a.id === accountParam) ?? compareAccounts.find((a) => a.linkCount > 0) ?? compareAccounts[0] ?? null;
  const compareNow = pageNow();
  const compareData = tab === "compare" && compareSelected ? await loadBenchmark(supabase, compareSelected.id, compareNow) : null;
  const canEditCompare = profile.role === "ADMIN" || profile.role === "MANAGER";

  // 게시물 성과 — 계정 하나씩, 고른 기간만. 그 탭을 열 때만 읽는다
  const postsPeriod = parsePostPeriod(periodParam);
  const postsNow = pageNow();
  const postsSelected = tab === "posts" ? (scoreAccounts.find((a) => a.id === accountParam) ?? scoreAccounts[0] ?? null) : null;
  const postsData = postsSelected ? await loadPostPerformance(supabase, postsSelected.id, periodStart(postsPeriod, postsNow)) : null;
  const postsBaseline = postsSelected ? baselines.find((b) => b.id === postsSelected.id) ?? null : null;
  if (postsBaseline) {
    const { data: posts } = await supabase
      .from("social_posts")
      .select("id, permalink, caption, thumbnail_url, media_product_type, posted_at")
      .eq("social_account_id", postsBaseline.id)
      .order("posted_at", { ascending: false })
      .limit(BASELINE_POSTS);
    const postIds = (posts ?? []).map((p) => p.id);
    const { data: metrics } = postIds.length
      ? await supabase.from("post_latest_metrics").select("post_id, views, reach, likes, comments, saved, shares").in("post_id", postIds)
      : { data: [] };
    const metricByPost = new Map((metrics ?? []).map((m) => [m.post_id, m]));
    postsBaseline.posts = (posts ?? []).map((p): BaselinePost => {
      const m = metricByPost.get(p.id);
      return {
        id: p.id,
        permalink: p.permalink,
        caption: p.caption,
        thumbnailUrl: p.thumbnail_url,
        productType: p.media_product_type,
        postedAt: p.posted_at,
        views: m?.views ?? null,
        reach: m?.reach ?? null,
        likes: m?.likes ?? null,
        comments: m?.comments ?? null,
        saved: m?.saved ?? null,
        shares: m?.shares ?? null,
      };
    });
    postsBaseline.hasInsights = postsBaseline.hasInsights || postsBaseline.posts.some((p) => p.views != null);
  }

  return (
    <main className="space-y-5 p-4 sm:p-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold tracking-[-0.01em]">분석</h1>
            <Badge variant="outline">인스타 계정별 지금 수준</Badge>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {tab === "profile"
              ? "프로필을 12개 기준으로 매일 04:30에 자동 채점하고, 점수를 가장 많이 깎는 곳부터 고칠 문구를 드려요. 인스타에는 아무것도 바꾸지 않아요. 마음에 드는 문구를 직접 붙여 넣으세요."
              : tab === "compare"
                ? "우리 계정마다 참고할 계정을 두고, 그 계정 릴스가 평소보다 몇 배 잘됐는지 매일 읽어요. 고른 이유와 숫자 근거를 함께 보여 드려요."
                : "릴스 · 사진 · 캐러셀을 유형별 평소 조회수와 견줘 봐요. 어떤 게시물이 평소보다 몇 배 잘됐는지, 무엇을 더 만들지 숫자로 보여 드려요. 매일 새벽에 자동으로 수집해요."}
          </p>
        </div>
        {tab === "posts" && accounts.length > 0 && (
          <CollectNowButton
            action={collectMetricsNowAction}
            doneText="수집을 시작했어요. 2~3분 뒤 새로고침하세요."
          />
        )}
      </header>

      {accounts.length === 0 ? (
        <EmptyState
          title="연결된 인스타 계정이 없어요"
          body={
            <>
              <Link href="/accounts" className="underline underline-offset-2">
                계정 연동
              </Link>
              에서 인스타 계정을 먼저 연결하세요.
            </>
          }
        />
      ) : (
        <>
          <AnalyticsTabs active={tab} scoredCount={scoredCount} collectedCount={collectedCount} compareCount={compareCount} />

          {tab === "compare" ? (
            compareSelected && compareData ? (
              <BenchmarkView accounts={compareAccounts} selectedId={compareSelected.id} data={compareData} canEdit={canEditCompare} now={compareNow} />
            ) : (
              <EmptyState title="연결된 인스타 계정이 없어요" body="계정 연동에서 다시 연결한 뒤 비교 계정을 넣을 수 있어요." />
            )
          ) : tab === "profile" ? (
            <section aria-label="프로필 점수" className="space-y-3">
              <ProfileScoreOverview accounts={scoreAccounts} histories={reviewsByAccount} />
              {scoreAccounts
                .filter((a) => a.active)
                .map((a) => (
                  <ProfileScoreCard key={a.id} account={a} history={reviewsByAccount.get(a.id) ?? []} feedImageUrl={feedImages.get(a.id) ?? null} />
                ))}
            </section>
          ) : (
            <section aria-label="게시물 성과" className="space-y-4">
              <nav aria-label="계정 고르기" className="inline-flex w-fit max-w-full items-center overflow-x-auto rounded-md border bg-surface-2 p-[2px]">
                {scoreAccounts.map((a) => {
                  const on = a.id === postsSelected?.id;
                  return (
                    <Link
                      key={a.id}
                      href={`/analytics?tab=posts&account=${a.id}&period=${postsPeriod}`}
                      aria-current={on ? "page" : undefined}
                      className={cn(
                        "inline-flex h-[30px] items-center rounded-[6px] px-3 text-[12.5px] font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                        on && "bg-card font-semibold text-foreground shadow-[0_1px_2px_rgb(16_24_40/0.12)]",
                      )}
                    >
                      {a.name}
                    </Link>
                  );
                })}
              </nav>

              {postsData && postsSelected && <PostPerformance key={postsSelected.id} data={postsData} now={postsNow} period={postsPeriod} accountId={postsSelected.id} />}

              <details className="group">
                <summary className="cursor-pointer rounded-lg border bg-card px-4 py-3 text-[13px] font-medium text-ink-2">최근 게시물 30개 · 팔로워 변화</summary>
                <div className="mt-3">
              {!collected ? (
                <EmptyState
                  title="아직 수집된 데이터가 없어요"
                  body={
                    <>
                      오른쪽 위 <b>지금 수집</b>을 누르거나 다음 04시 자동 수집을
                      기다리세요. 조회 · 도달 · 저장 · 공유까지 보려면{" "}
                      <Link href="/accounts" className="underline underline-offset-2">
                        계정 연동
                      </Link>
                      에서 성과 권한이 있는지 먼저 확인하세요.
                    </>
                  }
                />
              ) : (
                postsBaseline && <AccountBaselineCard account={postsBaseline} />
              )}
                </div>
              </details>
            </section>
          )}
        </>
      )}
    </main>
  );
}

function EmptyState({ title, body }: { title: string; body: React.ReactNode }) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <BarChart3 className="size-10 text-muted-foreground" />
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="max-w-md text-sm text-muted-foreground">{body}</p>
      </CardContent>
    </Card>
  );
}

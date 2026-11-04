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
import { CollectNowButton } from "@/components/analytics/collect-now-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";

// 분석 — 콘텐츠 자동화 1단계: 인스타 계정별 기준선.
// 데이터는 성과 수집 워커(worker/collect-metrics.ts)가 매일 04시(KST)에 쌓는다(0024).
// 트랙(A 혼합 / B 자동)별 비교는 운영 시작 뒤(7 첫 리포트)에 붙인다.

const BASELINE_POSTS = 30;
const FOLLOWER_COMPARE_DAYS = 7;
const PROFILE_HISTORY = 4;

export default async function AnalyticsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");

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
      const [{ data: daily }, { data: posts }] = await Promise.all([
        supabase
          .from("account_daily")
          .select("day, followers_count, reach")
          .eq("social_account_id", acc.id)
          .order("day", { ascending: false })
          .limit(FOLLOWER_COMPARE_DAYS + 1),
        supabase
          .from("social_posts")
          .select("id, permalink, caption, thumbnail_url, media_product_type, posted_at")
          .eq("social_account_id", acc.id)
          .order("posted_at", { ascending: false })
          .limit(BASELINE_POSTS),
      ]);

      const postIds = (posts ?? []).map((p) => p.id);
      const { data: metrics } =
        postIds.length > 0
          ? await supabase
              .from("post_latest_metrics")
              .select("post_id, views, reach, likes, comments, saved, shares")
              .in("post_id", postIds)
          : { data: [] };
      const metricByPost = new Map((metrics ?? []).map((m) => [m.post_id, m]));

      const latest = daily?.[0] ?? null;
      // 가장 오래된 비교 대상 (최대 7일 전). 하루치만 있으면 증감 없음.
      const before = daily && daily.length > 1 ? daily[daily.length - 1] : null;

      const baselinePosts: BaselinePost[] = (posts ?? []).map((p) => {
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
        // 계정 도달이 채워졌거나 게시물 조회가 하나라도 있으면 성과 권한이 통한 것.
        hasInsights:
          latest?.reach != null || baselinePosts.some((p) => p.views != null),
        posts: baselinePosts,
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

  return (
    <main className="space-y-6 p-4 sm:p-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold tracking-[-0.01em]">분석</h1>
            <Badge variant="outline">인스타 계정별 지금 수준</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            인스타 계정마다 지금 수준을 숫자로 잡아 둡니다. 매일 04시에 팔로워와
            최근 게시물 성과를 자동으로 수집해요.
          </p>
        </div>
        {accounts.length > 0 && (
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
      ) : !collected ? (
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
        <div className="space-y-4">
          {baselines.map((b) => (
            <AccountBaselineCard key={b.id} account={b} />
          ))}
        </div>
      )}

      {accounts.length > 0 && (
        <section id="profile-score" aria-labelledby="profile-score-title" className="scroll-mt-20 space-y-3">
          <div>
            <h2 id="profile-score-title" className="text-base font-semibold">
              프로필 점수
            </h2>
            <p className="mt-0.5 max-w-3xl text-[13px] text-muted-foreground">
              프로필을 12개 기준으로 매일 04:30에 자동 채점하고, 점수를 가장 많이 깎는 곳부터 고칠 문구를 드려요.
              인스타에는 아무것도 바꾸지 않아요. 마음에 드는 문구를 직접 붙여 넣으세요.
            </p>
          </div>
          <ProfileScoreOverview accounts={scoreAccounts} histories={reviewsByAccount} />
          {scoreAccounts
            .filter((a) => a.active)
            .map((a) => (
              <ProfileScoreCard key={a.id} account={a} history={reviewsByAccount.get(a.id) ?? []} />
            ))}
        </section>
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

import { redirect } from "next/navigation";
import {
  EpisodeAlertsPage,
  type AlertAccountView,
  type SeriesView,
  type TaskView,
} from "@/components/episode-alerts/episode-alerts-page";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { DEFAULT_ALERT_SETTINGS } from "@/lib/episode-alerts/server";
import { DEFAULT_TEMPLATES } from "@/lib/episode-alerts/templates";

export const metadata = {
  title: "시리즈 댓글 자동화 | MCB",
};

// 회차별 진행 상황을 보여주려고 작업을 넉넉히 읽는다. 기록 목록엔 최근 것만.
const TASK_LIMIT = 500;
const HISTORY_LIMIT = 30;

// 1분 이상 뒤로 미뤄진 발송인지(하루 상한·호출 한도). 서버 렌더 시점 기준.
function isFuture(iso: string): boolean {
  return new Date(iso).getTime() > Date.now() + 60_000;
}

interface PageProps {
  searchParams: Promise<{ account?: string }>;
}

export default async function Page({ searchParams }: PageProps) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const params = await searchParams;
  const supabase = await getServerSupabase();

  // DB 왕복을 줄이려고 조직의 인스타 계정·시리즈·작업을 한 번에 다 읽고(RLS가 조직 범위를
  // 건다), 고른 계정 것만 메모리에서 거른다. 계정·시리즈 수가 많지 않아 이게 훨씬 빠르다.
  const [
    profile,
    { data: accountRows },
    { data: settingsRows },
    { data: seriesRows },
    { data: taskRows },
    { data: statRows },
  ] = await Promise.all([
    getCurrentProfile(),
    supabase
      .from("social_accounts")
      .select("id, display_name, avatar_url, is_active")
      .eq("platform", "INSTAGRAM")
      .is("disconnected_at", null)
      .order("created_at", { ascending: true }),
    supabase.from("episode_alert_settings").select("social_account_id, daily_limit"),
    // 삭제된 시리즈도 읽는다 — 보낸 기록에 이름·회차 번호가 필요하다.
    supabase
      .from("series")
      .select(
        "id, name, reply_templates, social_account_id, deleted_at, created_at, series_episodes(id, episode_no, permalink, caption, media_type, posted_at, content_id, reply_enabled)",
      )
      .order("created_at", { ascending: true })
      .order("episode_no", { referencedTable: "series_episodes", ascending: true }),
    supabase
      .from("episode_alert_tasks")
      .select(
        "id, social_account_id, series_id, source_episode_id, target_episode_id, status, scheduled_for, last_error, created_at, completed_at, created_by, watch_until",
      )
      .order("created_at", { ascending: false })
      .limit(TASK_LIMIT),
    supabase.from("episode_alert_task_stats").select("*"),
  ]);

  if (!profile?.organization_id) redirect("/onboarding");
  const canManage = profile.role === "ADMIN" || profile.role === "MANAGER";

  // 인스타 계정만. 연결 해제(0016)한 계정은 빼고, 토큰 만료 계정은 기록을 볼 수 있게 남긴다.
  const accounts: AlertAccountView[] = (accountRows ?? []).map((a) => ({
    id: a.id,
    name: a.display_name,
    avatarUrl: a.avatar_url,
    isActive: a.is_active,
  }));

  const selected =
    accounts.find((a) => a.id === params.account) ??
    accounts.find((a) => a.isActive) ??
    accounts[0] ??
    null;

  if (!selected) {
    return (
      <EpisodeAlertsPage
        accounts={[]}
        selectedAccountId={null}
        canManage={canManage}
        dailyLimit={DEFAULT_ALERT_SETTINGS.dailyLimit}
        series={[]}
        history={[]}
      />
    );
  }

  const allSeries = seriesRows ?? [];
  const seriesById = new Map(allSeries.map((s) => [s.id, s]));
  const episodeNoById = new Map(
    allSeries.flatMap((s) => s.series_episodes.map((e) => [e.id, e.episode_no] as const)),
  );
  const statsByTask = new Map((statRows ?? []).map((s) => [s.task_id, s]));

  const taskViews: TaskView[] = (taskRows ?? [])
    .filter((t) => t.social_account_id === selected.id)
    .map((t) => {
      const s = statsByTask.get(t.id);
      const series = seriesById.get(t.series_id);
      return {
        id: t.id,
        seriesName: series?.name ?? "(삭제된 시리즈)",
        seriesDeleted: !!series?.deleted_at,
        sourceEpisodeNo: episodeNoById.get(t.source_episode_id) ?? null,
        targetEpisodeNo: episodeNoById.get(t.target_episode_id) ?? null,
        targetEpisodeId: t.target_episode_id,
        status: t.status,
        auto: t.created_by === null,
        scheduledFor: t.scheduled_for,
        deferred:
          (t.status === "SENDING" || t.status === "COLLECTING") && isFuture(t.scheduled_for),
        watching: t.watch_until !== null && isFuture(t.watch_until),
        lastError: t.last_error,
        createdAt: t.created_at,
        completedAt: t.completed_at,
        stats: {
          total: s?.total ?? 0,
          pending: s?.pending ?? 0,
          sent: s?.sent ?? 0,
          skipped: s?.skipped ?? 0,
          excluded: s?.excluded ?? 0,
          failed: s?.failed ?? 0,
        },
      };
    });
  const taskByTarget = new Map(taskViews.map((t) => [t.targetEpisodeId, t]));

  const series: SeriesView[] = allSeries
    .filter((s) => s.social_account_id === selected.id && !s.deleted_at)
    .map((s) => ({
      id: s.id,
      name: s.name,
      // 저장된 문구가 없으면 기본 문구를 보여준다(보낼 때도 기본 문구를 쓴다).
      templates: s.reply_templates.length > 0 ? s.reply_templates : DEFAULT_TEMPLATES,
      episodes: s.series_episodes.map((e) => ({
        id: e.id,
        episodeNo: e.episode_no,
        permalink: e.permalink,
        caption: e.caption,
        mediaType: e.media_type,
        postedAt: e.posted_at,
        fromMcb: e.content_id !== null,
        replyEnabled: e.reply_enabled,
        task: taskByTarget.get(e.id) ?? null,
      })),
    }));

  const dailyLimit =
    (settingsRows ?? []).find((r) => r.social_account_id === selected.id)?.daily_limit ??
    DEFAULT_ALERT_SETTINGS.dailyLimit;

  return (
    <EpisodeAlertsPage
      accounts={accounts}
      selectedAccountId={selected.id}
      canManage={canManage}
      dailyLimit={dailyLimit}
      series={series}
      history={taskViews.slice(0, HISTORY_LIMIT)}
    />
  );
}

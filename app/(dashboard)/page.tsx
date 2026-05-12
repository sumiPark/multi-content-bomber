import { redirect } from "next/navigation";
import { CaptionResult } from "@/components/ai/caption-result";
import {
  type AccountSummary,
  type DashboardData,
  type Platform,
  type PublishStatus,
  type UpcomingJob,
  DashboardHeader,
  FailureAlertBar,
  LinkedAccounts,
  QuickActions,
  StatTiles,
  UpcomingUploads,
} from "@/components/dashboard/dashboard-hub";
import { captionsSchema } from "@/lib/ai/caption-generator";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";

const THUMBNAIL_TTL_SECONDS = 3600;
const UPCOMING_LIMIT = 5;
const STATS_WINDOW_DAYS = 14; // ② 통계용 슬림 윈도우 — 이번 주/지난 주 비교 + 실패 카운트 커버

// 단건 보기 캡션 파싱 결과 타입.
type Captions = ReturnType<typeof captionsSchema.parse>;

interface DashboardPageProps {
  searchParams: Promise<{ content?: string }>;
}

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const { content: targetContentId } = await searchParams;

  const user = await getSessionUser();
  if (!user) redirect("/login");

  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");

  const supabase = await getServerSupabase();

  // ── 단건 보기 분기 (보관함/마법사/이력에서 /?content=<id>로 진입) ────────────
  if (targetContentId) {
    return renderContentDetail(supabase, targetContentId);
  }

  // ── 액션 허브 데이터 수집 ────────────────────────────────────────────────────
  const data = await loadDashboardData(supabase);

  return (
    <main className="container mx-auto max-w-6xl space-y-8 px-6 py-10">
      <DashboardHeader summary={buildHeaderSummary(data)} />
      <FailureAlertBar
        failedCount={data.failedCount}
        topFailureSummary={data.topFailureSummary}
      />
      <StatTiles data={data} />
      <UpcomingUploads items={data.upcoming} />
      <LinkedAccounts summaries={data.accounts} />
      <QuickActions />
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 단건 보기 (보존 — 기존 링크 라우팅 유지)

async function renderContentDetail(
  supabase: Awaited<ReturnType<typeof getServerSupabase>>,
  contentId: string,
) {
  const { data: latest } = await supabase
    .from("contents")
    .select("id, media_urls, ai_captions, updated_at")
    .eq("id", contentId)
    .maybeSingle();

  let savedContent: {
    id: string;
    captions: Captions;
    savedAt: string;
    thumbnails: string[];
  } | null = null;

  if (latest?.ai_captions) {
    const parsed = captionsSchema.safeParse(latest.ai_captions);
    if (parsed.success) {
      const { data: signed } = await supabase.storage
        .from("media")
        .createSignedUrls(latest.media_urls, THUMBNAIL_TTL_SECONDS);
      const thumbnails =
        signed?.map((s) => s.signedUrl).filter((u): u is string => Boolean(u)) ??
        [];
      savedContent = {
        id: latest.id,
        captions: parsed.data,
        savedAt: latest.updated_at,
        thumbnails,
      };
    }
  }

  return (
    <main className="container mx-auto max-w-5xl space-y-6 px-6 py-10">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">콘텐츠 보기</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          저장된 콘텐츠를 보거나 수정하세요.
        </p>
      </header>
      {savedContent ? (
        <CaptionResult
          key={savedContent.id}
          contentId={savedContent.id}
          captions={savedContent.captions}
          savedAt={savedContent.savedAt}
          thumbnails={savedContent.thumbnails}
        />
      ) : (
        <p className="text-muted-foreground">콘텐츠를 찾을 수 없습니다.</p>
      )}
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 데이터 로딩

interface JobRow {
  id: string;
  content_id: string;
  status: PublishStatus;
  scheduled_for: string | null;
  last_error: string | null;
  completed_at: string | null;
  created_at: string;
  contents: {
    media_type: "IMAGE" | "VIDEO";
    media_urls: string[];
    ai_captions: unknown;
    internal_title: string | null;
  } | null;
  social_accounts: {
    platform: Platform;
  } | null;
}

interface AccountRow {
  is_active: boolean;
  token_expires_at: string | null;
  platform: Platform;
}

async function loadDashboardData(
  supabase: Awaited<ReturnType<typeof getServerSupabase>>,
): Promise<DashboardData> {
  const since = new Date(
    Date.now() - STATS_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  // RLS가 publish_jobs/social_accounts에 org scope 적용.
  // 한 번의 조인 쿼리로 통계 + 업커밍 양쪽에 쓸 슬림 윈도우를 가져온다.
  // 0007/0008 컬럼은 타입 재생성 전이라 응답을 cast.
  const [{ data: jobRows }, { data: accountRows }] = await Promise.all([
    supabase
      .from("publish_jobs")
      .select(
        `
        id, content_id, status, scheduled_for, last_error, completed_at, created_at,
        contents!inner ( media_type, media_urls, ai_captions, internal_title ),
        social_accounts!inner ( platform )
        `,
      )
      .is("deleted_at", null)
      .gte("created_at", since)
      .order("created_at", { ascending: false }) as unknown as Promise<{
      data: JobRow[] | null;
    }>,

    supabase
      .from("social_accounts")
      .select("is_active, token_expires_at, platform") as unknown as Promise<{
      data: AccountRow[] | null;
    }>,
  ]);

  const jobs = jobRows ?? [];
  const accounts = accountRows ?? [];

  return {
    ...computeJobStats(jobs),
    accounts: computeAccountSummaries(accounts),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 통계 계산 — KST 기준 일/주 경계

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function startOfKstDay(d = new Date()): Date {
  const shifted = new Date(d.getTime() + KST_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - KST_OFFSET_MS);
}

function startOfKstWeek(d = new Date()): Date {
  // ISO week — 월요일 시작.
  const dayStart = startOfKstDay(d);
  const kst = new Date(dayStart.getTime() + KST_OFFSET_MS);
  const dow = kst.getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMon = (dow + 6) % 7;
  return new Date(dayStart.getTime() - daysSinceMon * 24 * 60 * 60 * 1000);
}

function computeJobStats(
  jobs: JobRow[],
): Omit<DashboardData, "accounts"> {
  const now = Date.now();
  const todayStart = startOfKstDay().getTime();
  const todayEnd = todayStart + 24 * 60 * 60 * 1000;
  const thisWeekStart = startOfKstWeek().getTime();
  const lastWeekStart = thisWeekStart - 7 * 24 * 60 * 60 * 1000;

  let todayScheduledCount = 0;
  let nextScheduledMs: number | null = null;

  let uploadingCount = 0;
  const uploadingLabels: string[] = [];

  let failedCount = 0;
  const failedJobs: JobRow[] = [];

  let thisWeekCompleted = 0;
  let lastWeekCompleted = 0;

  const upcomingPool: JobRow[] = [];

  for (const j of jobs) {
    const sched = j.scheduled_for ? new Date(j.scheduled_for).getTime() : null;

    // 오늘 예약: PENDING + 오늘 KST 범위 내.
    if (
      j.status === "PENDING" &&
      sched !== null &&
      sched >= todayStart &&
      sched < todayEnd
    ) {
      todayScheduledCount += 1;
    }

    // 다음 예약 시각 (PENDING + 미래).
    if (j.status === "PENDING" && sched !== null && sched > now) {
      if (nextScheduledMs === null || sched < nextScheduledMs) {
        nextScheduledMs = sched;
      }
    }

    // 진행중.
    if (j.status === "PROCESSING" || j.status === "RETRYING") {
      uploadingCount += 1;
      const label = labelForJob(j);
      if (label && uploadingLabels.length < 2) uploadingLabels.push(label);
    }

    // 실패.
    if (j.status === "FAILED") {
      failedCount += 1;
      failedJobs.push(j);
    }

    // 이번 주/지난 주 완료.
    if (j.status === "SUCCESS" && j.completed_at) {
      const completedMs = new Date(j.completed_at).getTime();
      if (completedMs >= thisWeekStart) thisWeekCompleted += 1;
      else if (completedMs >= lastWeekStart) lastWeekCompleted += 1;
    }

    // 업커밍 후보: 처리중 / 예약 / 대기 / 실패.
    if (
      j.status === "PENDING" ||
      j.status === "PROCESSING" ||
      j.status === "RETRYING" ||
      j.status === "FAILED"
    ) {
      upcomingPool.push(j);
    }
  }

  // 가장 가까운 시간순 정렬: scheduled_for(있으면) > created_at desc 보조.
  const upcoming = upcomingPool
    .slice()
    .sort((a, b) => {
      const aMs = a.scheduled_for
        ? new Date(a.scheduled_for).getTime()
        : Number.POSITIVE_INFINITY;
      const bMs = b.scheduled_for
        ? new Date(b.scheduled_for).getTime()
        : Number.POSITIVE_INFINITY;
      if (aMs !== bMs) return aMs - bMs;
      return (
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
    })
    .slice(0, UPCOMING_LIMIT)
    .map(toUpcomingJob);

  const topFailureSummary = failedJobs.length
    ? buildFailureSummary(failedJobs[0])
    : null;

  return {
    todayScheduledCount,
    nextScheduledAtIso: nextScheduledMs
      ? new Date(nextScheduledMs).toISOString()
      : null,
    uploadingCount,
    uploadingHint:
      uploadingLabels.length > 0
        ? uploadingLabels.join(", ")
        : null,
    failedCount,
    topFailureSummary,
    thisWeekCompleted,
    weekDelta: thisWeekCompleted - lastWeekCompleted,
    upcoming,
  };
}

function toUpcomingJob(j: JobRow): UpcomingJob {
  return {
    id: j.id,
    contentId: j.content_id,
    status: j.status,
    scheduledFor: j.scheduled_for,
    lastError: j.last_error,
    contentLabel: labelForJob(j) ?? "(제목 없음)",
    mediaType: j.contents?.media_type ?? "IMAGE",
    mediaCount: j.contents?.media_urls?.length ?? 0,
    platform: j.social_accounts?.platform ?? "YOUTUBE",
  };
}

function labelForJob(j: JobRow): string | null {
  const internal = j.contents?.internal_title?.trim();
  if (internal) return internal;
  const parsed = captionsSchema.safeParse(j.contents?.ai_captions);
  if (!parsed.success) return null;
  const text =
    parsed.data.youtube?.title ??
    parsed.data.instagram?.caption ??
    parsed.data.tiktok?.caption ??
    null;
  if (!text) return null;
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

function buildFailureSummary(j: JobRow): string {
  const label = labelForJob(j) ?? "콘텐츠";
  const platform = j.social_accounts?.platform ?? "";
  const reason = j.last_error?.slice(0, 60) ?? "원인 미상";
  return platform
    ? `${label} ${platform} 업로드 실패 — ${reason}`
    : `${label} 업로드 실패 — ${reason}`;
}

function computeAccountSummaries(accounts: AccountRow[]): AccountSummary[] {
  const now = Date.now();
  const map = new Map<Platform, AccountSummary>();

  for (const a of accounts) {
    const entry =
      map.get(a.platform) ??
      ({ platform: a.platform, total: 0, active: 0, expired: 0 } as AccountSummary);
    entry.total += 1;
    const isExpired =
      a.token_expires_at !== null &&
      new Date(a.token_expires_at).getTime() <= now;
    if (isExpired) entry.expired += 1;
    else if (a.is_active) entry.active += 1;
    map.set(a.platform, entry);
  }

  return Array.from(map.values());
}

// ─────────────────────────────────────────────────────────────────────────────
// 헤더 서브텍스트

function buildHeaderSummary(data: DashboardData): string {
  const parts: string[] = [];
  if (data.todayScheduledCount > 0) {
    parts.push(`오늘 예약 ${data.todayScheduledCount}건`);
  }
  if (data.uploadingCount > 0) {
    parts.push(`진행중 ${data.uploadingCount}건`);
  }
  if (data.failedCount > 0) {
    parts.push(`실패 ${data.failedCount}건`);
  }
  if (parts.length === 0) {
    return "오늘은 예약된 업로드가 없어요. 새 콘텐츠를 만들어 일정을 시작해보세요.";
  }
  return parts.join(" · ");
}

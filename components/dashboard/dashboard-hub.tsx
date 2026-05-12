import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  History,
  Link2,
  ListChecks,
  PlusCircle,
  Sparkles,
  Upload,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PlatformIcon } from "@/components/ui/platform-icon";
import { RelativeTime } from "@/components/ui/relative-time";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Types

export type Platform = "YOUTUBE" | "INSTAGRAM" | "TIKTOK";
export type PublishStatus =
  | "PENDING"
  | "PROCESSING"
  | "SUCCESS"
  | "FAILED"
  | "RETRYING"
  | "CANCELLED";

export interface UpcomingJob {
  id: string;
  contentId: string;
  status: PublishStatus;
  scheduledFor: string | null;
  lastError: string | null;
  contentLabel: string;
  mediaType: "IMAGE" | "VIDEO";
  mediaCount: number;
  platform: Platform;
}

export interface AccountSummary {
  platform: Platform;
  total: number;
  active: number;
  expired: number;
}

export interface DashboardData {
  todayScheduledCount: number;
  nextScheduledAtIso: string | null;
  uploadingCount: number;
  uploadingHint: string | null;
  failedCount: number;
  topFailureSummary: string | null;
  thisWeekCompleted: number;
  weekDelta: number;
  upcoming: UpcomingJob[];
  accounts: AccountSummary[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Header

export function DashboardHeader({ summary }: { summary: string }) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">대시보드</h1>
        <p className="mt-1 text-sm text-muted-foreground">{summary}</p>
      </div>
      <div className="flex items-center gap-2">
        <Link
          href="/postings"
          className={buttonVariants({ variant: "outline" })}
        >
          <ListChecks className="size-4" /> 포스팅 관리
        </Link>
        <Link href="/upload" className={buttonVariants({ variant: "default" })}>
          <PlusCircle className="size-4" /> 새 콘텐츠
        </Link>
      </div>
    </header>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ② Failure alert bar

export function FailureAlertBar({
  failedCount,
  topFailureSummary,
}: {
  failedCount: number;
  topFailureSummary: string | null;
}) {
  if (failedCount === 0) return null;

  const message =
    failedCount === 1 && topFailureSummary
      ? topFailureSummary
      : `${failedCount}건 실패 — 포스팅 관리에서 확인`;

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3 text-sm text-destructive">
        <AlertTriangle className="size-4 shrink-0" />
        <span className="line-clamp-1">{message}</span>
      </div>
      <Link
        href="/postings?status=failed"
        className="flex shrink-0 items-center gap-1 text-sm font-medium text-destructive hover:underline"
      >
        재시도
        <ArrowRight className="size-3.5" />
      </Link>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ③ Stat tiles (4-col grid)

function formatKstClock(iso: string): string {
  // 사이드 효과 없이 KST 기준 HH:MM 포맷. 서버 타임존 의존 없이 +09:00 오프셋 적용.
  const d = new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function StatTiles({ data }: { data: DashboardData }) {
  const tiles: StatTileProps[] = [
    {
      label: "오늘 예약",
      value: data.todayScheduledCount,
      hint: data.nextScheduledAtIso
        ? `다음 ${formatKstClock(data.nextScheduledAtIso)}`
        : "예약 없음",
      href: "/postings?status=scheduled",
      icon: CalendarClock,
    },
    {
      label: "진행중",
      value: data.uploadingCount,
      hint: data.uploadingHint ?? "대기 없음",
      href: "/postings?status=uploading",
      icon: Upload,
    },
    {
      label: "실패",
      value: data.failedCount,
      hint: data.failedCount > 0 ? "즉시 확인 필요" : "이상 없음",
      href: "/postings?status=failed",
      icon: XCircle,
      destructive: data.failedCount > 0,
    },
    {
      label: "이번 주 완료",
      value: data.thisWeekCompleted,
      hint: formatWeekDelta(data.weekDelta),
      hintTone: data.weekDelta > 0 ? "positive" : data.weekDelta < 0 ? "negative" : "muted",
      href: "/postings?status=completed",
      icon: CheckCircle2,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {tiles.map((tile) => (
        <StatTile key={tile.label} {...tile} />
      ))}
    </div>
  );
}

function formatWeekDelta(delta: number): string {
  if (delta === 0) return "지난주와 동일";
  const sign = delta > 0 ? "+" : "";
  return `지난주 대비 ${sign}${delta}`;
}

interface StatTileProps {
  label: string;
  value: number;
  hint: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  destructive?: boolean;
  hintTone?: "positive" | "negative" | "muted";
}

function StatTile({
  label,
  value,
  hint,
  href,
  icon: Icon,
  destructive,
  hintTone = "muted",
}: StatTileProps) {
  const hintClass =
    destructive
      ? "text-destructive"
      : hintTone === "positive"
        ? "text-emerald-600 dark:text-emerald-400"
        : hintTone === "negative"
          ? "text-destructive"
          : "text-muted-foreground";

  return (
    <Link
      href={href}
      className={cn(
        "group/tile block rounded-xl bg-card p-4 ring-1 transition hover:bg-accent/40",
        destructive
          ? "ring-destructive/30 hover:ring-destructive/50"
          : "ring-foreground/10 hover:ring-foreground/20",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {label}
        </span>
        <Icon
          className={cn(
            "size-4 transition group-hover/tile:scale-110",
            destructive ? "text-destructive" : "text-muted-foreground",
          )}
        />
      </div>
      <p
        className={cn(
          "mt-2 text-3xl font-bold tracking-tight tabular-nums",
          destructive && "text-destructive",
        )}
      >
        {value}
      </p>
      <p className={cn("mt-1 text-xs", hintClass)}>{hint}</p>
    </Link>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ④ Upcoming uploads

const STATUS_BADGE: Record<
  "scheduled" | "uploading" | "failed" | "pending",
  { label: string; className: string }
> = {
  scheduled: { label: "예약중", className: "bg-amber-100 text-amber-800 border-amber-300" },
  uploading: { label: "업로드중", className: "bg-blue-100 text-blue-800 border-blue-300" },
  failed: { label: "실패", className: "bg-red-100 text-red-800 border-red-300" },
  pending: { label: "대기", className: "bg-zinc-100 text-zinc-700 border-zinc-300" },
};

function deriveDisplayStatus(
  status: PublishStatus,
  scheduledFor: string | null,
): keyof typeof STATUS_BADGE {
  if (status === "FAILED") return "failed";
  if (status === "PROCESSING" || status === "RETRYING") return "uploading";
  if (scheduledFor && new Date(scheduledFor).getTime() > Date.now())
    return "scheduled";
  return "pending";
}

export function UpcomingUploads({ items }: { items: UpcomingJob[] }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">예정된 업로드</h2>
        <Link
          href="/postings"
          className="flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground"
        >
          전체 보기
          <ArrowRight className="size-3" />
        </Link>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <CalendarClock className="size-6 text-muted-foreground/60" />
            <p>예정된 업로드가 없어요.</p>
            <Link
              href="/upload"
              className="text-foreground underline-offset-4 hover:underline"
            >
              첫 콘텐츠 만들기 →
            </Link>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2">
          {items.map((job) => (
            <UpcomingRow key={job.id} job={job} />
          ))}
        </ul>
      )}
    </section>
  );
}

function UpcomingRow({ job }: { job: UpcomingJob }) {
  const display = deriveDisplayStatus(job.status, job.scheduledFor);
  const isFailed = display === "failed";
  const badge = STATUS_BADGE[display];

  return (
    <li>
      <Link
        href={`/?content=${job.contentId}`}
        className={cn(
          "flex items-center gap-3 rounded-lg border bg-card p-3 transition hover:bg-accent/40",
          isFailed && "border-destructive/40 bg-destructive/5",
        )}
      >
        <div
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground",
            isFailed && "border-destructive/30 text-destructive",
          )}
          aria-hidden
        >
          {job.mediaType === "VIDEO" ? (
            <span className="text-[10px] font-semibold">VIDEO</span>
          ) : (
            <span className="text-[10px] font-semibold">
              IMG{job.mediaCount > 1 ? `×${job.mediaCount}` : ""}
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="line-clamp-1 text-sm font-medium">
              {job.contentLabel}
            </p>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            {job.scheduledFor ? (
              <RelativeTime iso={job.scheduledFor} />
            ) : (
              <span>예약 없음</span>
            )}
            <span aria-hidden>·</span>
            <PlatformIcon platform={job.platform} size={14} />
          </div>
          {isFailed && job.lastError && (
            <p className="mt-1 line-clamp-1 text-xs text-destructive">
              {job.lastError}
            </p>
          )}
        </div>

        <Badge
          variant="outline"
          className={cn("font-medium", badge.className)}
        >
          {badge.label}
        </Badge>
      </Link>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ Linked accounts (per platform)

const PLATFORM_LABEL: Record<Platform, string> = {
  YOUTUBE: "YouTube",
  INSTAGRAM: "Instagram",
  TIKTOK: "TikTok",
};

const PLATFORM_BG: Record<Platform, string> = {
  YOUTUBE: "bg-red-50 dark:bg-red-950/40",
  INSTAGRAM: "bg-fuchsia-50 dark:bg-fuchsia-950/40",
  TIKTOK: "bg-zinc-100 dark:bg-zinc-900/60",
};

const ALL_PLATFORMS: Platform[] = ["YOUTUBE", "INSTAGRAM", "TIKTOK"];

export function LinkedAccounts({ summaries }: { summaries: AccountSummary[] }) {
  const byPlatform = new Map(summaries.map((s) => [s.platform, s]));
  // 빈 플랫폼도 카드로 표시 (기획 §7.2-⑤)
  const all = ALL_PLATFORMS.map(
    (p): AccountSummary =>
      byPlatform.get(p) ?? { platform: p, total: 0, active: 0, expired: 0 },
  );

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">연동 계정</h2>
        <Link
          href="/accounts"
          className="flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground"
        >
          관리
          <ArrowRight className="size-3" />
        </Link>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {all.map((s) => (
          <AccountCard key={s.platform} summary={s} />
        ))}
      </div>
    </section>
  );
}

function AccountCard({ summary }: { summary: AccountSummary }) {
  const hasExpired = summary.expired > 0;
  const isEmpty = summary.total === 0;

  return (
    <Link
      href={`/accounts?platform=${summary.platform.toLowerCase()}`}
      className={cn(
        "group block rounded-xl bg-card p-4 ring-1 transition hover:bg-accent/40",
        hasExpired
          ? "ring-destructive/40 hover:ring-destructive/60"
          : "ring-foreground/10 hover:ring-foreground/20",
      )}
    >
      <div className="flex items-start justify-between">
        <div
          className={cn(
            "flex size-10 items-center justify-center rounded-lg",
            PLATFORM_BG[summary.platform],
          )}
        >
          <PlatformIcon platform={summary.platform} size={22} />
        </div>
        <ArrowRight className="size-4 text-muted-foreground/50 transition group-hover:translate-x-0.5 group-hover:text-foreground" />
      </div>
      <p className="mt-3 text-sm font-medium">
        {PLATFORM_LABEL[summary.platform]}
      </p>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-2xl font-bold tabular-nums">{summary.total}</span>
        <span className="text-xs text-muted-foreground">계정</span>
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-xs">
        {isEmpty ? (
          <span className="text-muted-foreground">연동하기 →</span>
        ) : hasExpired ? (
          <>
            <span className="size-1.5 rounded-full bg-destructive" />
            <span className="text-destructive">
              {summary.expired}개 토큰 만료
            </span>
          </>
        ) : (
          <>
            <span className="size-1.5 rounded-full bg-emerald-500" />
            <span className="text-muted-foreground">
              {summary.active}개 활성
            </span>
          </>
        )}
      </div>
    </Link>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ Quick actions

const QUICK_ACTIONS = [
  { href: "/presets", label: "캡션 프리셋", icon: Sparkles },
  { href: "/accounts", label: "계정 추가", icon: Link2 },
  { href: "/uploads", label: "업로드 이력", icon: History },
] as const;

export function QuickActions() {
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">빠른 작업</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {QUICK_ACTIONS.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="group flex items-center gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10 transition hover:bg-accent/40 hover:ring-foreground/20"
          >
            <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground transition group-hover:bg-foreground/10 group-hover:text-foreground">
              <Icon className="size-4" />
            </div>
            <span className="text-sm font-medium">{label}</span>
            <ArrowRight className="ml-auto size-4 text-muted-foreground/40 transition group-hover:translate-x-0.5 group-hover:text-foreground" />
          </Link>
        ))}
      </div>
    </section>
  );
}


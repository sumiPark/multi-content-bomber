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
import { buttonVariants } from "@/components/ui/button";
import { PlatformIcon } from "@/components/ui/platform-icon";
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
  accounts: AccountSummary[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Header

export function DashboardHeader({ summary }: { summary: string }) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-xl font-bold tracking-[-0.01em]">대시보드</h1>
        <p className="mt-1 text-sm text-muted-foreground">{summary}</p>
      </div>
      <div className="flex items-center gap-2">
        <Link
          href="/postings"
          className={buttonVariants({ variant: "outline" })}
        >
          <ListChecks className="size-4" /> 배포 관리
        </Link>
        <Link href="/upload" className={buttonVariants({ variant: "default" })}>
          <PlusCircle className="size-4" /> 콘텐츠 생성
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
      : `발행 실패 ${failedCount}건 — 배포 관리에서 확인해 주세요`;

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
        보기
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
      label: "올리는 중",
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
        ? "text-ok"
        : hintTone === "negative"
          ? "text-destructive"
          : "text-muted-foreground";

  return (
    <Link
      href={href}
      className={cn(
        "group/tile block rounded-lg border bg-card p-4 transition hover:bg-surface-2",
        destructive && "border-risk/40",
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
          "mt-1 text-2xl font-bold tabular-nums",
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
// ⑤ Linked accounts (per platform)

const PLATFORM_LABEL: Record<Platform, string> = {
  YOUTUBE: "유튜브",
  INSTAGRAM: "인스타그램",
  TIKTOK: "틱톡",
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
      href="/accounts"
      className={cn("group block rounded-lg border bg-card p-4 transition hover:bg-surface-2", hasExpired && "border-risk/40")}
    >
      <div className="flex items-start justify-between">
        <div className="flex size-10 items-center justify-center rounded-lg bg-surface-2">
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
            <span className="size-1.5 rounded-full bg-risk" />
            <span className="text-risk">{summary.expired}개 다시 연결 필요</span>
          </>
        ) : (
          <>
            <span className="size-1.5 rounded-full bg-ok" />
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
  { href: "/presets", label: "AI 프리셋", icon: Sparkles },
  { href: "/accounts", label: "계정 연동", icon: Link2 },
  { href: "/postings", label: "배포 관리", icon: History },
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
            className="group flex items-center gap-3 rounded-lg border bg-card p-4 transition hover:bg-surface-2"
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


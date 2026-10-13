"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CircleAlert } from "lucide-react";
import { saveDailyLimitAction } from "@/app/(dashboard)/episode-alerts/actions";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PlatformIcon } from "@/components/ui/platform-icon";
import { cn } from "@/lib/utils";
import { AlertHistory, type TaskView } from "./alert-history";
import { SeriesSection, type SeriesView } from "./series-section";

export type { TaskView } from "./alert-history";
export type { EpisodeView, SeriesView } from "./series-section";

export interface AlertAccountView {
  id: string;
  name: string | null;
  avatarUrl: string | null;
  isActive: boolean;
  // 계정 목록에 보여줄 요약.
  seriesCount: number;
  replyOnCount: number;
}

// 답글은 GitHub Actions 워커가 보내서 화면이 저절로 바뀌지 않는다. 보내는 중인 회차가
// 있으면 이 간격으로 새로고침해 진행 상황을 보여준다.
const LIVE_REFRESH_MS = 15_000;

const HOW_IT_WORKS = [
  "켜는 즉시 보내기 시작",
  "7일 동안 새 댓글도 5분마다 확인",
  "7일 지나면 자동으로 꺼짐",
  "새 회차는 꺼진 상태로 추가",
];

export function EpisodeAlertsPage({
  accounts,
  selectedAccountId,
  canManage,
  dailyLimit,
  series,
  history,
}: {
  accounts: AlertAccountView[];
  selectedAccountId: string | null;
  canManage: boolean;
  dailyLimit: number;
  series: SeriesView[];
  history: TaskView[];
}) {
  const router = useRouter();
  const selected = accounts.find((a) => a.id === selectedAccountId) ?? null;
  const live = series.some((s) =>
    s.episodes.some(
      (e) =>
        e.replyEnabled &&
        (e.task === null ||
          e.task.status === "COLLECTING" ||
          (e.task.status === "SENDING" && !e.task.deferred)),
    ),
  );

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => router.refresh(), LIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [live, router]);

  return (
    <main className="container mx-auto max-w-6xl space-y-8 px-6 py-10">
      <header className="space-y-3">
        <h1 className="text-3xl font-bold tracking-tight">시리즈 댓글 자동화</h1>
        <p className="text-sm text-muted-foreground">
          회차의 답글을 켜면, 이전 화에 댓글 단 사람들에게 시리즈 문구로 대댓글을 달아요.
        </p>
        <ul className="flex flex-wrap gap-2">
          {HOW_IT_WORKS.map((text) => (
            <li key={text} className="rounded-full border bg-background px-3 py-1 text-xs text-muted-foreground">
              {text}
            </li>
          ))}
        </ul>
      </header>

      {accounts.length === 0 || !selected ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-3 py-8">
            <p className="font-medium">연결된 인스타그램 계정이 없어요</p>
            <p className="text-sm text-muted-foreground">
              시리즈 댓글 자동화는 인스타그램 비즈니스·크리에이터 계정에서 쓸 수 있어요.
            </p>
            <Link href="/accounts" className={buttonVariants({ size: "sm" })}>
              계정 연동으로
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-8 md:grid-cols-[15rem_minmax(0,1fr)]">
          <AccountNav accounts={accounts} selectedId={selected.id} />

          <div className="min-w-0 space-y-8">
            <AccountHeader
              // 계정을 바꾸면 입력 중이던 값을 버리고 그 계정 값으로 다시 시작한다.
              key={selected.id}
              account={selected}
              dailyLimit={dailyLimit}
              canManage={canManage}
            />

            {!selected.isActive && (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
                <CircleAlert className="size-4 shrink-0" />
                <p className="min-w-0 flex-1">
                  이 계정은 토큰이 만료돼 답글을 보낼 수 없어요. 다시 연결하면 이어서 쓸 수 있어요.
                </p>
                <Link href="/accounts" className={buttonVariants({ size: "sm", variant: "outline" })}>
                  계정 연동으로
                </Link>
              </div>
            )}

            <SeriesSection
              accountId={selected.id}
              accountName={selected.name}
              accountActive={selected.isActive}
              series={series}
              canManage={canManage}
            />
            <AlertHistory history={history} canManage={canManage} />
          </div>
        </div>
      )}
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 계정 고르기 — 넓은 화면은 왼쪽 목록, 좁은 화면은 드롭다운
// ─────────────────────────────────────────────────────────────────────────────

function accountSummary(a: AlertAccountView): string {
  if (!a.isActive) return "재연결 필요";
  if (a.seriesCount === 0) return "시리즈 없음";
  return a.replyOnCount > 0
    ? `시리즈 ${a.seriesCount}개 · 답글 켜짐 ${a.replyOnCount}`
    : `시리즈 ${a.seriesCount}개`;
}

function AccountNav({
  accounts,
  selectedId,
}: {
  accounts: AlertAccountView[];
  selectedId: string;
}) {
  const router = useRouter();
  const active = accounts.filter((a) => a.isActive);
  const inactive = accounts.filter((a) => !a.isActive);
  const selectedInactive = inactive.some((a) => a.id === selectedId);

  return (
    <>
      {/* 좁은 화면 — 드롭다운 */}
      <div className="space-y-1.5 md:hidden">
        <label htmlFor="account-select" className="text-xs font-medium text-muted-foreground">
          인스타그램 계정
        </label>
        <select
          id="account-select"
          value={selectedId}
          onChange={(e) => router.push(`/episode-alerts?account=${e.target.value}`, { scroll: false })}
          className="w-full rounded-lg border bg-background px-3 py-2.5 text-sm"
        >
          {active.map((a) => (
            <option key={a.id} value={a.id}>
              @{a.name ?? "(이름 없음)"} — {accountSummary(a)}
            </option>
          ))}
          {inactive.length > 0 && (
            <optgroup label="재연결 필요">
              {inactive.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.name ?? "(이름 없음)"}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>

      {/* 넓은 화면 — 왼쪽 목록 */}
      <nav aria-label="인스타그램 계정" className="hidden md:block">
        <div className="sticky top-6 space-y-5">
          <div className="space-y-1">
            <p className="px-3 pb-1 text-xs font-medium text-muted-foreground">
              인스타그램 계정 {active.length}
            </p>
            <ul className="space-y-1">
              {active.map((a) => (
                <li key={a.id}>
                  <AccountItem account={a} selected={a.id === selectedId} />
                </li>
              ))}
            </ul>
          </div>

          {inactive.length > 0 && (
            <details open={selectedInactive} className="group">
              <summary className="cursor-pointer list-none px-3 text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                재연결 필요 {inactive.length}
                <span className="ml-1 inline-block transition group-open:rotate-90">›</span>
              </summary>
              <ul className="mt-2 space-y-1">
                {inactive.map((a) => (
                  <li key={a.id}>
                    <AccountItem account={a} selected={a.id === selectedId} />
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </nav>
    </>
  );
}

function AccountAvatar({ account, size }: { account: AlertAccountView; size: number }) {
  return account.avatarUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={account.avatarUrl}
      alt=""
      style={{ width: size, height: size }}
      className="shrink-0 rounded-full object-cover"
    />
  ) : (
    <span
      style={{ width: size, height: size }}
      className="grid shrink-0 place-items-center rounded-full bg-muted"
    >
      <PlatformIcon platform="INSTAGRAM" size={Math.round(size * 0.6)} />
    </span>
  );
}

function AccountItem({ account, selected }: { account: AlertAccountView; selected: boolean }) {
  return (
    <Link
      href={`/episode-alerts?account=${account.id}`}
      scroll={false}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2.5 transition",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "bg-primary/10 ring-1 ring-primary/30" : "hover:bg-accent/50",
        !account.isActive && !selected && "opacity-60",
      )}
    >
      <AccountAvatar account={account} size={32} />
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-sm", selected ? "font-semibold" : "font-medium")}>
          @{account.name ?? "(이름 없음)"}
        </span>
        <span
          className={cn(
            "block truncate text-xs",
            account.isActive ? "text-muted-foreground" : "text-destructive",
          )}
        >
          {accountSummary(account)}
        </span>
      </span>
      {account.isActive && account.replyOnCount > 0 && (
        <span className="size-2 shrink-0 rounded-full bg-emerald-500" aria-label="답글 켜진 회차 있음" />
      )}
    </Link>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 고른 계정 머리 — 이름, 요약, 하루 최대 답글 수
// ─────────────────────────────────────────────────────────────────────────────

function AccountHeader({
  account,
  dailyLimit,
  canManage,
}: {
  account: AlertAccountView;
  dailyLimit: number;
  canManage: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(dailyLimit));
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const n = Number(value);
  const invalid = !Number.isInteger(n) || n < 1 || n > 1000;

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await saveDailyLimitAction({ accountId: account.id, dailyLimit: n });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditing(false);
    });
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card px-5 py-4">
      <div className="flex min-w-0 items-center gap-3">
        <AccountAvatar account={account} size={44} />
        <div className="min-w-0">
          <h2 className="truncate text-xl font-semibold">@{account.name ?? "(이름 없음)"}</h2>
          <p className="text-sm text-muted-foreground">{accountSummary(account)}</p>
        </div>
      </div>

      <div className="space-y-1 text-sm">
        {editing ? (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!invalid) save();
            }}
          >
            <label htmlFor={`daily-limit-${account.id}`} className="text-muted-foreground">
              하루 최대
            </label>
            <input
              id={`daily-limit-${account.id}`}
              type="number"
              inputMode="numeric"
              min={1}
              max={1000}
              value={value}
              autoFocus
              disabled={isPending}
              onChange={(e) => setValue(e.target.value)}
              className="w-20 rounded-md border bg-background px-2 py-1 tabular-nums"
            />
            <span className="text-muted-foreground">개</span>
            <Button type="submit" size="xs" disabled={isPending || invalid}>
              저장
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={isPending}
              onClick={() => {
                setEditing(false);
                setValue(String(dailyLimit));
                setError(null);
              }}
            >
              취소
            </Button>
          </form>
        ) : (
          <p className="flex items-center gap-1.5">
            <span className="text-muted-foreground">하루 최대 답글</span>
            <span className="font-semibold tabular-nums">{dailyLimit}개</span>
            {canManage && (
              <Button variant="ghost" size="xs" onClick={() => setEditing(true)}>
                변경
              </Button>
            )}
          </p>
        )}
        {editing && invalid && <p className="text-xs text-destructive">1~1000 사이로 정해주세요.</p>}
        {error && <p className="text-xs text-destructive">{error}</p>}
        {!editing && (
          <p className="text-xs text-muted-foreground">넘치면 다음 날 이어서 보내요 · 10~20초 간격</p>
        )}
      </div>
    </div>
  );
}

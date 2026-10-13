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
}

// 답글은 GitHub Actions 워커가 보내서 화면이 저절로 바뀌지 않는다. 보내는 중인 회차가
// 있으면 이 간격으로 새로고침해 진행 상황을 보여준다.
const LIVE_REFRESH_MS = 15_000;

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
    <main className="container mx-auto max-w-4xl space-y-6 px-6 py-10">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">시리즈 댓글 자동화</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          회차의 답글을 켜면, 이전 화에 댓글 단 사람들에게 시리즈 문구로 바로 대댓글을 달아요.
          켜져 있는 7일 동안은 새로 달린 댓글도 5분마다 확인해서 이어서 달아요. 새로 추가한 회차는
          꺼진 상태로 시작해요.
        </p>
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
        <>
          <AccountSwitcher accounts={accounts} selectedId={selected.id} />

          {!selected.isActive && (
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              <CircleAlert className="size-4 shrink-0" />
              <p className="min-w-0 flex-1">
                이 계정은 토큰이 만료돼 답글을 보낼 수 없어요. 다시 연결하면 이어서 쓸 수 있어요.
              </p>
              <Link href="/accounts" className={buttonVariants({ size: "sm", variant: "outline" })}>
                계정 연동으로
              </Link>
            </div>
          )}

          <DailyLimitBar
            // 계정을 바꾸면 입력 중이던 값을 버리고 그 계정 값으로 다시 시작한다.
            key={selected.id}
            accountId={selected.id}
            dailyLimit={dailyLimit}
            canManage={canManage}
          />

          <SeriesSection
            accountId={selected.id}
            accountName={selected.name}
            accountActive={selected.isActive}
            series={series}
            canManage={canManage}
          />
          <AlertHistory history={history} canManage={canManage} />
        </>
      )}
    </main>
  );
}

function AccountSwitcher({
  accounts,
  selectedId,
}: {
  accounts: AlertAccountView[];
  selectedId: string;
}) {
  return (
    <nav aria-label="인스타그램 계정" className="flex flex-wrap gap-2">
      {accounts.map((a) => {
        const active = a.id === selectedId;
        return (
          <Link
            key={a.id}
            href={`/episode-alerts?account=${a.id}`}
            scroll={false}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "border-foreground bg-foreground text-background"
                : "bg-background hover:bg-accent/40",
            )}
          >
            {a.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={a.avatarUrl} alt="" className="size-5 rounded-full object-cover" />
            ) : (
              <PlatformIcon platform="INSTAGRAM" size={16} />
            )}
            <span className="max-w-40 truncate">@{a.name ?? "(이름 없음)"}</span>
            {!a.isActive && (
              <span className={cn("text-[10px]", active ? "text-background/70" : "text-destructive")}>
                재연결 필요
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

// 계정 설정은 하루 최대 답글 수 하나뿐이라 카드 대신 한 줄로.
function DailyLimitBar({
  accountId,
  dailyLimit,
  canManage,
}: {
  accountId: string;
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
      const result = await saveDailyLimitAction({ accountId, dailyLimit: n });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditing(false);
    });
  }

  return (
    <div className="space-y-1 rounded-md border bg-muted/30 px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 text-muted-foreground">
          답글은 10~20초 간격으로 하나씩 달고, 넘치는 만큼은 다음 날 이어서 보내요.
        </p>
        {editing ? (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!invalid) save();
            }}
          >
            <label htmlFor={`daily-limit-${accountId}`} className="text-xs text-muted-foreground">
              하루 최대
            </label>
            <input
              id={`daily-limit-${accountId}`}
              type="number"
              inputMode="numeric"
              min={1}
              max={1000}
              value={value}
              autoFocus
              disabled={isPending}
              onChange={(e) => setValue(e.target.value)}
              className="w-20 rounded-md border bg-background px-2 py-1 text-sm tabular-nums"
            />
            <span className="text-xs text-muted-foreground">개</span>
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
          <p className="flex items-center gap-2">
            <span>
              하루 최대 <span className="font-semibold tabular-nums">{dailyLimit}</span>개
            </span>
            {canManage && (
              <Button variant="ghost" size="xs" onClick={() => setEditing(true)}>
                변경
              </Button>
            )}
          </p>
        )}
      </div>
      {editing && invalid && <p className="text-xs text-destructive">1~1000 사이로 정해주세요.</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

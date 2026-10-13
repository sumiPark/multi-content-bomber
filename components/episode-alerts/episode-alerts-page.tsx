"use client";

import Link from "next/link";
import { CircleAlert } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PlatformIcon } from "@/components/ui/platform-icon";
import { cn } from "@/lib/utils";
import { AlertHistory, type TaskView } from "./alert-history";
import { AlertSettingsCard, type AlertSettingsView } from "./alert-settings-card";
import { ApprovalCard, type ApprovalView } from "./approval-card";
import { SeriesSection, type SeriesView } from "./series-section";

export type { AlertSettingsView } from "./alert-settings-card";
export type { ApprovalView, CandidateView } from "./approval-card";
export type { TaskView } from "./alert-history";
export type { EpisodeView, SeriesView } from "./series-section";

export interface AlertAccountView {
  id: string;
  name: string | null;
  avatarUrl: string | null;
  isActive: boolean;
  // 확인 대기 중인 알림 수.
  waitingCount: number;
}

export function EpisodeAlertsPage({
  accounts,
  selectedAccountId,
  canManage,
  settings,
  series,
  approvals,
  history,
}: {
  accounts: AlertAccountView[];
  selectedAccountId: string | null;
  canManage: boolean;
  settings: AlertSettingsView | null;
  series: SeriesView[];
  approvals: ApprovalView[];
  history: TaskView[];
}) {
  const selected = accounts.find((a) => a.id === selectedAccountId) ?? null;
  const tasksById = new Map(history.map((t) => [t.id, t]));

  return (
    <main className="container mx-auto max-w-6xl space-y-6 px-6 py-10">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">다음 화 알림</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          시리즈 다음 화가 인스타에 올라가면, 이전 화에 댓글 단 사람들에게 “N화 올라왔어요” 대댓글을
          달아드려요.
        </p>
      </header>

      {accounts.length === 0 || !selected || !settings ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-3 py-8">
            <p className="font-medium">연결된 인스타그램 계정이 없어요</p>
            <p className="text-sm text-muted-foreground">
              다음 화 알림은 인스타그램 비즈니스·크리에이터 계정에서 쓸 수 있어요.
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
                이 계정은 토큰이 만료돼 알림을 보낼 수 없어요. 다시 연결하면 이어서 쓸 수 있어요.
              </p>
              <Link href="/accounts" className={buttonVariants({ size: "sm", variant: "outline" })}>
                계정 연동으로
              </Link>
            </div>
          )}

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="min-w-0 space-y-8">
              {approvals.map((a) => (
                <ApprovalCard
                  key={a.task.id}
                  approval={a}
                  templates={settings.templates}
                  dailyLimit={settings.dailyLimit}
                  canManage={canManage}
                />
              ))}
              <SeriesSection
                accountId={selected.id}
                accountName={selected.name}
                accountActive={selected.isActive}
                series={series}
                tasksById={tasksById}
                mode={settings.mode}
                canManage={canManage}
              />
              <AlertHistory history={history} canManage={canManage} />
            </div>
            <aside className="min-w-0">
              <AlertSettingsCard
                // 계정을 바꾸면 편집 중이던 값을 버리고 새 계정 설정으로 다시 시작한다.
                key={selected.id}
                accountId={selected.id}
                accountName={selected.name}
                settings={settings}
                canManage={canManage}
                sampleSeriesName={series[0]?.name ?? null}
              />
            </aside>
          </div>
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
            {a.waitingCount > 0 && (
              <span
                className="inline-flex min-w-5 items-center justify-center rounded-full bg-amber-500 px-1.5 text-[10px] font-semibold leading-4 text-white"
                aria-label={`확인 대기 ${a.waitingCount}건`}
              >
                {a.waitingCount}
              </span>
            )}
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

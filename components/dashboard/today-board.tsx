import Link from "next/link";
import { CalendarRange, CheckCircle2, OctagonAlert, TriangleAlert } from "lucide-react";
import { TrackBadge } from "@/components/schedule/slot-rule-cell";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { CellTask, CellTone } from "@/lib/schedule/cell-status";
import type { DayBoard, YesterdayLine } from "@/lib/schedule/day-board";
import { cn } from "@/lib/utils";

// 대시보드 "오늘 할 일"(5-2, 시안 7): 멈춘 칸 → 할 일 칸 → 하루 발행 칸 판 → 어제 성과 한 줄.
// 칸 상태 · 링크는 편성표와 같은 계산(lib/schedule/cell-status.ts)이다.

const TONE_CLASS: Record<CellTone, string> = {
  todo: "bg-brand-soft text-primary",
  wait: "bg-surface-2 text-ink-2",
  ok: "bg-ok-soft text-ok",
  risk: "bg-risk-soft text-risk",
  idle: "text-faint",
};

const TASKS: { key: CellTask; label: string; due: string }[] = [
  { key: "confirm", label: "상품 확인", due: "올리는 날 07시까지" },
  { key: "plans", label: "촬영 기획 고르기", due: "올리기 전날까지" },
  { key: "shoot", label: "촬영 · 올리기", due: "전날 14시까지 (안내)" },
  { key: "review", label: "완성본 확인", due: "올릴 시각 전까지" },
];

const ACTION: Record<CellTask, string> = { confirm: "확인", plans: "고르기", shoot: "올리기", review: "보기" };

export function BlockedAlert({ items }: { items: DayBoard["blocked"] }) {
  if (items.length === 0) return null;
  return (
    <div className="rounded-lg border border-risk/30 bg-risk-soft px-4 py-3">
      <p className="flex items-center gap-2 text-sm font-semibold text-risk">
        <OctagonAlert className="size-4 shrink-0" /> 멈춘 칸 {items.length}개 — 고치지 않으면 그 시각에 올라가지 않아요
      </p>
      <ul className="mt-2 space-y-1.5">
        {items.slice(0, 4).map((b) => (
          <li key={b.key} className="flex items-center justify-between gap-3 text-[13px]">
            <span className="min-w-0">
              <b>{b.label}</b>
              {b.reason && <span className="ml-1.5 text-ink-2">{b.reason.slice(0, 80)}</span>}
            </span>
            {b.href && (
              <Link href={b.href} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")}>
                고치기
              </Link>
            )}
          </li>
        ))}
      </ul>
      {items.length > 4 && <p className="mt-1.5 text-xs text-risk">외 {items.length - 4}개 — 편성표에서 모두 볼 수 있어요</p>}
    </div>
  );
}

// 곧 비는 칸(5-4) — 마감까지 준비가 안 될 것 같은 오늘 · 내일 칸
export function AtRiskAlert({ items }: { items: DayBoard["atRisk"] }) {
  if (items.length === 0) return null;
  return (
    <div className="rounded-lg border border-warn/40 bg-warn-soft px-4 py-3">
      <p className="flex items-center gap-2 text-sm font-semibold text-warn">
        <TriangleAlert className="size-4 shrink-0" /> 곧 비는 칸 — 마감 전에 준비가 안 될 것 같아요
      </p>
      <ul className="mt-2 space-y-1.5">
        {items.slice(0, 5).map((b) => (
          <li key={b.key} className="flex items-center justify-between gap-3 text-[13px]">
            <span className="min-w-0">
              <b>{b.label}</b>
              {b.reason && <span className="ml-1.5 text-ink-2">{b.reason}</span>}
            </span>
            {b.href && (
              <Link href={b.href} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")}>
                보기
              </Link>
            )}
          </li>
        ))}
      </ul>
      {items.length > 5 && <p className="mt-1.5 text-xs text-warn">외 {items.length - 5}개 — 편성표에서 모두 볼 수 있어요</p>}
    </div>
  );
}

export function TaskTiles({ board }: { board: DayBoard }) {
  const totalTodo = TASKS.reduce((n, t) => n + board.tasks[t.key].count, 0);
  const tile = "flex flex-col rounded-lg border bg-card p-4 transition-colors hover:bg-surface-2";
  return (
    <section className="space-y-2" aria-label="오늘 할 일">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Link href={board.blocked[0]?.href ?? "/schedule"} className={cn(tile, board.blocked.length > 0 && "border-risk/40 bg-risk-soft hover:bg-risk-soft")}>
          <span className="text-xs font-medium text-muted-foreground">멈춤</span>
          <span className={cn("mt-1 text-2xl font-bold tabular-nums", board.blocked.length > 0 && "text-risk")}>
            {board.blocked.length}
            <small className="ml-0.5 text-sm font-medium text-muted-foreground">칸</small>
          </span>
          <span className={cn("mt-auto pt-1 text-xs", board.blocked.length > 0 ? "font-semibold text-risk" : "text-faint")}>
            {board.blocked.length > 0 ? "지금 고치기" : "멈춘 칸 없음"}
          </span>
        </Link>
        {TASKS.map((t) => {
          const { count, href } = board.tasks[t.key];
          return (
            <Link key={t.key} href={href} className={tile}>
              <span className="text-xs font-medium text-muted-foreground">{t.label}</span>
              <span className={cn("mt-1 text-2xl font-bold tabular-nums", count > 0 && "text-primary")}>
                {count}
                <small className="ml-0.5 text-sm font-medium text-muted-foreground">칸</small>
              </span>
              <span className="mt-auto pt-1 text-xs text-muted-foreground">{count > 0 ? t.due : "남은 일 없음"}</span>
            </Link>
          );
        })}
        <Link href="/postings?status=scheduled" className={tile}>
          <span className="text-xs font-medium text-muted-foreground">예약 끝</span>
          <span className="mt-1 text-2xl font-bold tabular-nums">
            {board.done}
            <small className="ml-0.5 text-sm font-medium text-muted-foreground">/ {board.total}</small>
          </span>
          <span className="mt-auto pt-1 text-xs text-muted-foreground">AI 진행 중 {board.aiWorking}칸</span>
        </Link>
      </div>
      {totalTodo === 0 && board.blocked.length === 0 && (
        <p className="flex items-center gap-1.5 text-[13px] text-ok">
          <CheckCircle2 className="size-4" /> 지금 사람이 할 일은 없어요.
        </p>
      )}
    </section>
  );
}

export function DayBoardTable({ board, today, tomorrow }: { board: DayBoard; today: string; tomorrow: string }) {
  const isToday = board.date === today;
  const label = `${Number(board.date.slice(5, 7))}월 ${Number(board.date.slice(8, 10))}일`;
  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <CardTitle>
            {isToday ? "오늘" : "내일"} 발행 칸 <span className="font-normal text-muted-foreground tabular-nums">· {label}</span>
          </CardTitle>
          <CardDescription className="mt-1">
            {board.total}칸 · 08 · 21시는 AI가 만들고, 12 · 18시는 직접 찍어요
            {board.empty > 0 && <span className="text-risk"> · 기획 없는 빈 칸 {board.empty}개</span>}
          </CardDescription>
        </div>
        <div className="flex items-center gap-1.5">
          <nav className="flex items-center gap-1.5" aria-label="날짜">
            <Link href="/" className={buttonVariants({ variant: isToday ? "default" : "outline", size: "sm" })} aria-current={isToday ? "page" : undefined}>
              오늘
            </Link>
            <Link href="/?day=tomorrow" className={buttonVariants({ variant: !isToday ? "default" : "outline", size: "sm" })} aria-current={!isToday ? "page" : undefined}>
              내일
            </Link>
          </nav>
          <Link href={isToday ? "/schedule" : `/schedule?week=${tomorrow}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            <CalendarRange className="size-4" /> 편성표로 보기
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        {board.rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">편성된 칸이 없어요.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[720px] border-collapse text-[13px]">
              <thead className="bg-surface-2 text-xs text-muted-foreground">
                <tr className="h-11">
                  <th scope="col" className="w-20 px-3.5 text-left font-medium">
                    시각
                  </th>
                  <th scope="col" className="w-36 px-3.5 text-left font-medium">
                    계정
                  </th>
                  <th scope="col" className="w-28 px-3.5 text-left font-medium">
                    방식
                  </th>
                  <th scope="col" className="px-3.5 text-left font-medium">
                    상품 · 기획
                  </th>
                  <th scope="col" className="w-36 px-3.5 text-left font-medium">
                    상태
                  </th>
                  <th scope="col" className="w-24 px-3.5 text-right font-medium">
                    <span className="sr-only">할 일</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {board.rows.map((r) => (
                  <tr key={r.key} className="h-[52px] border-t">
                    <td className="px-3.5 font-semibold tabular-nums">{r.time}</td>
                    <td className="px-3.5">@{r.account}</td>
                    <td className="px-3.5">
                      <TrackBadge track={r.track} />
                    </td>
                    <td className="max-w-0 truncate px-3.5">{r.subject ?? <span className="text-faint">—</span>}</td>
                    <td className="px-3.5">
                      <span
                        className={cn(
                          "inline-flex h-6 items-center rounded-full px-2 text-xs font-semibold whitespace-nowrap",
                          TONE_CLASS[r.status.tone],
                          r.status.tone === "idle" && "px-0 font-medium",
                        )}
                      >
                        {r.status.label}
                      </span>
                    </td>
                    <td className="px-3.5 text-right">
                      {r.status.href && (r.status.task || r.status.tone === "risk") && (
                        <Link href={r.status.href} className={buttonVariants({ variant: r.status.task ? "outline" : "destructive", size: "sm" })}>
                          {r.status.task ? ACTION[r.status.task] : "고치기"}
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function YesterdayStrip({ lines }: { lines: YesterdayLine[] }) {
  if (lines.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>어제 성과</CardTitle>
        <CardDescription className="mt-1">계정별 팔로워 증감과 어제 올린 게시물 중 조회수가 가장 높은 것</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {lines.map((l) => (
            <li key={l.account} className="rounded-md border px-3.5 py-3 text-[13px]">
              <p className="font-semibold">@{l.account}</p>
              <p className="mt-1 tabular-nums">
                팔로워 {l.followers?.toLocaleString("ko-KR") ?? "—"}
                {l.delta != null && (
                  <span className={cn("ml-1.5 font-semibold", l.delta > 0 ? "text-ok" : l.delta < 0 ? "text-risk" : "text-muted-foreground")}>
                    {l.delta > 0 ? `+${l.delta}` : l.delta === 0 ? "변화 없음" : l.delta}
                  </span>
                )}
              </p>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {l.bestPost ? (
                  <>
                    조회 {l.bestPost.views.toLocaleString("ko-KR")} ·{" "}
                    {l.bestPost.permalink ? (
                      <a href={l.bestPost.permalink} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                        {l.bestPost.caption || "게시물"}
                      </a>
                    ) : (
                      l.bestPost.caption || "게시물"
                    )}
                  </>
                ) : (
                  "어제 올린 게시물 없음"
                )}
              </p>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

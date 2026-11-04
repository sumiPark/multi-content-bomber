import Link from "next/link";
import { CircleAlert, OctagonAlert, TriangleAlert } from "lucide-react";
import { TrackBadge } from "@/components/schedule/slot-rule-cell";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { CellTone } from "@/lib/schedule/cell-status";
import type { BlockedItem, UploadSchedule, YesterdayLine } from "@/lib/schedule/day-board";
import type { TodayPosts } from "@/lib/dashboard/today-posts";
import { cn } from "@/lib/utils";

// 대시보드(2026-11-04 사용자 결정 — 할 일 칸 · 하루 칸 표를 뺌): 놓치면 안 되는 경고 → 계정별 오늘 올린 개수 → 업로드 예정 → 어제 성과.
// 칸 상태 말은 자동 업로드 일정과 같은 계산(lib/schedule/cell-status.ts)이다.

const TONE_CLASS: Record<CellTone, string> = {
  todo: "bg-brand-soft text-primary",
  wait: "bg-surface-2 text-ink-2",
  ok: "bg-ok-soft text-ok",
  risk: "bg-risk-soft text-risk",
  idle: "bg-surface-2 text-muted-foreground",
};

export function BlockedAlert({ items }: { items: BlockedItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="rounded-lg border border-risk/30 bg-risk-soft px-4 py-3">
      <p className="flex items-center gap-2 text-sm font-semibold text-risk">
        <OctagonAlert className="size-4 shrink-0" /> 멈춘 것 {items.length}개 — 고치지 않으면 진행되지 않아요
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
      {items.length > 4 && (
        <details className="mt-1.5 text-[13px]">
          <summary className="cursor-pointer text-xs font-semibold text-risk">외 {items.length - 4}개 더 보기</summary>
          <ul className="mt-1.5 space-y-1">
            {items.slice(4).map((b) => (
              <li key={b.key}>
                {b.href ? (
                  <Link href={b.href} className="underline underline-offset-2">
                    {b.label}
                  </Link>
                ) : (
                  b.label
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// 곧 놓치는 것 — 상품 확인 마감 임박, 계정 연결 끊김
export function AtRiskAlert({ items }: { items: BlockedItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="rounded-lg border border-warn/40 bg-warn-soft px-4 py-3">
      <p className="flex items-center gap-2 text-sm font-semibold text-warn">
        <TriangleAlert className="size-4 shrink-0" /> 곧 놓치는 것 — 지금 확인해 주세요
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
      {items.length > 5 && (
        <details className="mt-1.5 text-[13px]">
          <summary className="cursor-pointer text-xs font-semibold text-warn">외 {items.length - 5}개 더 보기</summary>
          <ul className="mt-1.5 space-y-1">
            {items.slice(5).map((b) => (
              <li key={b.key}>
                {b.href ? (
                  <Link href={b.href} className="underline underline-offset-2">
                    {b.label}
                  </Link>
                ) : (
                  b.label
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function kstTimeLabel(iso: string, today: string, tomorrow: string): string {
  const kst = new Date(Date.parse(iso) + 9 * 3_600_000).toISOString();
  const date = kst.slice(0, 10);
  const time = kst.slice(11, 16);
  if (date === today) return `오늘 ${time}`;
  if (date === tomorrow) return `내일 ${time}`;
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))} ${time}`;
}

export function TodayPostsCard({ data }: { data: TodayPosts }) {
  const total = data.rows.reduce((n, r) => n + (r.count ?? 0), 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          오늘 올린 게시물 <span className="font-normal text-muted-foreground tabular-nums">· {total}개</span>
        </CardTitle>
        <CardDescription className="mt-1">인스타에서 바로 읽은 계정별 개수예요. MCB로 올린 것과 앱에서 올린 것을 모두 세요. 스토리는 빠져요.</CardDescription>
      </CardHeader>
      <CardContent>
        {data.rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">연결된 인스타그램 계정이 없어요.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {data.rows.map((r) => (
              <li key={r.account} className="rounded-md border px-3.5 py-3">
                <p className="truncate text-[13px] font-semibold">@{r.account}</p>
                {r.count == null ? (
                  <p className="mt-1 flex items-center gap-1 text-xs text-warn">
                    <CircleAlert className="size-3.5 shrink-0" /> 못 읽음
                  </p>
                ) : (
                  <>
                    <p className={cn("mt-1 text-2xl font-bold tabular-nums", r.count === 0 && "text-muted-foreground")}>
                      {r.count}
                      <small className="ml-0.5 text-sm font-medium text-muted-foreground">개</small>
                    </p>
                    {r.count > 0 && <p className="text-xs text-muted-foreground tabular-nums">릴스 {r.reels}개</p>}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function UploadScheduleCard({ data, today, tomorrow }: { data: UploadSchedule; today: string; tomorrow: string }) {
  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <CardTitle>
            업로드 예정 <span className="font-normal text-muted-foreground tabular-nums">· {data.total}건</span>
          </CardTitle>
          <CardDescription className="mt-1">앞으로 7일의 AI 자동 업로드와 콘텐츠 생성에서 예약한 건이에요.</CardDescription>
        </div>
        <div className="flex gap-1.5">
          <Link href="/schedule" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
            자동 업로드 일정
          </Link>
          <Link href="/postings?status=scheduled" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
            배포 관리
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        {data.items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">예정된 업로드가 없어요.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[640px] border-collapse text-[13px]">
              <thead className="bg-surface-2 text-xs text-muted-foreground">
                <tr className="h-11">
                  <th scope="col" className="w-28 px-3.5 text-left font-medium">
                    시각
                  </th>
                  <th scope="col" className="w-36 px-3.5 text-left font-medium">
                    계정
                  </th>
                  <th scope="col" className="w-28 px-3.5 text-left font-medium">
                    방식
                  </th>
                  <th scope="col" className="px-3.5 text-left font-medium">
                    내용
                  </th>
                  <th scope="col" className="w-48 px-3.5 text-left font-medium">
                    상태
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((u) => (
                  <tr key={u.key} className="h-[52px] border-t">
                    <td className="px-3.5 font-semibold tabular-nums">{kstTimeLabel(u.at, today, tomorrow)}</td>
                    <td className="max-w-0 truncate px-3.5">@{u.account}</td>
                    <td className="px-3.5">
                      {u.auto ? <TrackBadge track="B" /> : <span className="inline-flex h-6 items-center rounded-full bg-surface-2 px-2 text-xs font-semibold text-ink-2">직접 예약</span>}
                    </td>
                    <td className="max-w-0 truncate px-3.5">{u.subject ?? <span className="text-faint">—</span>}</td>
                    <td className="px-3.5">
                      {u.href ? (
                        <Link href={u.href} className={cn("inline-flex h-6 items-center rounded-full px-2 text-xs font-semibold whitespace-nowrap hover:underline", TONE_CLASS[u.tone])}>
                          {u.label}
                        </Link>
                      ) : (
                        <span className={cn("inline-flex h-6 items-center rounded-full px-2 text-xs font-semibold whitespace-nowrap", TONE_CLASS[u.tone])}>{u.label}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.total > data.items.length && <p className="mt-2 text-xs text-muted-foreground tabular-nums">가까운 {data.items.length}건만 보여요. 전체는 위 화면에서 볼 수 있어요.</p>}
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

import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { SlotRuleCell, TrackBadge } from "@/components/schedule/slot-rule-cell";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { addDays, kstDate } from "@/lib/automation/time";
import { cellStatus, TONE_LABEL, type CellStatus, type CellTone } from "@/lib/schedule/cell-status";
import { cn } from "@/lib/utils";

// 편성표 — 계정 × 하루 칸(기본 08 · 21시 AI 자동, 12 · 18시 직접 촬영)이 한 주 동안 어디까지 왔는지 보고,
// 칸마다 주제를 정한다. AI 자동 업로드의 상품 선정과 직접 촬영 기획안 후보가 이 주제를 참고한다.
// 칸 시각 · 방식은 고정(바꾸는 기능은 아직 없음), 켜기 · 끄기와 주제만 바꾼다.

export const metadata = { title: "편성표 | MCB" };

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

function mondayOf(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((dow + 6) % 7));
}

function dayLabel(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return `${Number(date.slice(5, 7))}.${Number(date.slice(8, 10))} (${WEEKDAYS[dow]})`;
}

const TONE_CLASS: Record<CellTone, string> = {
  todo: "bg-brand-soft text-primary",
  wait: "bg-surface-2 text-ink-2",
  ok: "bg-ok-soft text-ok",
  risk: "bg-risk-soft text-risk",
  idle: "text-faint",
};

function StatusChip({ status }: { status: CellStatus }) {
  return (
    <span className={cn("inline-flex h-6 items-center rounded-full px-2 text-xs font-semibold whitespace-nowrap", TONE_CLASS[status.tone], status.tone === "idle" && "px-0 font-medium")}>
      {status.label}
    </span>
  );
}

export default async function SchedulePage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");
  const canManage = profile.role === "ADMIN" || profile.role === "MANAGER";
  const supabase = await getServerSupabase();

  const { week } = await searchParams;
  const today = kstDate(0);
  const start = mondayOf(week && /^\d{4}-\d{2}-\d{2}$/.test(week) && !Number.isNaN(Date.parse(week)) ? week : today);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const end = days[6];
  const thisWeek = mondayOf(today);

  const [{ data: ruleRows }, { data: planRows }] = await Promise.all([
    supabase
      .from("slot_rules")
      .select("id, social_account_id, slot_time, track, active, topic, social_accounts(display_name, is_active, disconnected_at)")
      .order("slot_time"),
    supabase
      .from("content_plans")
      .select("social_account_id, slot_date, slot_time, track, status, products(name), publish_jobs(status), shoot_requests(status)")
      .gte("slot_date", start)
      .lte("slot_date", end),
  ]);

  // 계정별 칸 (연결 끊긴 계정은 뺀다)
  const accounts = new Map<string, { name: string; rules: NonNullable<typeof ruleRows> }>();
  for (const r of ruleRows ?? []) {
    const acc = r.social_accounts;
    if (!acc || acc.disconnected_at) continue;
    const entry = accounts.get(r.social_account_id) ?? { name: acc.display_name ?? "", rules: [] };
    entry.rules.push(r);
    accounts.set(r.social_account_id, entry);
  }
  const accountList = [...accounts.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  const times = [...new Set((ruleRows ?? []).map((r) => r.slot_time))].sort();

  const planOf = new Map((planRows ?? []).map((p) => [`${p.social_account_id}|${p.slot_date}|${p.slot_time}`, p]));

  const counts: Record<CellTone, number> = { todo: 0, wait: 0, ok: 0, risk: 0, idle: 0 };
  const grid = accountList.map(([accountId, acc]) => ({
    accountId,
    name: acc.name,
    rows: acc.rules.map((rule) => ({
      rule,
      cells: days.map((date) => {
        const p = planOf.get(`${accountId}|${date}|${rule.slot_time}`);
        const status = cellStatus(
          p
            ? {
                track: p.track,
                status: p.status,
                slot_date: p.slot_date,
                slot_time: p.slot_time,
                jobStatus: p.publish_jobs?.status ?? null,
                requestStatus: p.shoot_requests?.status ?? null,
              }
            : null,
          { date, time: rule.slot_time, track: rule.track, active: rule.active },
        );
        if (rule.active || p) counts[status.tone] += 1;
        return { date, status, product: p?.products?.name ?? null };
      }),
    })),
  }));
  const total = counts.todo + counts.wait + counts.ok + counts.risk + counts.idle;

  return (
    <main className="space-y-6 p-4 sm:p-6">
      <header>
        <h1 className="text-xl font-bold tracking-[-0.01em]">편성표</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          계정마다 하루 칸이 정해져 있어요. 08 · 21시는 <b>AI 자동 업로드</b>, 12 · 18시는 <b>직접 촬영</b>입니다. 칸마다 주제를 적어 두면 AI가
          상품 · 기획을 고를 때 참고해요.
        </p>
      </header>

      {accountList.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            편성된 계정이 없어요.
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle>주간 진행</CardTitle>
                <CardDescription className="mt-1 tabular-nums">
                  {dayLabel(start)} – {dayLabel(end)} · {total}칸
                </CardDescription>
              </div>
              <nav className="flex items-center gap-1.5" aria-label="주 이동">
                <Link href={`/schedule?week=${addDays(start, -7)}`} className={buttonVariants({ variant: "outline", size: "icon" })} aria-label="지난주">
                  <ChevronLeft className="size-4" />
                </Link>
                <Link
                  href="/schedule"
                  className={buttonVariants({ variant: start === thisWeek ? "default" : "outline", size: "sm" })}
                  aria-current={start === thisWeek ? "page" : undefined}
                >
                  이번 주
                </Link>
                <Link href={`/schedule?week=${addDays(start, 7)}`} className={buttonVariants({ variant: "outline", size: "icon" })} aria-label="다음 주">
                  <ChevronRight className="size-4" />
                </Link>
              </nav>
            </CardHeader>
            <CardContent className="space-y-4">
              <ul className="flex flex-wrap gap-2 text-xs">
                {(["todo", "wait", "ok", "risk", "idle"] as CellTone[]).map((t) => (
                  <li key={t} className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1">
                    <span className={cn("size-2 rounded-full", t === "todo" ? "bg-primary" : t === "wait" ? "bg-ink-2/40" : t === "ok" ? "bg-ok" : t === "risk" ? "bg-risk" : "bg-faint")} />
                    {TONE_LABEL[t]} <b className="tabular-nums">{counts[t]}</b>
                  </li>
                ))}
              </ul>

              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full min-w-[960px] table-fixed border-collapse text-[13px]">
                  <thead className="bg-surface-2 text-xs text-muted-foreground">
                    <tr className="h-11">
                      <th scope="col" className="w-32 px-3.5 text-left font-medium">
                        계정
                      </th>
                      <th scope="col" className="w-24 px-3.5 text-left font-medium">
                        칸
                      </th>
                      {days.map((d) => (
                        <th key={d} scope="col" className={cn("px-2 text-left font-medium tabular-nums", d === today && "text-primary")}>
                          {dayLabel(d)}
                          {d === today && <span className="ml-1">· 오늘</span>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {grid.map((acc) =>
                      acc.rows.map(({ rule, cells }, i) => (
                        <tr key={rule.id} className={cn("border-t align-top", i === 0 && "border-t-line-strong")}>
                          {i === 0 && (
                            <th scope="rowgroup" rowSpan={acc.rows.length} className="border-r px-3.5 py-3 text-left font-semibold">
                              @{acc.name}
                            </th>
                          )}
                          <th scope="row" className="px-3.5 py-2.5 text-left font-normal">
                            <div className="font-semibold tabular-nums">{rule.slot_time}</div>
                            <div className="mt-1">
                              <TrackBadge track={rule.track} />
                            </div>
                          </th>
                          {cells.map((c) => {
                            const body = (
                              <>
                                <StatusChip status={c.status} />
                                {c.product && <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">{c.product}</span>}
                              </>
                            );
                            return (
                              <td key={c.date} className={cn("px-2 py-2.5", c.date === today && "bg-brand-soft/40")}>
                                {c.status.href ? (
                                  <Link href={c.status.href} className="-m-1 block rounded-md p-1 hover:bg-surface-3">
                                    {body}
                                  </Link>
                                ) : (
                                  <div>{body}</div>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground">
                칸을 누르면 그 칸의 할 일 화면으로 가요. AI는 기획을 하루 전에 만들어요. 그 전까지는 “기획 전”, 오늘 칸인데 기획이 없으면 “빈 칸”(이대로면 그 시각에 아무것도 안 올라가요)으로 보여요.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>칸 설정</CardTitle>
              <CardDescription className="mt-1">
                주제를 적으면 AI가 그 칸의 상품 · 기획을 고를 때 먼저 참고해요. 끈 칸은 기획하지 않아요. 바꾼 값은 다음 기획부터 반영되고, 이미 만든
                기획은 그대로예요.{!canManage && " 관리자 · 매니저만 바꿀 수 있어요."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full min-w-[720px] border-collapse text-[13px]">
                  <thead className="bg-surface-2 text-xs text-muted-foreground">
                    <tr className="h-11">
                      <th scope="col" className="w-32 px-3.5 text-left font-medium">
                        계정
                      </th>
                      {times.map((t) => (
                        <th key={t} scope="col" className="px-3.5 text-left font-medium tabular-nums">
                          {t}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {accountList.map(([accountId, acc]) => (
                      <tr key={accountId} className="border-t align-top">
                        <th scope="row" className="px-3.5 py-3 text-left font-semibold">
                          @{acc.name}
                        </th>
                        {times.map((t) => {
                          const rule = acc.rules.find((r) => r.slot_time === t);
                          return (
                            <td key={t} className="px-3.5 py-3">
                              {rule ? (
                                <SlotRuleCell rule={{ id: rule.id, track: rule.track, topic: rule.topic, active: rule.active }} canManage={canManage} />
                              ) : (
                                <span className="text-xs text-faint">칸 없음</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </main>
  );
}

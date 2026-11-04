import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { addDays, kstDate } from "@/lib/automation/time";
import { cellStatus, TONE_LABEL, type CellStatus, type CellTone } from "@/lib/schedule/cell-status";
import { trackTimesLabel } from "@/lib/schedule/slot-admin";
import { cn } from "@/lib/utils";

// 자동 업로드 일정(주소는 예전 편성표 그대로 /schedule) — 자동으로 생성 · 업로드되는 칸만 본다. 직접 촬영은 직접 촬영 메뉴에서.
// 계정 × 하루 칸이 한 주 동안 어디까지 왔는지만 본다. 계정 · 칸 · 참고 내용은 자동 콘텐츠 설정(/auto/settings)에서 고친다.

export const metadata = { title: "자동 업로드 일정 | MCB" };

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

export default async function SchedulePage({ searchParams }: { searchParams: Promise<{ week?: string; tab?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");
  const supabase = await getServerSupabase();

  const { week, tab } = await searchParams;
  // 예전 탭 주소(편성 관리 · 계정 컨셉)는 자동 콘텐츠 설정으로 옮겨 갔다
  if (tab === "manage" || tab === "concept") redirect("/auto/settings");
  const today = kstDate(0);
  const start = mondayOf(week && /^\d{4}-\d{2}-\d{2}$/.test(week) && !Number.isNaN(Date.parse(week)) ? week : today);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const end = days[6];
  const thisWeek = mondayOf(today);

  const [{ data: ruleRows }, { data: planRows }, { data: settingRows }] = await Promise.all([
    supabase
      .from("slot_rules")
      .select("id, social_account_id, slot_time, track, active, topic, social_accounts(display_name, is_active, disconnected_at)")
      .eq("track", "B")
      .order("slot_time"),
    supabase
      .from("content_plans")
      .select("social_account_id, slot_date, slot_time, status, products(name), publish_jobs(status)")
      .eq("track", "B")
      .gte("slot_date", start)
      .lte("slot_date", end),
    supabase.from("track_settings").select("social_account_id, shoot_enabled, social_accounts(display_name, disconnected_at)"),
  ]);

  // 직접 촬영만 쓰는 계정(칸 없음 + shoot_enabled)은 이 화면 소속이 아니다. 연결 끊긴 계정은 뺀다
  const rulesByAccount = new Set((ruleRows ?? []).map((r) => r.social_account_id));
  const accounts = new Map<string, { name: string; rules: NonNullable<typeof ruleRows> }>();
  for (const t of settingRows ?? []) {
    if (!t.social_accounts || t.social_accounts.disconnected_at) continue;
    if (t.shoot_enabled && !rulesByAccount.has(t.social_account_id)) continue;
    accounts.set(t.social_account_id, { name: t.social_accounts.display_name ?? "", rules: [] });
  }
  for (const r of ruleRows ?? []) accounts.get(r.social_account_id)?.rules.push(r);
  const accountList = [...accounts.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  const activeRules = (ruleRows ?? []).filter((r) => r.active && accounts.has(r.social_account_id));

  // 시각을 바꾸면 지난 기록은 옛 시각에 남는다 — 지금 칸이 아니어도 이번 주 기록이 있으면 줄을 보여 준다
  for (const [accountId, acc] of accounts) {
    const times = new Set(acc.rules.map((r) => r.slot_time));
    for (const p of planRows ?? []) {
      const time = p.slot_time as string;
      if (p.social_account_id !== accountId || times.has(time)) continue;
      times.add(time);
      acc.rules.push({ id: `past-${accountId}-${time}`, social_account_id: accountId, slot_time: time, track: "B", active: false, topic: null, social_accounts: { display_name: acc.name, is_active: true, disconnected_at: null } });
    }
    acc.rules.sort((a, b) => a.slot_time.localeCompare(b.slot_time));
  }

  const planOf = new Map((planRows ?? []).map((p) => [`${p.social_account_id}|${p.slot_date}|${p.slot_time}`, p]));

  const counts: Record<CellTone, number> = { todo: 0, wait: 0, ok: 0, risk: 0, idle: 0 };
  const grid = accountList.map(([accountId, acc]) => ({
    accountId,
    name: acc.name,
    rows: acc.rules.map((rule) => ({
      rule,
      cells: days.map((date) => {
        const p = planOf.get(`${accountId}|${date}|${rule.slot_time}`);
        const status: CellStatus = !p && rule.id.startsWith("past-") ? { label: "—", tone: "idle", href: null } : cellStatus(
          p ? { status: p.status, jobStatus: p.publish_jobs?.status ?? null } : null,
          { date, time: rule.slot_time, active: rule.active, accountOff: rule.social_accounts?.is_active === false },
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
        <h1 className="text-xl font-bold tracking-[-0.01em]">자동 업로드 일정</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          AI가 자동으로 만들어 올리는 일정이에요. 지금 {trackTimesLabel(activeRules, "B")}. 계정 · 칸 · 참고 내용은{" "}
          <Link href="/auto/settings" className="underline underline-offset-2">
            자동 콘텐츠 설정
          </Link>
          에서 바꿔요. 직접 찍어 올리는 영상은{" "}
          <Link href="/shoot/plans" className="underline underline-offset-2">
            촬영 기획 고르기
          </Link>
          에서 관리해요.
        </p>
      </header>

      {accountList.length === 0 ? (
          <Card>
            <CardContent className="space-y-3 py-10 text-center text-sm text-muted-foreground">
              <p>자동 콘텐츠를 만들 계정이 없어요.</p>
              <Link href="/auto/settings" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                자동 콘텐츠 설정에서 계정 넣기
              </Link>
            </CardContent>
          </Card>
        ) : (
              <Card>
                <CardHeader className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <CardTitle>주간 현황</CardTitle>
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
                    <table className="w-full min-w-[1160px] table-fixed border-collapse text-sm">
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
                                {rule.id.startsWith("past-") && <div className="mt-0.5 text-xs text-muted-foreground">지난 시각</div>}
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
                    칸을 누르면 그 칸의 할 일 화면으로 가요. AI는 상품 제안을 하루 전에 만들어요. 그 전까지는 “기획 전”, 오늘 칸인데 기획이 없으면 “빈 칸”(이대로면 그 시각에 아무것도 안 올라가요)으로 보여요.
                  </p>
                </CardContent>
              </Card>
      )}
    </main>
  );
}

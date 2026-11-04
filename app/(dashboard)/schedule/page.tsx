import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { AccountConceptCard } from "@/components/schedule/account-concept";
import { AccountScheduleCard, AddAccountPanel } from "@/components/schedule/account-schedule";
import { TrackBadge } from "@/components/schedule/slot-rule-cell";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { addDays, kstDate } from "@/lib/automation/time";
import { cellStatus, TONE_LABEL, type CellStatus, type CellTone } from "@/lib/schedule/cell-status";
import { AUTO_EARLIEST, MAX_SLOTS_PER_DAY, MIN_GAP_MINUTES, SCOPE_OPTIONS, SHOOT_LEAD_HOURS, trackTimesLabel } from "@/lib/schedule/slot-admin";
import { describeEditStyle, parseEditStyle } from "@/lib/shoot/edit-style";
import { cn } from "@/lib/utils";

// 편성표 — 탭 세 개(주소 ?tab=으로 구분 — 새로 고침 · 링크 공유해도 그 탭):
//   주간 현황  계정 × 하루 칸이 한 주 동안 어디까지 왔는지
//   편성 관리  계정 넣기 · 빼기, 쓸 상품, 칸 시각 · 방식 · 주제 · 켜기/끄기 AI 자동 업로드의 상품 선정과 직접 촬영 기획안 후보가 이 표를 보고 만들어진다.
//   계정 컨셉  계정마다 AI 자동 업로드 · 직접 촬영의 방향과 스타일(0038). 기획 · 대본 · 컷 리스트 · 편집이 읽는다.

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

export default async function SchedulePage({ searchParams }: { searchParams: Promise<{ week?: string; tab?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");
  const canManage = profile.role === "ADMIN" || profile.role === "MANAGER";
  const supabase = await getServerSupabase();

  const { week, tab: tabParam } = await searchParams;
  const tab = tabParam === "manage" ? "manage" : tabParam === "concept" ? "concept" : "board";
  const today = kstDate(0);
  const start = mondayOf(week && /^\d{4}-\d{2}-\d{2}$/.test(week) && !Number.isNaN(Date.parse(week)) ? week : today);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const end = days[6];
  const thisWeek = mondayOf(today);

  const [{ data: ruleRows }, { data: planRows }, { data: settingRows }, { data: igAccounts }, { data: conceptRows }] = await Promise.all([
    supabase
      .from("slot_rules")
      .select("id, social_account_id, slot_time, track, active, topic, social_accounts(display_name, is_active, disconnected_at)")
      .order("slot_time"),
    supabase
      .from("content_plans")
      .select("social_account_id, slot_date, slot_time, track, status, products(name), publish_jobs(status), shoot_requests(status)")
      .gte("slot_date", start)
      .lte("slot_date", end),
    supabase.from("track_settings").select("social_account_id, product_scopes, social_accounts(display_name, disconnected_at, role_focus)"),
    supabase.from("social_accounts").select("id, display_name").eq("platform", "INSTAGRAM").is("disconnected_at", null).order("display_name"),
    supabase.from("account_concepts").select("social_account_id, auto_concept, auto_hooks, auto_endings, auto_tone, auto_video_style, shoot_concept, shoot_hooks, shoot_endings, shoot_tone, shoot_edit_style, shoot_edit_params, updated_at"),
  ]);

  // 편성 계정(track_settings) — 칸이 아직 없는 계정도 편성 관리에 보인다. 연결 끊긴 계정은 뺀다
  const accounts = new Map<string, { name: string; role: string | null; scopes: string[]; rules: NonNullable<typeof ruleRows> }>();
  for (const t of settingRows ?? []) {
    if (!t.social_accounts || t.social_accounts.disconnected_at) continue;
    const scopes = ((t.product_scopes ?? []) as { shop: string; kind: string }[]).map((x) => `${x.shop}:${x.kind}`);
    const role = t.social_accounts.role_focus === "PERSON" ? "사람 중심" : t.social_accounts.role_focus === "PRODUCT" ? "상품 중심" : null;
    accounts.set(t.social_account_id, { name: t.social_accounts.display_name ?? "", role, scopes, rules: [] });
  }
  for (const r of ruleRows ?? []) accounts.get(r.social_account_id)?.rules.push(r);
  const accountList = [...accounts.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  const candidates = (igAccounts ?? []).filter((a) => !accounts.has(a.id)).map((a) => ({ id: a.id, name: a.display_name ?? "" }));
  const activeRules = (ruleRows ?? []).filter((r) => r.active && accounts.has(r.social_account_id));
  const limits = { maxSlots: MAX_SLOTS_PER_DAY, minGapHours: MIN_GAP_MINUTES / 60, autoEarliest: AUTO_EARLIEST, shootLeadHours: SHOOT_LEAD_HOURS };

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
          { date, time: rule.slot_time, track: rule.track, active: rule.active, accountOff: rule.social_accounts?.is_active === false },
        );
        if (rule.active || p) counts[status.tone] += 1;
        return { date, status, product: p?.products?.name ?? null };
      }),
    })),
  }));
  const total = counts.todo + counts.wait + counts.ok + counts.risk + counts.idle;

  const conceptOf = new Map((conceptRows ?? []).map((c) => [c.social_account_id, c]));
  const conceptCards = accountList.map(([accountId, acc]) => {
    const c = conceptOf.get(accountId);
    const edit = parseEditStyle(c?.shoot_edit_params);
    return {
      accountId,
      name: acc.name,
      role: acc.role,
      autoSlots: acc.rules.filter((r) => r.track === "B" && r.active).length,
      shootSlots: acc.rules.filter((r) => r.track === "A" && r.active).length,
      autoConcept: c?.auto_concept ?? "",
      autoHooks: (c?.auto_hooks ?? []).join("\n"),
      autoEndings: (c?.auto_endings ?? []).join("\n"),
      autoTone: c?.auto_tone ?? "",
      autoVideoStyle: c?.auto_video_style ?? "",
      shootConcept: c?.shoot_concept ?? "",
      shootHooks: (c?.shoot_hooks ?? []).join("\n"),
      shootEndings: (c?.shoot_endings ?? []).join("\n"),
      shootTone: c?.shoot_tone ?? "",
      shootEditStyle: c?.shoot_edit_style ?? "",
      editApplied: describeEditStyle(edit.style),
      editUnsupported: edit.unsupported,
      updatedAt: c?.updated_at ?? null,
    };
  });

  return (
    <main className="space-y-6 p-4 sm:p-6">
      <header>
        <h1 className="text-xl font-bold tracking-[-0.01em]">편성표</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          어느 계정이 몇 시에 무엇을 올리는지 정하고, 한 주가 어디까지 왔는지 봐요. 지금 <b>AI 자동 업로드</b> {trackTimesLabel(activeRules, "B")} · <b>직접 촬영</b> {trackTimesLabel(activeRules, "A")}. 칸마다
          주제를 적어 두면 AI가 상품 · 기획을 고를 때 참고해요.
        </p>
      </header>

      <nav className="inline-flex rounded-lg border bg-surface-2 p-1" aria-label="편성표 보기">
        {(
          [
            { key: "board", label: "주간 현황", href: "/schedule", count: null },
            { key: "manage", label: "편성 관리", href: "/schedule?tab=manage", count: accountList.length },
            { key: "concept", label: "계정 컨셉", href: "/schedule?tab=concept", count: null },
          ] as const
        ).map((t) => (
          <Link
            key={t.key}
            href={t.href}
            aria-current={tab === t.key ? "page" : undefined}
            className={cn(
              "inline-flex h-9 items-center gap-1.5 rounded-md px-4 text-[13px] transition-colors",
              tab === t.key ? "bg-card font-semibold text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
            {t.count != null && <span className="text-xs font-medium tabular-nums text-muted-foreground">계정 {t.count}</span>}
          </Link>
        ))}
      </nav>

      {tab === "board" ? (
        accountList.length === 0 ? (
          <Card>
            <CardContent className="space-y-3 py-10 text-center text-sm text-muted-foreground">
              <p>편성된 계정이 없어요.</p>
              <Link href="/schedule?tab=manage" className={buttonVariants({ variant: "outline", size: "sm" })}>
                편성 관리에서 계정 넣기
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
        )
      ) : tab === "concept" ? (
            <Card>
              <CardHeader>
                <CardTitle>계정 컨셉</CardTitle>
                <CardDescription className="mt-1">
                  계정마다 완전 자동(AI 자동 업로드)과 혼합(직접 촬영 + AI 편집)의 후킹 문구 · 말투 · 스타일을 저장해 두면, AI가 기획 · 대본 · 컷 리스트 · 편집에 계속 씁니다. 다음에 쓰는 대본부터 적용되고, 이미 쓴 대본은 그대로예요. 광고 문구 규칙과 상품 사실이 항상 먼저예요.
                  {!canManage && " 관리자 · 매니저만 바꿀 수 있어요."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {conceptCards.length === 0 ? (
                  <p className="rounded-md border border-dashed px-4 py-6 text-center text-[13px] text-muted-foreground">
                    편성에 넣은 계정이 없어요.{" "}
                    <Link href="/schedule?tab=manage" className="underline underline-offset-2">
                      편성 관리
                    </Link>
                    에서 먼저 계정을 넣어 주세요.
                  </p>
                ) : (
                  conceptCards.map((c) => <AccountConceptCard key={c.accountId} data={c} canManage={canManage} />)
                )}
              </CardContent>
            </Card>
      ) : (
            <Card>
              <CardHeader className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>편성 관리</CardTitle>
                  <CardDescription className="mt-1">
                    계정마다 쓸 상품과 하루 칸(시각 · 방식 · 주제)을 정해요. 시각을 바꾸면 앞으로의 기획도 새 시각으로 옮겨요. 끈 칸은 기획하지 않아요. 하루{" "}
                    {MAX_SLOTS_PER_DAY}칸까지, 같은 계정 칸 사이 {MIN_GAP_MINUTES / 60}시간 이상, AI 자동 칸은 {AUTO_EARLIEST} 이후.
                    {!canManage && " 관리자 · 매니저만 바꿀 수 있어요."}
                  </CardDescription>
                </div>
                {canManage && <AddAccountPanel candidates={candidates} options={SCOPE_OPTIONS} limits={limits} />}
              </CardHeader>
              <CardContent className="space-y-3">
                {accountList.map(([accountId, acc]) => (
                  <AccountScheduleCard
                    key={accountId}
                    accountId={accountId}
                    name={acc.name}
                    scopes={acc.scopes}
                    rules={acc.rules.map((r) => ({ id: r.id, time: r.slot_time, track: r.track, topic: r.topic, active: r.active }))}
                    options={SCOPE_OPTIONS}
                    limits={limits}
                    canManage={canManage}
                  />
                ))}
              </CardContent>
            </Card>
      )}
    </main>
  );
}

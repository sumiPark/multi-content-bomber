import { isPastDeadline, isPastSlot } from "@/lib/automation/deadline";
import { addDays, kstDate } from "@/lib/automation/time";
import { cellStatus, type CellStatus, type CellTask } from "@/lib/schedule/cell-status";
import type { getServerSupabase } from "@/lib/auth";

// 대시보드 "오늘 할 일" — 하루 발행 칸 판(계정 × 칸) + 사람 할 일 개수 + 멈춘 칸.
// 할 일 · 멈춤은 오늘부터 7일 안의 칸을 같이 센다(내일 · 모레 칸의 상품 확인 · 기획 고르기 · 촬영도 지금 할 수 있어서).
// 칸 상태 말은 편성표와 같은 cellStatus를 쓴다.

type Supabase = Awaited<ReturnType<typeof getServerSupabase>>;

export interface BoardRow {
  key: string;
  time: string;
  account: string;
  track: string;
  // 상품 이름, 기획안 후보만 있으면 "기획안 후보 n개", 기획이 없으면 null
  subject: string | null;
  status: CellStatus;
}

export interface BlockedItem {
  key: string;
  label: string;
  reason: string | null;
  href: string | null;
}

export interface DayBoard {
  date: string;
  rows: BoardRow[];
  total: number;
  done: number; // 예약 · 발행 끝
  aiWorking: number;
  empty: number; // 기획 없이 빈 칸(오늘만)
  tasks: Record<CellTask, { count: number; href: string }>;
  blocked: BlockedItem[];
}

const TASK_DAYS = 7;

function dayName(date: string, today: string): string {
  if (date === today) return "오늘";
  if (date === addDays(today, 1)) return "내일";
  if (date === addDays(today, 2)) return "모레";
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

export async function loadDayBoard(supabase: Supabase, date: string, now = Date.now()): Promise<DayBoard> {
  const today = kstDate(0, now);
  const horizon = addDays(today, TASK_DAYS);
  const from = date < today ? date : today;
  const to = date > horizon ? date : horizon;

  const [{ data: rules }, { data: plans }, { data: settings }] = await Promise.all([
    supabase
      .from("slot_rules")
      .select("social_account_id, slot_time, track, active, social_accounts(display_name, disconnected_at)")
      .eq("active", true),
    supabase
      .from("content_plans")
      .select("id, social_account_id, slot_date, slot_time, track, status, proposal, note, error, products(name), publish_jobs(status), shoot_requests(status, error), social_accounts(display_name)")
      .gte("slot_date", from)
      .lte("slot_date", to),
    supabase.from("track_settings").select("social_account_id, b_confirm_deadline"),
  ]);

  const deadlineOf = new Map((settings ?? []).map((s) => [s.social_account_id, s.b_confirm_deadline ?? "07:00"]));
  const statusOf = (p: NonNullable<typeof plans>[number]) =>
    cellStatus(
      {
        track: p.track,
        status: p.status,
        slot_date: p.slot_date,
        slot_time: p.slot_time,
        jobStatus: p.publish_jobs?.status ?? null,
        requestStatus: p.shoot_requests?.status ?? null,
      },
      { date: p.slot_date, time: p.slot_time, track: p.track, active: true },
      now,
    );

  // ── 할 일 · 멈춤: 오늘 ~ 7일 뒤, 올릴 시각(상품 확인은 확인 마감)이 안 지난 칸만
  const tasks: DayBoard["tasks"] = {
    confirm: { count: 0, href: "/auto/confirm" },
    plans: { count: 0, href: "/shoot/plans" },
    shoot: { count: 0, href: "/shoot/uploads" },
    review: { count: 0, href: "/shoot/review" },
  };
  const firstDate: Partial<Record<CellTask, string>> = {};
  const blocked: BlockedItem[] = [];
  for (const p of plans ?? []) {
    if (p.slot_date < today || p.slot_date > horizon) continue;
    if (isPastSlot(p.slot_date, p.slot_time, 0, now)) continue;
    const st = statusOf(p);
    if (st.task) {
      if (st.task === "confirm" && isPastDeadline(p.slot_date, deadlineOf.get(p.social_account_id) ?? "07:00", now)) continue;
      tasks[st.task].count += 1;
      if (!firstDate[st.task] || p.slot_date < firstDate[st.task]!) firstDate[st.task] = p.slot_date;
    } else if (st.tone === "risk" && st.label !== "발행 실패") {
      // 발행 실패는 위쪽 발행 실패 줄이 따로 알린다
      blocked.push({
        key: p.id,
        label: `@${p.social_accounts?.display_name ?? ""} ${dayName(p.slot_date, today)} ${p.slot_time} — ${st.label}`,
        reason: p.shoot_requests?.error ?? p.error ?? p.note ?? null,
        href: st.href,
      });
    }
  }
  if (firstDate.confirm) tasks.confirm.href = `/auto/confirm?date=${firstDate.confirm}`;
  if (firstDate.plans) tasks.plans.href = `/shoot/plans?date=${firstDate.plans}`;

  // ── 고른 날의 칸 판
  const planOf = new Map((plans ?? []).filter((p) => p.slot_date === date).map((p) => [`${p.social_account_id}|${p.slot_time}`, p]));
  const rows: BoardRow[] = [];
  for (const r of rules ?? []) {
    if (!r.social_accounts || r.social_accounts.disconnected_at) continue;
    const p = planOf.get(`${r.social_account_id}|${r.slot_time}`);
    const ideas = ((p?.proposal ?? {}) as { ideas?: unknown[] }).ideas;
    rows.push({
      key: `${r.social_account_id}|${r.slot_time}`,
      time: r.slot_time,
      account: r.social_accounts.display_name ?? "",
      track: r.track,
      subject: p
        ? p.track === "A" && p.status === "PROPOSED" && ideas?.length
          ? `기획안 후보 ${ideas.length}개`
          : (p.products?.name ?? null)
        : null,
      status: p ? statusOf(p) : cellStatus(null, { date, time: r.slot_time, track: r.track, active: true }, now),
    });
  }
  rows.sort((a, b) => a.time.localeCompare(b.time) || a.account.localeCompare(b.account));

  return {
    date,
    rows,
    total: rows.length,
    done: rows.filter((r) => r.status.tone === "ok").length,
    aiWorking: rows.filter((r) => r.status.tone === "wait").length,
    empty: rows.filter((r) => r.status.label === "빈 칸").length,
    tasks,
    blocked,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 어제 성과 한 줄 — 계정별 팔로워 증감 + 어제 올린 게시물 중 조회수가 가장 높은 것.
// 성과 수집(1단계)이 아직 안 돌았으면 빈 배열 → 화면에서 줄을 숨긴다.

export interface YesterdayLine {
  account: string;
  followers: number | null;
  delta: number | null;
  bestPost: { caption: string; views: number; permalink: string | null } | null;
}

export async function loadYesterday(supabase: Supabase, now = Date.now()): Promise<YesterdayLine[]> {
  const yesterday = kstDate(-1, now);
  const dayBefore = kstDate(-2, now);
  const [{ data: daily }, { data: posts }] = await Promise.all([
    supabase
      .from("account_daily")
      .select("social_account_id, day, followers_count, social_accounts(display_name)")
      .in("day", [yesterday, dayBefore]),
    supabase
      .from("social_posts")
      .select("social_account_id, caption, permalink, post_metrics(views, collected_on)")
      .gte("posted_at", `${yesterday}T00:00:00+09:00`)
      .lt("posted_at", `${kstDate(0, now)}T00:00:00+09:00`),
  ]);
  if (!daily?.length) return [];

  const byAccount = new Map<string, YesterdayLine>();
  for (const d of daily) {
    const line = byAccount.get(d.social_account_id) ?? {
      account: d.social_accounts?.display_name ?? "",
      followers: null,
      delta: null,
      bestPost: null,
    };
    byAccount.set(d.social_account_id, line);
  }
  for (const [id, line] of byAccount) {
    const y = daily.find((d) => d.social_account_id === id && d.day === yesterday)?.followers_count ?? null;
    const b = daily.find((d) => d.social_account_id === id && d.day === dayBefore)?.followers_count ?? null;
    line.followers = y;
    line.delta = y != null && b != null ? y - b : null;
    for (const p of (posts ?? []).filter((x) => x.social_account_id === id)) {
      const views = Math.max(0, ...(p.post_metrics ?? []).map((m) => m.views ?? 0));
      if (!line.bestPost || views > line.bestPost.views) {
        line.bestPost = { caption: Array.from((p.caption ?? "").split("\n")[0]).slice(0, 40).join(""), views, permalink: p.permalink };
      }
    }
  }
  return [...byAccount.values()].sort((a, b) => a.account.localeCompare(b.account));
}

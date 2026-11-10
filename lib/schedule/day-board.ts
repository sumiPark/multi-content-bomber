import { isConfirmDue, isPastSlot } from "@/lib/automation/deadline";
import { addDays, kstDate, kstToIso } from "@/lib/automation/time";
import { cellStatus, type CellTone } from "@/lib/schedule/cell-status";
import type { getServerSupabase } from "@/lib/auth";

// 대시보드 — 놓치면 안 되는 경고 + 업로드 예정(2026-11-04 사용자 결정으로 할 일 칸 · 하루 칸 표는 뺐다).
//   경고: 멈춤(AI 자동 칸, 직접 촬영 편집 실패), 올리기 2시간 전 상품 확인, 계정 연결 끊김. 발행 실패는 위쪽 실패 줄이 따로 알린다.
//   완성본 확인 대기 · 멈춤 · 시각이 지났는데 아직 만드는 칸은 날짜가 지나도 남긴다(최근 14일, 2026-11-10 1차).
//   예정: 앞으로 7일의 AI 자동 칸 + 콘텐츠 생성에서 예약한 건.

type Supabase = Awaited<ReturnType<typeof getServerSupabase>>;

export interface BlockedItem {
  key: string;
  label: string;
  reason: string | null;
  href: string | null;
}

export interface DashboardAlerts {
  blocked: BlockedItem[];
  atRisk: BlockedItem[];
}

const HORIZON_DAYS = 7;
// 지난 칸을 얼마나 거슬러 올라가 남길지
const LOOKBACK_DAYS = 14;
const HOUR = 3_600_000;

function hoursLeft(ms: number): string {
  const h = Math.floor(ms / HOUR);
  return h >= 1 ? `${h}시간` : `${Math.max(1, Math.round(ms / 60_000))}분`;
}

function dayName(date: string, today: string): string {
  if (date === today) return "오늘";
  if (date === addDays(today, -1)) return "어제";
  if (date === addDays(today, 1)) return "내일";
  if (date === addDays(today, 2)) return "모레";
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

export async function loadDashboardAlerts(supabase: Supabase, now = Date.now()): Promise<DashboardAlerts> {
  const today = kstDate(0, now);
  const horizon = addDays(today, HORIZON_DAYS);

  const [{ data: plans }, { data: settings }, { data: rules }, { data: failedEdits }] = await Promise.all([
    supabase
      .from("content_plans")
      .select("id, social_account_id, slot_date, slot_time, status, note, error, publish_jobs(status), social_accounts(display_name)")
      .eq("track", "B")
      .gte("slot_date", addDays(today, -LOOKBACK_DAYS))
      .lte("slot_date", horizon),
    supabase.from("track_settings").select("social_account_id, shoot_enabled, social_accounts(display_name, is_active, disconnected_at)"),
    supabase.from("slot_rules").select("social_account_id").eq("track", "B").eq("active", true),
    supabase.from("shoot_requests").select("id, error, content_plans!inner(status, social_accounts(display_name))").eq("status", "FAILED").eq("content_plans.status", "SHOT"),
  ]);

  const blocked: BlockedItem[] = [];
  const atRisk: BlockedItem[] = [];

  for (const p of plans ?? []) {
    const date = p.slot_date as string;
    const time = p.slot_time as string;
    const past = isPastSlot(date, time, 0, now);
    const st = cellStatus({ status: p.status, jobStatus: p.publish_jobs?.status ?? null }, { date, time, active: true }, now);
    const name = `@${p.social_accounts?.display_name ?? ""} ${dayName(date, today)} ${time}`;
    // 지난 칸은 사람이 볼 것만 남긴다: 멈춤 · 완성본 확인 대기 · 시각이 지났는데 아직 만드는 칸
    if (past && !(p.status === "BLOCKED" || p.status === "RENDERED" || p.status === "CONFIRMED" || p.status === "SCRIPTED")) continue;
    if (!p.publish_jobs?.status && p.status === "RENDERED") {
      atRisk.push({ key: p.id, label: `${name} — 완성본 확인 대기`, reason: past ? "올릴 시각이 지났어요. 확인하면 바로 올라가요" : "보고 올리거나 다시 만들어 주세요", href: st.href });
    } else if (past && (p.status === "CONFIRMED" || p.status === "SCRIPTED")) {
      atRisk.push({ key: p.id, label: `${name} — ${st.label}`, reason: p.error ?? "올릴 시각이 지났어요. 만들어지면 확인 화면에 올라와요", href: st.href });
    } else if (st.task === "confirm") {
      // 올리기 2시간 전부터 알린다. 올릴 시각까지 확인이 없으면 그 칸은 건너뛴다
      if (isConfirmDue(date, time, now)) atRisk.push({ key: p.id, label: `${name} — 상품 확인 전`, reason: `올릴 시각까지 ${hoursLeft(Date.parse(kstToIso(date, time)) - now)}, 안 하면 이 칸은 건너뛰어요`, href: st.href });
    } else if (st.tone === "risk" && st.label !== "발행 실패") {
      blocked.push({ key: p.id, label: `${name} — ${st.label}`, reason: p.error ?? p.note ?? null, href: st.href });
    }
  }

  for (const r of failedEdits ?? []) {
    blocked.push({
      key: r.id,
      label: `@${r.content_plans.social_accounts?.display_name ?? ""} 직접 촬영 — 편집 실패`,
      reason: r.error,
      href: "/shoot/review",
    });
  }

  const inUse = new Set((rules ?? []).map((r) => r.social_account_id));
  for (const s of settings ?? []) {
    const acc = s.social_accounts;
    if (!acc || acc.disconnected_at || acc.is_active !== false) continue;
    if (!s.shoot_enabled && !inUse.has(s.social_account_id)) continue;
    atRisk.unshift({ key: `off-${s.social_account_id}`, label: `@${acc.display_name ?? ""} 연결이 끊겼어요`, reason: "다시 연결해야 기획과 발행이 이어져요", href: "/accounts" });
  }
  return { blocked, atRisk };
}

export interface UploadItem {
  key: string;
  at: string;
  account: string;
  // AI 자동 업로드인지(아니면 콘텐츠 생성에서 직접 예약)
  auto: boolean;
  subject: string | null;
  label: string;
  tone: CellTone;
  href: string | null;
}

export interface UploadSchedule {
  items: UploadItem[];
  total: number;
}

const UPLOAD_LIMIT = 15;

export async function loadUploadSchedule(supabase: Supabase, now = Date.now()): Promise<UploadSchedule> {
  const today = kstDate(0, now);
  const horizon = addDays(today, HORIZON_DAYS);
  const until = kstToIso(addDays(horizon, 1), "00:00");

  const [{ data: plans }, { data: jobs }] = await Promise.all([
    supabase
      .from("content_plans")
      .select("id, slot_date, slot_time, status, publish_job_id, products(name), publish_jobs(status), social_accounts(display_name, disconnected_at)")
      .eq("track", "B")
      .gte("slot_date", today)
      .lte("slot_date", horizon)
      .not("status", "in", "(SKIPPED,FAILED,PUBLISHED)"),
    supabase
      .from("publish_jobs")
      .select("id, status, scheduled_for, social_accounts!inner(display_name), contents!inner(internal_title, ai_captions)")
      .is("deleted_at", null)
      .in("status", ["PENDING", "RETRYING", "PROCESSING"])
      .not("scheduled_for", "is", null)
      .lt("scheduled_for", until)
      .order("scheduled_for"),
  ]);

  const items: UploadItem[] = [];
  const autoJobs = new Set<string>();
  for (const p of plans ?? []) {
    const date = p.slot_date as string;
    const time = p.slot_time as string;
    if (p.publish_job_id) autoJobs.add(p.publish_job_id);
    if (isPastSlot(date, time, 0, now) || p.social_accounts?.disconnected_at) continue;
    const st = cellStatus({ status: p.status, jobStatus: p.publish_jobs?.status ?? null }, { date, time, active: true }, now);
    if (st.label === "발행 취소" || st.label === "발행됨") continue;
    items.push({
      key: `plan-${p.id}`,
      at: kstToIso(date, time),
      account: p.social_accounts?.display_name ?? "",
      auto: true,
      subject: p.products?.name ?? null,
      label: st.label,
      tone: st.tone,
      href: st.href,
    });
  }

  for (const j of jobs ?? []) {
    if (autoJobs.has(j.id)) continue;
    const captions = j.contents.ai_captions as { instagram?: { caption?: string } } | null;
    items.push({
      key: `job-${j.id}`,
      at: j.scheduled_for as string,
      account: j.social_accounts.display_name ?? "",
      auto: false,
      subject: j.contents.internal_title ?? captions?.instagram?.caption?.split("\n")[0]?.slice(0, 60) ?? null,
      label: j.status === "PENDING" ? "예약됨" : "올리는 중",
      tone: j.status === "PENDING" ? "ok" : "wait",
      href: "/postings?status=scheduled",
    });
  }

  items.sort((a, b) => a.at.localeCompare(b.at));
  return { items: items.slice(0, UPLOAD_LIMIT), total: items.length };
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
  const today = kstDate(0, now);
  const yesterday = kstDate(-1, now);
  const dayBefore = kstDate(-2, now);
  const [{ data: daily }, { data: posts }] = await Promise.all([
    supabase
      .from("account_daily")
      .select("social_account_id, day, followers_count, social_accounts(display_name)")
      .in("day", [today, yesterday, dayBefore]),
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
    // account_daily는 수집한 날(새벽 04시) 행이다 — 오늘 행 − 어제 행이 "어제 하루" 증감. 예전엔 하루 밀려 그저께 증감을 보여 줬다.
    // 오늘 수집 전(04시 이전)이면 있는 것 중 최근 두 날로.
    const followersOn = (day: string) => daily.find((d) => d.social_account_id === id && d.day === day)?.followers_count ?? null;
    const latest = followersOn(today) ?? followersOn(yesterday);
    const previous = followersOn(today) != null ? followersOn(yesterday) : followersOn(dayBefore);
    line.followers = latest;
    line.delta = latest != null && previous != null ? latest - previous : null;
    for (const p of (posts ?? []).filter((x) => x.social_account_id === id)) {
      const views = Math.max(0, ...(p.post_metrics ?? []).map((m) => m.views ?? 0));
      if (!line.bestPost || views > line.bestPost.views) {
        line.bestPost = { caption: Array.from((p.caption ?? "").split("\n")[0]).slice(0, 40).join(""), views, permalink: p.permalink };
      }
    }
  }
  return [...byAccount.values()].sort((a, b) => a.account.localeCompare(b.account));
}

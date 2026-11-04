import { kstDate, kstToIso } from "@/lib/automation/time";
import type { ProductKind, ShopCode } from "@/lib/products/shops";
import { appendPublishHistory } from "@/lib/publish-history";
import type { createServiceClient } from "@/lib/supabase/service";

// 편성 관리(계정 넣기 · 빼기, 칸 시각 · 방식 바꾸기) — 2026-11-03 사용자 결정:
//   · 인스타 계정만. 계정당 하루 최대 4칸, 같은 계정 칸 사이 2시간 이상(숫자만 바꾸면 늘릴 수 있게 여기 둔다)
//   · AI 자동 칸은 08시 이후만 — 상품 확인 마감이 아직 "올리는 날 07시" 고정이라(영상 만들기 시간을 잰 뒤 다시 정함)
//   · 직접 촬영 촬영 마감(안내용)은 올리기 3시간 전
//   · 칸 시각을 바꾸면 앞으로의 기획도 새 시각으로 옮긴다(예약된 발행은 예약 시각도)
//   · 계정 · 칸을 빼면 앞으로의 기획 · 예약 발행을 모두 취소(화면에서 예약 건 경고 뒤). 지난 기록은 남긴다

type Service = ReturnType<typeof createServiceClient>;

export const MAX_SLOTS_PER_DAY = 4;
export const MIN_GAP_MINUTES = 120;
export const AUTO_EARLIEST = "08:00";
export const SHOOT_LEAD_HOURS = 3;

export interface ScopeOption {
  key: string;
  shop: ShopCode;
  kind: Exclude<ProductKind, "OTHER">;
  label: string;
}

export const SCOPE_OPTIONS: ScopeOption[] = [
  { key: "cuma:FRUIT", shop: "cuma", kind: "FRUIT", label: "오늘과일 과일" },
  { key: "cm:HEALTH_FOOD", shop: "cm", kind: "HEALTH_FOOD", label: "쿠마마켓 식품" },
  { key: "ru:COSMETIC", shop: "ru", kind: "COSMETIC", label: "리유 화장품" },
  { key: "ru:HEALTH_FOOD", shop: "ru", kind: "HEALTH_FOOD", label: "리유 건강식품" },
  { key: "ru:CLOTHING", shop: "ru", kind: "CLOTHING", label: "리유 의류" },
];

export function scopeLabel(s: { shop: string; kind: string }): string {
  return SCOPE_OPTIONS.find((o) => o.shop === s.shop && o.kind === s.kind)?.label ?? `${s.shop} ${s.kind}`;
}

export const TRACK_LABEL: Record<string, string> = { B: "AI 자동", A: "직접 촬영" };

/**
 * 화면 안내용 "08 · 21시" — 켜진 칸들의 시각을 모아 보여 준다. 계정마다 시각이 달라 많으면 많이 쓰는 4개 + "등".
 * 칸이 없으면 "칸 없음".
 */
export function trackTimesLabel(rules: { slot_time: string; track: string }[], track: "A" | "B"): string {
  const count = new Map<string, number>();
  for (const r of rules) if (r.track === track) count.set(r.slot_time, (count.get(r.slot_time) ?? 0) + 1);
  if (count.size === 0) return "칸 없음";
  const label = (t: string) => (t.endsWith(":00") ? t.slice(0, 2) : t);
  const top = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4).map(([t]) => t).sort();
  return `${top.map(label).join(" · ")}시${count.size > top.length ? " 등" : ""}`;
}

const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** 한 계정의 하루 칸이 규칙에 맞는지 — 맞으면 null, 아니면 사람이 읽는 이유. */
export function validateSlots(slots: { time: string; track: string }[]): string | null {
  if (slots.length > MAX_SLOTS_PER_DAY) return `계정당 하루 ${MAX_SLOTS_PER_DAY}칸까지예요.`;
  for (const s of slots) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) return `시각 형식이 올바르지 않아요 (${s.time}).`;
    if (s.track !== "A" && s.track !== "B") return "방식이 올바르지 않아요.";
    if (s.track === "B" && s.time < AUTO_EARLIEST)
      return `AI 자동 칸은 ${AUTO_EARLIEST} 이후만 고를 수 있어요 (상품 확인 마감이 올리는 날 07시라서).`;
  }
  const sorted = [...slots].sort((a, b) => a.time.localeCompare(b.time));
  for (let i = 0; sorted.length >= 2 && i < sorted.length; i++) {
    const cur = sorted[i];
    const next = sorted[(i + 1) % sorted.length];
    // 마지막 칸 → 다음 날 첫 칸(자정을 넘는 간격)도 본다
    const gap = i + 1 < sorted.length ? minutes(next.time) - minutes(cur.time) : minutes(next.time) + 1440 - minutes(cur.time);
    if (gap === 0) return `같은 시각(${cur.time}) 칸이 두 개예요.`;
    if (gap < MIN_GAP_MINUTES) return `${cur.time}와 ${next.time} 칸 사이가 ${MIN_GAP_MINUTES / 60}시간보다 가까워요.`;
  }
  return null;
}

/** 직접 촬영 촬영 마감(안내용) — 올리기 SHOOT_LEAD_HOURS시간 전. */
export function shootDueIso(slotDate: string, slotTime: string): string {
  return new Date(Date.parse(kstToIso(slotDate, slotTime)) - SHOOT_LEAD_HOURS * 3_600_000).toISOString();
}

// 아직 안 끝난 칸 — 이 상태의 앞으로 칸은 옮기거나 취소한다
const OPEN_STATUSES = ["PROPOSED", "CONFIRMED", "SCRIPTED", "SHOT", "RENDERED", "BLOCKED", "SCHEDULED"];

export interface FuturePlan {
  id: string;
  slot_date: string;
  slot_time: string;
  status: string;
  publish_job_id: string | null;
}

/** 올릴 시각이 아직 안 지난, 진행 중인 칸들. slotTime을 주면 그 시각 칸만. */
export async function futurePlans(service: Service, accountId: string, slotTime?: string, now = Date.now()): Promise<FuturePlan[]> {
  let q = service
    .from("content_plans")
    .select("id, slot_date, slot_time, status, publish_job_id")
    .eq("social_account_id", accountId)
    .gte("slot_date", kstDate(-1, now))
    .in("status", OPEN_STATUSES);
  if (slotTime) q = q.eq("slot_time", slotTime);
  const { data, error } = await q;
  if (error) throw new Error(`기획 조회 실패: ${error.message}`);
  return (data ?? []).filter((p) => Date.parse(kstToIso(p.slot_date, p.slot_time)) > now);
}

// 촬영 요청 중 아직 안 끝난 것 — 칸을 취소하면 함께 취소한다(편집 중 · 편집 끝 · 실패 포함, 2026-11-04)
const OPEN_REQUEST_STATUSES = ["OPEN", "UPLOADED", "EDITING", "EDITED", "FAILED"];

// 편성표에서 칸 · 계정을 빼며 취소한 기획의 메모 — 같은 칸을 다시 넣으면 이 기록을 지워 다시 기획되게 한다
export const SCHEDULE_CANCEL_NOTE_PREFIX = "편성";

/**
 * 앞으로의 칸 취소 — 기획은 건너뜀, 촬영 요청 취소, 예약 발행(워커가 아직 안 잡은 것) 취소.
 * 올리는 중(PROCESSING)인 발행은 막을 수 없어 그 칸은 그대로 두고 따로 센다(예전엔 칸만 "건너뜀"이 돼 실제와 달랐다).
 */
export async function cancelPlans(
  service: Service,
  plans: FuturePlan[],
  reason: string,
): Promise<{ plans: number; jobs: number; uploading: number }> {
  if (plans.length === 0) return { plans: 0, jobs: 0, uploading: 0 };
  const jobIds = plans.map((p) => p.publish_job_id).filter((x): x is string => !!x);
  const cancelledJobs = new Set<string>();
  const uploadingJobs = new Set<string>();
  if (jobIds.length) {
    const { data } = await service
      .from("publish_jobs")
      .update({ status: "CANCELLED", cancelled_at: new Date().toISOString() })
      .in("id", jobIds)
      // 워커가 이미 잡아 간(PROCESSING) 건은 건드리지 않는다 — 결과 기록에 덮인다
      .in("status", ["PENDING", "RETRYING"])
      .select("id");
    for (const r of data ?? []) cancelledJobs.add(r.id);
    if (cancelledJobs.size) await appendPublishHistory(service, [...cancelledJobs], { status: "CANCELLED", message: reason });
    const { data: rest } = await service.from("publish_jobs").select("id, status").in("id", jobIds.filter((id) => !cancelledJobs.has(id)));
    for (const r of rest ?? []) if (r.status === "PROCESSING") uploadingJobs.add(r.id);
  }
  const targets = plans.filter((p) => !p.publish_job_id || !uploadingJobs.has(p.publish_job_id));
  const ids = targets.map((p) => p.id);
  if (ids.length) {
    await service.from("shoot_requests").update({ status: "CANCELLED" }).in("plan_id", ids).in("status", OPEN_REQUEST_STATUSES);
    await service.from("content_plans").update({ status: "SKIPPED", note: reason }).in("id", ids);
  }
  return { plans: ids.length, jobs: cancelledJobs.size, uploading: uploadingJobs.size };
}

/**
 * 같은 칸(계정 · 시각)을 다시 넣거나 시각을 옮겨 올 때 — 앞서 편성표에서 빼며 취소한 앞으로의 기록을 지운다.
 * 같은 계정 · 날짜 · 시각에는 기획이 하나뿐이라, 남아 있으면 기획 워커가 "이미 기획됨"으로 보고 그 칸을 채우지 않았다.
 * 사람이 "건너뛰기"한 칸은 지우지 않는다(메모가 다르다).
 */
export async function clearScheduleCancelled(service: Service, accountId: string, slotTime: string, now = Date.now()): Promise<void> {
  const { data } = await service
    .from("content_plans")
    .select("id, slot_date, slot_time")
    .eq("social_account_id", accountId)
    .eq("slot_time", slotTime)
    .eq("status", "SKIPPED")
    .like("note", `${SCHEDULE_CANCEL_NOTE_PREFIX}%`)
    .gte("slot_date", kstDate(-1, now));
  const ids = (data ?? []).filter((p) => Date.parse(kstToIso(p.slot_date, p.slot_time)) > now).map((p) => p.id);
  if (ids.length) await service.from("content_plans").delete().in("id", ids);
}

/**
 * 칸 시각을 바꿀 때 앞으로의 기획을 새 시각으로 옮긴다 — 예약된 발행은 예약 시각도, 촬영 요청은 촬영 마감도.
 * 새 시각이 이미 지난 날(오늘 칸을 지금보다 이른 시각으로)이 있으면 옮기지 않고 이유를 돌려준다.
 */
export async function movePlans(
  service: Service,
  accountId: string,
  fromTime: string,
  toTime: string,
  now = Date.now(),
): Promise<{ ok: true; moved: number } | { ok: false; error: string }> {
  const plans = await futurePlans(service, accountId, fromTime, now);
  const pastNow = plans.filter((p) => Date.parse(kstToIso(p.slot_date, toTime)) <= now);
  if (pastNow.length) return { ok: false, error: `${pastNow[0].slot_date.slice(5)} 칸이 이미 지난 시각(${toTime})이 돼요. 그 칸이 끝난 뒤 바꿔 주세요.` };
  // 지금 올리는 중인 발행이 있으면 하나도 옮기지 않는다 — 예전엔 일부만 옮기고 칸 시각은 그대로라
  // 다음 기획이 옛 시각에 또 생겨 그날 두 번 올라갈 수 있었다(2026-11-04)
  const jobIds = plans.map((p) => p.publish_job_id).filter((x): x is string => !!x);
  const { data: jobs } = jobIds.length ? await service.from("publish_jobs").select("id, status").in("id", jobIds) : { data: [] };
  const jobStatus = new Map((jobs ?? []).map((j) => [j.id, j.status]));
  const busy = plans.find((p) => p.publish_job_id && jobStatus.get(p.publish_job_id) === "PROCESSING");
  if (busy) return { ok: false, error: `${busy.slot_date.slice(5)} 칸이 지금 올리는 중이에요. 다 올라간 뒤 바꿔 주세요.` };
  // 편성표에서 빼며 취소했던 새 시각 칸의 기록은 지운다(옮길 자리를 비운다)
  await clearScheduleCancelled(service, accountId, toTime, now);
  // 새 시각에 남아 있는 예전 기록(건너뛴 칸 등)과 겹치면 옮길 수 없다(같은 계정 · 날짜 · 시각은 하나뿐)
  if (plans.length) {
    const { data: clash } = await service
      .from("content_plans")
      .select("slot_date")
      .eq("social_account_id", accountId)
      .eq("slot_time", toTime)
      .in("slot_date", plans.map((p) => p.slot_date));
    if (clash?.length) return { ok: false, error: `${clash[0].slot_date.slice(5)} ${toTime}에 예전 기록이 있어 옮길 수 없어요. 다른 시각을 골라 주세요.` };
  }
  for (const p of plans) {
    const { error: planErr } = await service.from("content_plans").update({ slot_time: toTime }).eq("id", p.id);
    if (planErr) return { ok: false, error: `${p.slot_date.slice(5)} 칸을 옮기지 못했어요: ${planErr.message}` };
    const status = p.publish_job_id ? jobStatus.get(p.publish_job_id) : null;
    if (p.publish_job_id && (status === "PENDING" || status === "RETRYING")) {
      await service.from("publish_jobs").update({ scheduled_for: kstToIso(p.slot_date, toTime) }).eq("id", p.publish_job_id).in("status", ["PENDING", "RETRYING"]);
      await appendPublishHistory(service, [p.publish_job_id], { status, message: `편성표에서 시각 변경 ${fromTime} → ${toTime}` });
    }
    await service.from("shoot_requests").update({ due_at: shootDueIso(p.slot_date, toTime) }).eq("plan_id", p.id).in("status", ["OPEN", "UPLOADED"]);
  }
  return { ok: true, moved: plans.length };
}

/** 계정의 앞으로 칸 개수 — 빼기 전 경고에 쓴다. */
export async function futureCounts(service: Service, accountId: string, slotTime?: string): Promise<{ plans: number; scheduled: number }> {
  const plans = await futurePlans(service, accountId, slotTime);
  return { plans: plans.length, scheduled: plans.filter((p) => p.status === "SCHEDULED").length };
}

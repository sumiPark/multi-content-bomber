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

/** 앞으로의 칸 취소 — 기획은 건너뜀, 촬영 요청 취소, 예약 발행(워커가 아직 안 잡은 것) 취소. */
export async function cancelPlans(service: Service, plans: FuturePlan[], reason: string): Promise<{ plans: number; jobs: number }> {
  if (plans.length === 0) return { plans: 0, jobs: 0 };
  const ids = plans.map((p) => p.id);
  const jobIds = plans.map((p) => p.publish_job_id).filter((x): x is string => !!x);
  let jobs = 0;
  if (jobIds.length) {
    const { data } = await service
      .from("publish_jobs")
      .update({ status: "CANCELLED", cancelled_at: new Date().toISOString() })
      .in("id", jobIds)
      // 워커가 이미 잡아 간(PROCESSING) 건은 건드리지 않는다 — 결과 기록에 덮인다
      .in("status", ["PENDING", "RETRYING"])
      .select("id");
    const cancelled = (data ?? []).map((r) => r.id);
    if (cancelled.length) await appendPublishHistory(service, cancelled, { status: "CANCELLED", message: reason });
    jobs = cancelled.length;
  }
  await service.from("shoot_requests").update({ status: "CANCELLED" }).in("plan_id", ids).in("status", ["OPEN", "UPLOADED"]);
  await service.from("content_plans").update({ status: "SKIPPED", note: reason }).in("id", ids);
  return { plans: ids.length, jobs };
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
  const processing: string[] = [];
  for (const p of plans) {
    if (p.publish_job_id) {
      const { data: job } = await service.from("publish_jobs").select("status").eq("id", p.publish_job_id).maybeSingle();
      if (job?.status === "PROCESSING") {
        processing.push(p.slot_date);
        continue;
      }
      if (job && (job.status === "PENDING" || job.status === "RETRYING")) {
        await service.from("publish_jobs").update({ scheduled_for: kstToIso(p.slot_date, toTime) }).eq("id", p.publish_job_id);
        await appendPublishHistory(service, [p.publish_job_id], { status: job.status, message: `편성표에서 시각 변경 ${fromTime} → ${toTime}` });
      }
    }
    await service.from("content_plans").update({ slot_time: toTime }).eq("id", p.id);
    await service.from("shoot_requests").update({ due_at: shootDueIso(p.slot_date, toTime) }).eq("plan_id", p.id).in("status", ["OPEN", "UPLOADED"]);
  }
  if (processing.length) return { ok: false, error: `${processing[0].slice(5)} 칸은 지금 올리는 중이라 옮기지 못했어요. 나머지는 옮겼어요.` };
  return { ok: true, moved: plans.length };
}

/** 계정의 앞으로 칸 개수 — 빼기 전 경고에 쓴다. */
export async function futureCounts(service: Service, accountId: string, slotTime?: string): Promise<{ plans: number; scheduled: number }> {
  const plans = await futurePlans(service, accountId, slotTime);
  return { plans: plans.length, scheduled: plans.filter((p) => p.status === "SCHEDULED").length };
}

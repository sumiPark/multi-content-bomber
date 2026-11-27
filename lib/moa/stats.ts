import { kstDate } from "@/lib/automation/time";
import type { createServiceClient } from "@/lib/supabase/service";

// 모아링크 통계 — 일별 합계(moa_daily_page_stats · moa_daily_block_stats)를 기간으로 더한다.
// 오늘 숫자는 15분마다 합계를 다시 계산하지만, 화면을 열 때 오늘 것을 한 번 더 계산해 바로 보이게 한다.
//   페이지 클릭 전환율 = 하나 이상 누른 방문 ÷ 방문
//   블록 클릭률       = 누른 방문 ÷ 그 블록이 화면에 보인 방문

type Service = ReturnType<typeof createServiceClient>;

export interface PageTotals {
  views: number;
  visits: number;
  clicks: number;
  clickVisits: number;
}

export interface DayPoint extends PageTotals {
  day: string;
  visitors: number;
}

export interface BlockTotals {
  blockId: string;
  impressions: number;
  clicks: number;
  clickVisits: number;
}

export const EMPTY_TOTALS: PageTotals = { views: 0, visits: 0, clicks: 0, clickVisits: 0 };

export function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

export function formatRate(r: number | null): string {
  return r == null ? "—" : `${(r * 100).toFixed(1)}%`;
}

export function rangeStart(days: number): string {
  return kstDate(-(days - 1));
}

/** 오늘 합계를 지금 다시 계산 (실패해도 화면은 15분 전 합계로 그린다) */
export async function rollupToday(service: Service) {
  const { error } = await service.rpc("moa_rollup_day", { p_day: kstDate(0) });
  if (error) console.error("[moa] 오늘 합계 계산 실패:", error.message);
}

/** 여러 페이지의 기간 합계 (목록 화면 비교용) */
export async function pageTotals(service: Service, pageIds: string[], fromDay: string): Promise<Map<string, PageTotals>> {
  const out = new Map<string, PageTotals>();
  if (pageIds.length === 0) return out;
  const { data, error } = await service
    .from("moa_daily_page_stats")
    .select("page_id, views, visits, clicks, click_visits")
    .in("page_id", pageIds)
    .gte("day", fromDay);
  if (error) throw new Error(`통계 조회 실패: ${error.message}`);
  for (const r of data ?? []) {
    const t = out.get(r.page_id) ?? { ...EMPTY_TOTALS };
    t.views += r.views;
    t.visits += r.visits;
    t.clicks += r.clicks;
    t.clickVisits += r.click_visits;
    out.set(r.page_id, t);
  }
  return out;
}

/** 한 페이지의 기간 통계 — 날짜별 · 유입 경로별 · 블록별 */
export async function pageDetailStats(service: Service, pageId: string, fromDay: string) {
  const [{ data: pageRows, error: e1 }, { data: blockRows, error: e2 }] = await Promise.all([
    service
      .from("moa_daily_page_stats")
      .select("day, source, views, visits, visitors, clicks, click_visits")
      .eq("page_id", pageId)
      .gte("day", fromDay),
    service
      .from("moa_daily_block_stats")
      .select("block_id, impressions, clicks, click_visits")
      .eq("page_id", pageId)
      .gte("day", fromDay),
  ]);
  if (e1 || e2) throw new Error(`통계 조회 실패: ${(e1 ?? e2)?.message}`);

  const totals = { ...EMPTY_TOTALS };
  const byDay = new Map<string, DayPoint>();
  const bySource = new Map<string, PageTotals>();
  for (const r of pageRows ?? []) {
    totals.views += r.views;
    totals.visits += r.visits;
    totals.clicks += r.clicks;
    totals.clickVisits += r.click_visits;
    const d = byDay.get(r.day) ?? { day: r.day, ...EMPTY_TOTALS, visitors: 0 };
    d.views += r.views;
    d.visits += r.visits;
    d.visitors += r.visitors;
    d.clicks += r.clicks;
    d.clickVisits += r.click_visits;
    byDay.set(r.day, d);
    const s = bySource.get(r.source) ?? { ...EMPTY_TOTALS };
    s.views += r.views;
    s.visits += r.visits;
    s.clicks += r.clicks;
    s.clickVisits += r.click_visits;
    bySource.set(r.source, s);
  }

  const byBlock = new Map<string, BlockTotals>();
  for (const r of blockRows ?? []) {
    const b = byBlock.get(r.block_id) ?? { blockId: r.block_id, impressions: 0, clicks: 0, clickVisits: 0 };
    b.impressions += r.impressions;
    b.clicks += r.clicks;
    b.clickVisits += r.click_visits;
    byBlock.set(r.block_id, b);
  }

  return {
    totals,
    days: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    sources: [...bySource.entries()].map(([source, t]) => ({ source, ...t })).sort((a, b) => b.visits - a.visits),
    blocks: [...byBlock.values()],
  };
}

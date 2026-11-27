"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatRate, rate } from "@/lib/moa/stats";
import { SOURCE_LABEL } from "@/lib/moa/track-labels";
import { BLOCK_KIND_LABEL } from "@/lib/moa/types";
import type { MoaStatsView } from "./moa-editor";

// 통계 — 몇 번 눌렀는지(클릭수)와 본 사람 중 몇 %가 눌렀는지(클릭률)를 나눠 보여 준다.
//   클릭 전환율 = 하나 이상 누른 방문 ÷ 방문
//   블록 클릭률 = 누른 방문 ÷ 그 블록이 화면에 보인 방문 (아래쪽이라 못 본 방문은 빼고 비교)

const RANGES = [
  { days: 1, label: "오늘" },
  { days: 7, label: "7일" },
  { days: 30, label: "30일" },
  { days: 90, label: "90일" },
];

export function MoaStats({ pageId, stats }: { pageId: string; stats: MoaStatsView }) {
  const t = stats.totals;
  const blockRows = stats.blockMeta
    .filter((m) => m.kind !== "HEADING")
    .map((m) => {
      const s = stats.blocks.find((b) => b.blockId === m.id) ?? { impressions: 0, clicks: 0, clickVisits: 0 };
      return { ...m, ...s, ctr: rate(s.clickVisits, s.impressions) };
    })
    // 지운 블록은 기간 안 기록이 있을 때만
    .filter((r) => !r.deleted || r.impressions > 0 || r.clicks > 0)
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
  const maxViews = Math.max(1, ...stats.daily.map((d) => d.views));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav className="inline-flex items-center rounded-md border bg-surface-2 p-[2px]" aria-label="기간">
          {RANGES.map((r) => (
            <Link
              key={r.days}
              href={`/moa/${pageId}?tab=stats&days=${r.days}`}
              aria-current={r.days === stats.days ? "page" : undefined}
              className={cn(
                "inline-flex h-[30px] items-center rounded-[6px] px-3 text-xs font-medium text-muted-foreground hover:text-foreground",
                r.days === stats.days && "bg-card font-semibold text-foreground shadow-[0_1px_2px_rgb(16_24_40/0.12)]",
              )}
            >
              {r.label}
            </Link>
          ))}
        </nav>
        <p className="text-xs text-muted-foreground">한국 날짜 기준 · 15분마다 집계(열 때 오늘 것을 다시 집계) · 원본 기록 90일 보관</p>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="조회수" value={t.views} sub="페이지가 열린 횟수" />
        <Kpi label="방문" value={t.visits} sub="브라우저 탭 하나 = 방문 하나" />
        <Kpi label="클릭" value={t.clicks} sub="링크 · 상품 · 배너를 누른 전체 횟수" />
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs text-muted-foreground">클릭 전환율</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{formatRate(rate(t.clickVisits, t.visits))}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">하나 이상 누른 방문 {t.clickVisits.toLocaleString("ko-KR")} ÷ 방문</p>
        </div>
      </section>

      {stats.days > 1 && (
        <section className="rounded-lg border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold">날짜별 조회수 · 클릭</h2>
          {stats.daily.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">이 기간에 집계된 방문이 없어요.</p>
          ) : (
            <div className="space-y-1.5">
              {stats.daily.map((d) => (
                <div key={d.day} className="grid grid-cols-[72px_1fr_120px] items-center gap-3 text-xs">
                  <span className="text-muted-foreground tabular-nums">{d.day.slice(5).replace("-", ".")}</span>
                  <div className="h-4 overflow-hidden rounded bg-surface-2">
                    <div className="h-full rounded bg-primary/70" style={{ width: `${(d.views / maxViews) * 100}%` }} />
                  </div>
                  <span className="text-right tabular-nums">
                    조회 {d.views.toLocaleString("ko-KR")} · 클릭 {d.clicks.toLocaleString("ko-KR")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="overflow-x-auto rounded-lg border bg-card">
        <h2 className="px-4 pt-4 text-sm font-semibold">블록별 성과</h2>
        <p className="px-4 pt-1 text-xs text-muted-foreground">클릭률 = 누른 방문 ÷ 화면에 보인 방문. 같은 방문에서 여러 번 누른 것은 클릭 수에만 더해요.</p>
        <table className="mt-3 w-full min-w-[640px] text-sm">
          <thead className="bg-surface-2 text-left text-xs text-muted-foreground">
            <tr>
              <th className="h-11 px-3.5 font-medium">블록</th>
              <th className="px-3.5 font-medium">종류</th>
              <th className="px-3.5 text-right font-medium">노출 (방문)</th>
              <th className="px-3.5 text-right font-medium">클릭</th>
              <th className="px-3.5 text-right font-medium">누른 방문</th>
              <th className="px-3.5 text-right font-medium">클릭률</th>
            </tr>
          </thead>
          <tbody>
            {blockRows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3.5 py-8 text-center text-muted-foreground">
                  아직 기록이 없어요.
                </td>
              </tr>
            )}
            {blockRows.map((r) => (
              <tr key={r.id} className="h-[52px] border-t">
                <td className="px-3.5">
                  <span className="font-medium">{r.name || BLOCK_KIND_LABEL[r.kind]}</span>
                  {r.deleted && (
                    <Badge variant="secondary" className="ml-1.5">
                      지움
                    </Badge>
                  )}
                </td>
                <td className="px-3.5 text-xs text-muted-foreground">{r.inAutoSection ? "최근 소개한 상품" : BLOCK_KIND_LABEL[r.kind]}</td>
                <td className="px-3.5 text-right tabular-nums">{r.impressions.toLocaleString("ko-KR")}</td>
                <td className="px-3.5 text-right tabular-nums">{r.clicks.toLocaleString("ko-KR")}</td>
                <td className="px-3.5 text-right tabular-nums">{r.clickVisits.toLocaleString("ko-KR")}</td>
                <td className="px-3.5 text-right font-semibold tabular-nums">{formatRate(r.ctr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="overflow-x-auto rounded-lg border bg-card">
        <h2 className="px-4 pt-4 text-sm font-semibold">유입 경로</h2>
        <p className="px-4 pt-1 text-xs text-muted-foreground">인스타 · 스레드 · 페이스북 · 카카오톡 앱 안에서 열린 방문은 앱 정보로 구분해요. 어느 릴스에서 왔는지는 프로필 링크만으로는 알 수 없어요.</p>
        <table className="mt-3 w-full min-w-[520px] text-sm">
          <thead className="bg-surface-2 text-left text-xs text-muted-foreground">
            <tr>
              <th className="h-11 px-3.5 font-medium">경로</th>
              <th className="px-3.5 text-right font-medium">방문</th>
              <th className="px-3.5 text-right font-medium">클릭</th>
              <th className="px-3.5 text-right font-medium">클릭 전환율</th>
            </tr>
          </thead>
          <tbody>
            {stats.sources.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3.5 py-8 text-center text-muted-foreground">
                  아직 기록이 없어요.
                </td>
              </tr>
            )}
            {stats.sources.map((s) => (
              <tr key={s.source} className="h-[52px] border-t">
                <td className="px-3.5">{SOURCE_LABEL[s.source] ?? s.source}</td>
                <td className="px-3.5 text-right tabular-nums">{s.visits.toLocaleString("ko-KR")}</td>
                <td className="px-3.5 text-right tabular-nums">{s.clicks.toLocaleString("ko-KR")}</td>
                <td className="px-3.5 text-right tabular-nums">{formatRate(rate(s.clickVisits, s.visits))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: number; sub: string }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value.toLocaleString("ko-KR")}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}

import { Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { RelativeTime } from "@/components/ui/relative-time";
import type { BenchmarkInsight as Insight } from "@/lib/benchmark/load";
import type { StyleDimension, StyleStandout } from "@/lib/benchmark/style-stats";

// 잘된 릴스 종합 분석 — 왜 잘됐을지 · 어떤 특징이 있는지 · 영상 스타일.
// 비율은 코드가 센 값이고, 문장만 AI가 썼다. 잘된 릴스와 같은 계정의 평소 릴스를 나란히 둔다. 서버 컴포넌트.

// 영상을 직접 본 잘된 릴스가 이보다 적으면 표본이 적다고 먼저 알린다 (style-stats의 특징 판단 기준과 같다)
const MIN_VIDEOS = 8;

const pct = (n: number, total: number) => (total ? Math.round((n / total) * 100) : 0);

function CompareBar({ label, n, total, strong }: { label: string; n: number; total: number; strong?: boolean }) {
  return (
    <div className="grid grid-cols-[56px_minmax(0,1fr)_56px] items-center gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="h-2 overflow-hidden rounded-full bg-surface-3">
        <span className={strong ? "block h-full rounded-full bg-primary" : "block h-full rounded-full bg-faint"} style={{ width: `${pct(n, total)}%` }} />
      </span>
      <span className="text-right font-semibold tabular-nums">
        {n}/{total}개
      </span>
    </div>
  );
}

function StyleRow({ d }: { d: StyleDimension }) {
  const top = d.values[0];
  const normalTop = [...d.values].sort((a, b) => b.normal - a.normal)[0];
  if (!top) return null;
  return (
    <tr className="border-t">
      <th scope="row" className="py-2 pr-3 text-left text-xs font-medium whitespace-nowrap text-muted-foreground">
        {d.label}
      </th>
      <td className="py-2 pr-3 text-sm font-semibold">
        {top.value} <span className="font-normal text-muted-foreground tabular-nums">{top.hit}/{d.hitTotal}</span>
      </td>
      <td className="py-2 text-sm text-ink-2">
        {normalTop.normal > 0 ? (
          <>
            {normalTop.value} <span className="text-muted-foreground tabular-nums">{normalTop.normal}/{d.normalTotal}</span>
          </>
        ) : (
          "-"
        )}
      </td>
    </tr>
  );
}

export function BenchmarkInsightPanel({ insight, hasHits }: { insight: Insight | null; hasHits: boolean }) {
  if (!insight) {
    return (
      <section aria-label="잘된 릴스 종합 분석" className="rounded-lg border border-dashed bg-card p-4">
        <h2 className="flex items-center gap-1.5 text-base font-semibold">
          <Sparkles className="size-4 text-primary" aria-hidden />
          잘된 릴스 종합 분석
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {hasHits ? "잘된 릴스의 영상을 분석하는 중이에요. 매일 05:30에 이어서 분석해요." : "비교 계정에서 잘된 릴스가 5개 넘게 모이면 종합 분석을 써 드려요."}
        </p>
      </section>
    );
  }

  const { stats, summary, createdAt } = insight;
  const standouts = new Map<string, StyleStandout>(stats.standouts.map((s) => [s.id, s]));
  const videos = stats.hits.video + stats.normals.video;
  const covers = stats.hits.cover + stats.normals.cover;
  const dimensions = stats.dimensions.filter((d) => d.values.some((v) => v.hit > 0));

  return (
    <section aria-label="잘된 릴스 종합 분석" className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="flex items-center gap-1.5 text-base font-semibold">
          <Sparkles className="size-4 text-primary" aria-hidden />
          잘된 릴스 종합 분석
        </h2>
        <p className="text-xs text-muted-foreground tabular-nums">
          잘된 릴스 {stats.hits.total}개와 같은 계정의 평소 릴스 {stats.normals.total}개 비교 · <RelativeTime iso={createdAt} format="date" />
        </p>
      </div>

      <p className="rounded-md bg-brand-soft px-3 py-2.5 text-[15px] font-semibold">{summary.headline}</p>

      {stats.hits.video < MIN_VIDEOS && (
        <p className="text-xs text-warn">
          잘된 릴스 {stats.hits.total}개 중 영상을 직접 본 건 {stats.hits.video}개뿐이에요. 나머지는 표지와 캡션만 봐서 특징을 판단하기엔 적어요.
        </p>
      )}

      {summary.points.length > 0 && (
        <ul className="grid gap-3 lg:grid-cols-2">
          {summary.points.map((p) => {
            const s = standouts.get(p.standoutId);
            return (
              <li key={p.standoutId} className="space-y-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  {s && <Badge variant="secondary">{s.label}: {s.value}</Badge>}
                </div>
                <p className="text-sm font-semibold">{p.title}</p>
                {s && (
                  <div className="space-y-1">
                    <CompareBar label="잘된 릴스" n={s.hit} total={s.hitTotal} strong />
                    <CompareBar label="평소 릴스" n={s.normal} total={s.normalTotal} />
                  </div>
                )}
                <p className="text-sm text-ink-2">{p.detail}</p>
                {p.apply && (
                  <p className="rounded-md bg-surface-2 px-2.5 py-1.5 text-sm">
                    <b className="font-semibold">시험해 볼 일:</b> {p.apply}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <details className="rounded-md bg-surface-2 px-3 py-2.5" open={summary.points.length === 0}>
        <summary className="cursor-pointer text-sm font-semibold">영상 스타일 자세히</summary>
        {summary.styleSummary && <p className="mt-2 text-sm text-ink-2">{summary.styleSummary}</p>}
        {dimensions.length > 0 && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[420px]">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="py-1 pr-3 font-medium">항목</th>
                <th scope="col" className="py-1 pr-3 font-medium">잘된 릴스에 가장 많은 것</th>
                <th scope="col" className="py-1 font-medium">평소 릴스에 가장 많은 것</th>
              </tr>
            </thead>
            <tbody>
              {dimensions.map((d) => (
                <StyleRow key={d.key} d={d} />
              ))}
            </tbody>
          </table>
        </div>
        )}
      </details>

      <p className="text-xs text-muted-foreground">
        영상을 본 릴스 {videos}개, 표지와 캡션만 본 릴스 {covers}개예요. 인스타가 영상 주소를 안 주는 릴스(저작권 음원이 든 릴스 등)는 표지만 봐서, 영상 스타일은 음악 위주 릴스가 덜 반영돼요. 영상은 분석 뒤 바로 지우고 저장하지 않아요.
        {summary.caution && ` ${summary.caution}`} 많이 나왔다고 그게 원인인 건 아니니 시험해 보고 판단하세요.
      </p>
    </section>
  );
}

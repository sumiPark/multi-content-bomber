import { Badge } from "@/components/ui/badge";
import { RelativeTime } from "@/components/ui/relative-time";
import type { PostAnalysis } from "@/lib/post-analysis/load";
import { cn } from "@/lib/utils";

// 데이터가 말하는 것 — 핵심 한 줄 → 숫자와 결론 → 할 일. 설명과 주의점은 접어 둔다.


export function PostFindings({ analysis }: { analysis: PostAnalysis | null }) {
  const caveats = (analysis?.findings ?? []).flatMap((f) => (f.caveat ? [f.caveat] : []));
  return (
    <section aria-label="데이터가 말하는 것" className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-semibold">데이터가 말하는 것</h2>
        {analysis && (
          <p className="shrink-0 text-xs text-muted-foreground">
            <RelativeTime iso={analysis.createdAt} format="date" /> · 게시물 {analysis.reels.toLocaleString("ko-KR")}개 전체 기준
          </p>
        )}
      </div>

      {!analysis ? (
        <p className="text-[13px] text-muted-foreground">지난 게시물을 다 읽으면 해석을 써 드려요. 일주일에 한 번 새로 써요.</p>
      ) : (
        <>
          {analysis.headline && <p className="rounded-md bg-brand-soft px-3 py-2.5 text-[15px] font-semibold text-foreground">{analysis.headline}</p>}

          <ul className="divide-y">
            {analysis.findings.map((f, i) => (
              <li key={i} className={cn("py-2.5 first:pt-0 last:pb-0", f.stat && "grid grid-cols-[92px_minmax(0,1fr)] gap-3")}>
                {f.stat && <p className="text-[15px] leading-snug font-bold break-keep tabular-nums">{f.stat}</p>}
                <div>
                  <p className="text-sm font-semibold">{f.title}</p>
                  <p className="mt-0.5 text-[13px] text-ink-2">{f.detail}</p>
                </div>
              </li>
            ))}
          </ul>

          {analysis.actions.length > 0 && (
            <ul className="space-y-1.5 rounded-md bg-surface-2 px-3 py-2.5">
              {analysis.actions.map((a, i) => (
                <li key={i} className="flex items-start gap-2 text-[13px]">
                  <Badge variant={a.label === "더 만들 것" ? "default" : "outline"} className="w-[76px]">
                    {a.label}
                  </Badge>
                  <span className="min-w-0 pt-0.5">{a.text}</span>
                </li>
              ))}
            </ul>
          )}

          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer font-medium">믿을 때 주의할 점</summary>
            <ul className="mt-1.5 list-disc space-y-1 pl-4">
              {caveats.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
              <li>숫자는 코드가 계산했고 해석만 AI가 썼어요. 통계에 없는 숫자가 든 문장은 자동으로 뺐어요.</li>
              <li>시기가 겹친다고 원인인 건 아니에요. 위에서 기간을 바꿔도 이 글은 그대로예요.</li>
            </ul>
          </details>
        </>
      )}
    </section>
  );
}

import { AlertTriangle, Loader2, ScanSearch } from "lucide-react";
import { CopyButton } from "@/components/account-review/copy-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RelativeTime } from "@/components/ui/relative-time";
import type { ReviewItem, ReviewRewrite, ReviewStatus } from "@/lib/account-review/types";
import { cn } from "@/lib/utils";

// 계정 점검 — 프로필 점수 결과 (점수 · 12개 항목 · 고칠 순서). 서버 컴포넌트.

export interface ReviewRow {
  id: string;
  status: ReviewStatus;
  total_score: number | null;
  rescore: number | null;
  items: ReviewItem[] | null;
  rewrites: ReviewRewrite[] | null;
  summary: string | null;
  snapshot: unknown;
  manual_input: unknown;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

// 색만으로 전달하지 않게 글자도 함께 (DESIGN.md 1-4)
function level(score: number | null, max: number): { label: string; bar: string; text: string } {
  if (score == null) return { label: "정보 없음", bar: "bg-surface-3", text: "text-muted-foreground" };
  const r = score / max;
  if (r < 0.4) return { label: "많이 깎임", bar: "bg-risk", text: "text-risk" };
  if (r < 0.75) return { label: "조금 깎임", bar: "bg-warn", text: "text-warn" };
  return { label: "좋음", bar: "bg-ok", text: "text-ok" };
}

export function ProfileReviewView({
  latest,
  history,
  busy,
  failed,
}: {
  latest: ReviewRow | null;
  history: ReviewRow[];
  busy: boolean;
  failed: ReviewRow | null;
}) {
  const done = history.filter((r) => r.status === "DONE" && r.total_score != null);
  const previous = latest ? done.find((r) => r.id !== latest.id && Date.parse(r.created_at) < Date.parse(latest.created_at)) : null;
  const delta = latest?.total_score != null && previous?.total_score != null ? latest.total_score - previous.total_score : null;
  const items = latest?.items ?? [];
  const rewrites = latest?.rewrites ?? [];

  return (
    <div className="min-w-0 space-y-4">
      {busy && (
        <div className="flex items-center gap-2 rounded-lg bg-brand-soft px-4 py-3 text-sm text-ink-2">
          <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
          채점 중이에요. 1~2분 뒤 새로고침하세요.
        </div>
      )}
      {failed && !busy && (
        <div className="flex items-start gap-2 rounded-lg bg-risk-soft px-4 py-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-risk" aria-hidden />
          <div>
            <p className="font-semibold text-risk">마지막 채점이 실패했어요</p>
            <p className="mt-0.5 text-ink-2">{failed.error ?? "이유를 알 수 없어요."} 고친 뒤 오른쪽에서 다시 채점하세요.</p>
          </div>
        </div>
      )}

      {!latest ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <ScanSearch className="size-10 text-muted-foreground" aria-hidden />
            <h2 className="text-lg font-semibold">아직 채점한 적이 없어요</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              오른쪽에 하이라이트 · 고정 게시물처럼 인스타가 알려 주지 않는 정보를 넣고 <b>채점하기</b>를 누르세요.
              비워 둔 칸은 0점으로 세요.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardContent className="flex flex-wrap items-start gap-x-8 gap-y-4 py-5">
              <div>
                <p className="text-xs font-medium text-muted-foreground">프로필 점수</p>
                <p className="mt-1 text-2xl font-bold tabular-nums">
                  {latest.total_score}
                  <span className="text-base font-semibold text-muted-foreground">/100</span>
                </p>
                {delta != null && (
                  <p className={cn("mt-0.5 text-xs font-medium tabular-nums", delta > 0 ? "text-ok" : delta < 0 ? "text-risk" : "text-muted-foreground")}>
                    지난번보다 {delta > 0 ? `${delta}점 올랐어요` : delta < 0 ? `${-delta}점 내렸어요` : "그대로예요"}
                  </p>
                )}
              </div>
              {latest.rescore != null && latest.rescore > (latest.total_score ?? 0) && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">아래 문구를 넣으면 (예상)</p>
                  <p className="mt-1 text-2xl font-bold text-primary tabular-nums">
                    {latest.rescore}
                    <span className="text-base font-semibold text-muted-foreground">/100</span>
                  </p>
                </div>
              )}
              <div className="min-w-[240px] flex-1">
                <p className="text-xs text-muted-foreground">
                  {latest.finished_at && <RelativeTime iso={latest.finished_at} />} 채점
                </p>
                {latest.summary && <p className="mt-1 max-w-2xl text-sm text-ink-2">{latest.summary}</p>}
                {done.length > 1 && (
                  <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    지난 점수
                    {done
                      .filter((r) => r.id !== latest.id)
                      .map((r) => (
                        <Badge key={r.id} variant="secondary" className="tabular-nums">
                          {r.total_score}점 · <RelativeTime iso={r.created_at} format="date" />
                        </Badge>
                      ))}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>항목별 점수</CardTitle>
              <p className="text-[13px] text-muted-foreground">
                <b>규칙</b>은 글자 수 · 개수처럼 정해진 기준으로 매겨 다시 채점해도 같은 점수가 나와요. <b>AI 판단</b>은
                기준표와 사진을 보고 AI가 매겨요.
              </p>
            </CardHeader>
            <CardContent className="overflow-x-auto px-0">
              <table className="w-full min-w-[640px] text-[13px]">
                <thead className="bg-surface-2 text-xs text-muted-foreground">
                  <tr className="h-11 text-left">
                    <th className="px-3.5 font-medium">항목</th>
                    <th className="w-40 px-3.5 font-medium">점수</th>
                    <th className="w-24 px-3.5 font-medium">채점</th>
                    <th className="px-3.5 font-medium">근거</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => {
                    const lv = level(it.score, it.max);
                    return (
                      <tr key={it.id} className="border-t align-top">
                        <td className="px-3.5 py-3 font-medium whitespace-nowrap">{it.label}</td>
                        <td className="px-3.5 py-3">
                          <div className="flex items-center gap-2">
                            <span className="w-12 font-semibold tabular-nums">
                              {it.score ?? "-"}/{it.max}
                            </span>
                            <span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-3" aria-hidden>
                              <span className={cn("block h-full", lv.bar)} style={{ width: `${((it.score ?? 0) / it.max) * 100}%` }} />
                            </span>
                          </div>
                          <span className={cn("text-xs", lv.text)}>{lv.label}</span>
                        </td>
                        <td className="px-3.5 py-3">
                          <Badge variant={it.auto ? "secondary" : "default"}>{it.auto ? "규칙" : "AI 판단"}</Badge>
                        </td>
                        <td className="px-3.5 py-3 text-ink-2">
                          {it.reason && <p className="font-medium text-foreground">{it.reason}</p>}
                          <p className={cn(it.reason && "mt-0.5 text-muted-foreground")}>{it.findings.join(" · ")}</p>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>

          {rewrites.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>고칠 순서</CardTitle>
                <p className="text-[13px] text-muted-foreground">
                  점수를 많이 깎는 것부터예요. 한 번에 다 바꾸지 말고 위에서부터 하나씩 인스타 앱에서 고치세요.
                </p>
              </CardHeader>
              <CardContent>
                <ol className="space-y-4">
                  {rewrites.map((r, i) => (
                    <li key={`${r.itemId}-${i}`} className="rounded-lg border p-4">
                      <p className="flex items-center gap-2 text-sm font-semibold">
                        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand-soft text-xs text-primary tabular-nums">
                          {i + 1}
                        </span>
                        {r.title}
                      </p>
                      {r.why && <p className="mt-1 text-[13px] text-muted-foreground">{r.why}</p>}
                      <ul className="mt-3 space-y-2">
                        {r.options.map((o, j) => (
                          <li key={j} className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2">
                            <p className="min-w-0 flex-1 text-[13px] whitespace-pre-line">{o}</p>
                            <CopyButton text={o} />
                          </li>
                        ))}
                      </ul>
                      {r.warnings.length > 0 && (
                        <ul className="mt-2 space-y-1">
                          {r.warnings.map((w, k) => (
                            <li key={k} className="flex items-start gap-1.5 text-xs text-warn">
                              <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
                              {w}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

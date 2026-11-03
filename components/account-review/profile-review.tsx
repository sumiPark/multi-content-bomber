import { AlertTriangle, Loader2 } from "lucide-react";
import { CopyButton } from "@/components/account-review/copy-button";
import { ScreenshotUpload } from "@/components/account-review/screenshot-upload";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { RelativeTime } from "@/components/ui/relative-time";
import type { ProfileManualInput, ReviewItem, ReviewRewrite, ReviewStatus } from "@/lib/account-review/types";
import { cn } from "@/lib/utils";

// 분석 · 프로필 점수 — 계정 하나의 카드 (점수 · 모르는 항목 · 캡처 올리기 · 항목 표 · 고칠 순서).
// 채점은 매일 04:30 자동(worker/review-profiles.ts)이라 채점 버튼이 없다. 서버 컴포넌트.

export interface ReviewRow {
  id: string;
  status: ReviewStatus;
  total_score: number | null;
  rescore: number | null;
  items: ReviewItem[] | null;
  rewrites: ReviewRewrite[] | null;
  summary: string | null;
  manual_input: unknown;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface ProfileScoreAccount {
  id: string;
  name: string;
  active: boolean;
}

const BUSY_MS = 20 * 60_000;

// 색만으로 전달하지 않게 글자도 함께 (DESIGN.md 1-4)
function level(score: number | null, max: number): { label: string; bar: string; text: string } {
  if (score == null) return { label: "모름", bar: "bg-surface-3", text: "text-muted-foreground" };
  const r = score / max;
  if (r < 0.4) return { label: "많이 깎임", bar: "bg-risk", text: "text-risk" };
  if (r < 0.75) return { label: "조금 깎임", bar: "bg-warn", text: "text-warn" };
  return { label: "좋음", bar: "bg-ok", text: "text-ok" };
}

const knownMax = (items: ReviewItem[]) => items.reduce((s, i) => s + (i.score == null ? 0 : i.max), 0);

function isBusy(row: ReviewRow | undefined): boolean {
  if (!row || (row.status !== "PENDING" && row.status !== "RUNNING")) return false;
  return Date.now() - Date.parse(row.started_at ?? row.created_at) < BUSY_MS;
}

export function ProfileScoreCard({ account, history }: { account: ProfileScoreAccount; history: ReviewRow[] }) {
  const done = history.filter((r) => r.status === "DONE" && r.total_score != null && r.items);
  const latest = done[0] ?? null;
  const previous = done[1] ?? null;
  const busy = isBusy(history[0]);
  const failed = history[0]?.status === "FAILED" ? history[0] : null;
  // 캡처 값은 가장 최근 행에서 이어받는다(워커와 같은 규칙)
  const current = (history[0]?.manual_input ?? {}) as ProfileManualInput;

  const items = latest?.items ?? [];
  const rewrites = latest?.rewrites ?? [];
  const max = knownMax(items);
  const unknown = items.filter((i) => i.score == null);
  // 같은 만점일 때만 비교한다 — 캡처로 항목이 늘면 점수 차이가 뜻이 없다
  const prevItems = previous?.items ?? [];
  const delta =
    latest?.total_score != null && previous?.total_score != null && knownMax(prevItems) === max ? latest.total_score - previous.total_score : null;

  return (
    <Card>
      <CardContent className="space-y-4 py-5">
        <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
          <div className="min-w-[140px]">
            <p className="text-sm font-semibold">{account.name}</p>
            {latest ? (
              <>
                <p className="mt-1 text-2xl font-bold tabular-nums">
                  {latest.total_score}
                  <span className="text-base font-semibold text-muted-foreground">/{max}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {max < 100 ? `확인된 항목 ${max}점 만점 기준` : "100점 만점"}
                  {delta != null && delta !== 0 && (
                    <span className={cn("ml-1.5 font-medium tabular-nums", delta > 0 ? "text-ok" : "text-risk")}>
                      지난번보다 {delta > 0 ? `${delta}점 ↑` : `${-delta}점 ↓`}
                    </span>
                  )}
                </p>
              </>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                {account.active ? "아직 채점 전이에요. 매일 04:30에 자동으로 채점해요." : "인스타 연결이 끊겨 채점할 수 없어요. 계정 연동에서 다시 연결하세요."}
              </p>
            )}
          </div>

          {latest?.rescore != null && latest.rescore > (latest.total_score ?? 0) && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">아래 문구대로 고치면 (예상)</p>
              <p className="mt-1 text-2xl font-bold text-primary tabular-nums">
                {latest.rescore}
                <span className="text-base font-semibold text-muted-foreground">/{max}</span>
              </p>
            </div>
          )}

          <div className="min-w-[240px] flex-1 space-y-1.5">
            {busy ? (
              <p className="flex items-center gap-1.5 text-xs text-primary">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                채점 중이에요. 1~2분 뒤 새로고침하세요.
              </p>
            ) : (
              latest?.finished_at && (
                <p className="text-xs text-muted-foreground">
                  <RelativeTime iso={latest.finished_at} /> 자동 채점 · 프로필이 바뀌거나 7일이 지나면 다시 채점해요
                </p>
              )
            )}
            {failed && !busy && (
              <p className="flex items-start gap-1.5 text-xs text-risk">
                <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
                마지막 채점이 실패했어요: {failed.error ?? "이유를 알 수 없어요."}
              </p>
            )}
            {latest?.summary && <p className="max-w-3xl text-sm text-ink-2">{latest.summary}</p>}
          </div>
        </div>

        {unknown.length > 0 && (
          <p className="rounded-md bg-brand-soft px-3 py-2 text-xs text-ink-2">
            <b>모르는 항목</b> {unknown.map((i) => i.label).join(" · ")} (점수에서 뺐어요). 하이라이트 · 고정 게시물 · 연락 버튼은 인스타가 알려 주지 않아서,
            프로필 캡처를 한 장 올리면 채워져요. 바꿨을 때만 다시 올리면 돼요.
          </p>
        )}
        {account.active && <ScreenshotUpload accountId={account.id} current={current} />}

        {latest && (
          <details className="group rounded-lg border">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
              항목별 점수{rewrites.length > 0 && ` · 고칠 순서 ${rewrites.length}개`}
            </summary>
            <div className="space-y-5 border-t pt-1 pb-4">
              <div className="overflow-x-auto">
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
                <p className="px-3.5 pt-2 text-xs text-muted-foreground">
                  <b>규칙</b>은 글자 수 · 개수처럼 정해진 기준이라 다시 채점해도 같은 점수가 나와요. <b>AI 판단</b>은 기준표와 사진을 보고 AI가 매겨요.
                </p>
              </div>

              {rewrites.length > 0 && (
                <div className="space-y-3 px-4">
                  <div>
                    <p className="text-sm font-semibold">고칠 순서</p>
                    <p className="text-xs text-muted-foreground">점수를 많이 깎는 것부터예요. 한 번에 다 바꾸지 말고 위에서부터 하나씩 인스타 앱에서 고치세요.</p>
                  </div>
                  <ol className="space-y-3">
                    {rewrites.map((r, i) => (
                      <li key={`${r.itemId}-${i}`} className="rounded-lg border p-4">
                        <p className="flex items-center gap-2 text-sm font-semibold">
                          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand-soft text-xs text-primary tabular-nums">{i + 1}</span>
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
                </div>
              )}
            </div>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

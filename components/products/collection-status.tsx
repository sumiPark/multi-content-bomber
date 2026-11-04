import Link from "next/link";
import { AlertTriangle, ExternalLink, Loader2 } from "lucide-react";
import { AutoRefresh } from "@/components/products/auto-refresh";
import { Badge } from "@/components/ui/badge";
import { RelativeTime } from "@/components/ui/relative-time";
import { won } from "@/components/products/labels";
import { estimateKrw } from "@/lib/products/analysis/pricing";
import { SHOPS, type ShopCode } from "@/lib/products/shops";

// 상품 화면 위쪽 "수집 · 분석 현황" — worker_runs(0027) 마지막 실행 + 분석 진행률 + 실패한 상품.
// 실행 중이면 20초마다 화면을 새로 그린다.

// products.yml job timeout(60분)보다 오래 running이면 러너가 죽은 것으로 본다.
const STALE_MS = 70 * 60_000;

export interface WorkerRunRow {
  status: string;
  started_at: string;
  finished_at: string | null;
  summary: unknown;
  error: string | null;
  github_run_url: string | null;
}

export interface FailedProduct {
  id: string;
  name: string;
  error: string;
}

type CollectSummary = {
  shops?: { shop: string; saved?: number; queued?: number; errorCount?: number; errors?: string[]; failed?: boolean }[];
};
type AnalyzeSummary = {
  done?: number;
  tally?: Record<string, number>;
  model?: string;
  tokens?: { input: number; output: number; calls: number };
  stoppedByDeadline?: boolean;
};

function runState(run: WorkerRunRow | null, now: number): "none" | "running" | "stale" | "success" | "failed" {
  if (!run) return "none";
  if (run.status === "running") {
    return now - Date.parse(run.started_at) > STALE_MS ? "stale" : "running";
  }
  return run.status === "failed" ? "failed" : "success";
}

const STATE_BADGE = {
  none: { label: "아직 실행 기록 없음", variant: "outline" },
  running: { label: "실행 중", variant: "default" },
  stale: { label: "중단됨", variant: "destructive" },
  success: { label: "완료", variant: "secondary" },
  failed: { label: "실패", variant: "destructive" },
} as const;

export function CollectionStatus({
  collectRun,
  analyzeRun,
  progress,
  failed,
  now,
}: {
  collectRun: WorkerRunRow | null;
  analyzeRun: WorkerRunRow | null;
  // 판매 중 상품 기준 (분석 대상)
  progress: { total: number; done: number; queued: number; analyzing: number; failed: number };
  failed: FailedProduct[];
  now: number;
}) {
  const collect = runState(collectRun, now);
  const analyze = runState(analyzeRun, now);
  const running = collect === "running" || analyze === "running";
  const cs = (collectRun?.summary ?? {}) as CollectSummary;
  const as = (analyzeRun?.summary ?? {}) as AnalyzeSummary;
  const cost = as.tokens ? estimateKrw(as.model, as.tokens.input, as.tokens.output) : null;
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const collectErrors = (cs.shops ?? []).flatMap((s) => (s.errors ?? []).map((e) => `${SHOPS[s.shop as ShopCode]?.name ?? s.shop}: ${e}`));

  return (
    <section className="space-y-3 rounded-lg border p-4">
      {running && <AutoRefresh intervalMs={20_000} />}
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">수집 · 분석 현황</h2>
        {running && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> 20초마다 새로 고침
          </span>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {/* 상품 수집 */}
        <div className="space-y-1.5 rounded-md bg-muted/20 p-3">
          <RunHeader title="상품 수집" state={collect} run={collectRun} />
          {(cs.shops ?? []).length > 0 && (
            <ul className="space-y-0.5 text-xs tabular-nums">
              {cs.shops!.map((s) => (
                <li key={s.shop} className={s.failed ? "text-destructive" : undefined}>
                  {SHOPS[s.shop as ShopCode]?.name ?? s.shop}:{" "}
                  {s.failed ? "실패" : `${s.saved ?? 0}개 받음 · 새로 분석할 것 ${s.queued ?? 0}개`}
                  {!!s.errorCount && !s.failed && <span className="text-warn"> · 오류 {s.errorCount}건</span>}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">매일 03시 자동 · 지금 수집 버튼으로 바로</p>
        </div>

        {/* 상세페이지 분석 */}
        <div className="space-y-1.5 rounded-md bg-muted/20 p-3">
          <RunHeader title="상세페이지 분석" state={analyze} run={analyzeRun} />
          <div>
            <div className="flex justify-between text-xs tabular-nums">
              <span>
                판매 중 {progress.total}개 중 <b>{progress.done}개</b> 분석
              </span>
              <span className="text-muted-foreground">{pct}%</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-1 text-xs text-muted-foreground tabular-nums">
              남은 것 {progress.queued + progress.analyzing}개{progress.analyzing > 0 && ` (지금 ${progress.analyzing}개 읽는 중)`}
              {progress.failed > 0 && <span className="text-destructive"> · 실패 {progress.failed}개</span>}
            </p>
          </div>
          {analyzeRun?.finished_at && (
            <p className="text-xs tabular-nums text-muted-foreground">
              지난 실행: {as.done ?? 0}개 분석
              {as.tokens && ` · 토큰 입력 ${(as.tokens.input / 1000).toFixed(0)}K · 출력 ${(as.tokens.output / 1000).toFixed(0)}K`}
              {cost != null && ` · 약 ${won(cost)}`}
            </p>
          )}
          {as.stoppedByDeadline && (
            <p className="text-xs text-warn">
              실행 시간 한도(45분)에 걸려 멈췄어요. 남은 것은 다음 실행이 이어서 읽습니다.
            </p>
          )}
        </div>
      </div>

      {(failed.length > 0 || collectErrors.length > 0 || analyzeRun?.error || collectRun?.error) && (
        <div className="space-y-1 rounded-md border border-warn/40 bg-warn-soft p-3 text-xs">
          <p className="flex items-center gap-1 font-semibold text-warn">
            <AlertTriangle className="size-3.5" /> 일부 상품을 받거나 읽지 못했어요. 다음 수집 때 다시 시도해요.
          </p>
          {[collectRun?.error, analyzeRun?.error].filter(Boolean).map((e) => (
            <p key={e}>{e}</p>
          ))}
          {collectErrors.slice(0, 5).map((e) => (
            <p key={e} className="truncate">
              {e}
            </p>
          ))}
          {failed.map((f) => (
            <p key={f.id} className="truncate">
              <Link href={`/products/${f.id}`} className="underline underline-offset-2">
                {f.name}
              </Link>{" "}
              — {f.error}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

function RunHeader({
  title,
  state,
  run,
}: {
  title: string;
  state: ReturnType<typeof runState>;
  run: WorkerRunRow | null;
}) {
  const badge = STATE_BADGE[state];
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="font-medium">{title}</span>
      <Badge variant={badge.variant} className="text-xs">
        {badge.label}
      </Badge>
      {run && (
        <span className="text-muted-foreground">
          {state === "running" ? "시작 " : "마지막 "}
          <RelativeTime iso={run.finished_at ?? run.started_at} />
        </span>
      )}
      {run?.github_run_url && (
        <a href={run.github_run_url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground">
          실행 기록 <ExternalLink className="size-3" />
        </a>
      )}
    </div>
  );
}

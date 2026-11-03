import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// 워커 실행 기록 (worker_runs, 0027) — 상품 화면의 "수집 · 분석 현황" 카드가 읽는다.
// 기록은 덤이다: 실패해도 경고만 남기고 워커 본업은 계속한다.

export type WorkerName = "collect-products" | "analyze-products" | "collect-metrics";

type Service = ReturnType<typeof createServiceClient>;

export interface RunLog {
  finish(status: "success" | "failed", summary: Record<string, unknown>, error?: string | null): Promise<void>;
}

export async function startRunLog(service: Service, worker: WorkerName): Promise<RunLog> {
  // GitHub Actions가 주는 기본 환경변수. 로컬 실행이면 없다.
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_EVENT_NAME } = process.env;
  const runUrl =
    GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
      ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
      : null;

  let id: string | null = null;
  try {
    const { data, error } = await service
      .from("worker_runs")
      .insert({ worker, trigger: GITHUB_EVENT_NAME ?? "manual", github_run_url: runUrl })
      .select("id")
      .single();
    if (error) throw error;
    id = data.id;
  } catch (err) {
    console.warn(`[run-log] ${worker} 시작 기록 실패:`, err instanceof Error ? err.message : err);
  }

  return {
    async finish(status, summary, error = null) {
      if (!id) return;
      const { error: e } = await service
        .from("worker_runs")
        .update({
          status,
          finished_at: new Date().toISOString(),
          summary: summary as Json,
          error: error?.slice(0, 2000) ?? null,
        })
        .eq("id", id);
      if (e) console.warn(`[run-log] ${worker} 끝 기록 실패:`, e.message);
    },
  };
}

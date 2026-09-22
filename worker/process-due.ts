// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions/Railway에선 no-op).
import "./load-env";

import { createServiceClient } from "@/lib/supabase/service";
import type { Database } from "@/types/database";
import { processClaimedPublishJob } from "./processors/publish-processor";
import { processTokenRefreshSweep } from "./processors/token-refresh-processor";

// ─────────────────────────────────────────────────────────────────────────────
// Postgres 큐 워커 — "한 번 실행하고 종료"하는 배치 (Phase 4b).
//
// 상주 BullMQ 워커를 대체한다. GitHub Actions가 두 방식으로 이 스크립트를 깨운다:
//   · schedule(cron, ~30분)        → 예약 발행분 sweep
//   · repository_dispatch(즉시)    → 사용자가 "즉시 업로드" 누른 직후
//
// 흐름:
//   1. claim_due_publish_jobs RPC로 처리할 job을 원자적으로 선점(PROCESSING).
//   2. 선점한 job을 제한 동시성으로 처리. 비어 있을 때까지 반복(같은 run에서 최대한 비움).
//   3. 토큰 만료 sweep 1회.
//   4. 종료. 개별 job 실패는 DB(status_history)에 기록되고 RETRYING으로 남아 다음에 재시도.
// ─────────────────────────────────────────────────────────────────────────────

type PublishJobRow = Database["public"]["Tables"]["publish_jobs"]["Row"];

// 한 run에서 처리할 한도. cron 1회가 너무 길어지지 않게 + GitHub Actions 분 소모 제어.
const MAX_JOBS_PER_RUN = 100;
// claim 한 번에 가져올 배치 크기.
const CLAIM_BATCH = 20;
// 동시 처리 수 (구 BullMQ concurrency=5 유지). 플랫폼 rate limit 고려.
const CONCURRENCY = 5;
// publish_jobs.attempts 한도 — claim RPC의 p_max_attempts와 일치시켜야 한다.
const MAX_ATTEMPTS = 3;
// run 시간 예산 — GitHub Actions job timeout(publish.yml timeout-minutes: 50) 안에서
// 스스로 끝나기 위한 두 선. timeout에 죽으면 진행 중 job이 PROCESSING으로 굳고,
// attempts가 한도에 닿아 있으면 stale 회수도 안 돼 영영 "업로드중"으로 남는다.
//   · CLAIM_CUTOFF_MS: 이 시각 이후엔 새 batch를 claim하지 않는다(다음 sweep에 넘김).
//   · RUN_DEADLINE_MS: 어댑터의 긴 폴링(Instagram 컨테이너 등)이 이 시각에 손을 떼고
//     RETRYING으로 내려놓는다 — 진행분은 resume_state로 다음 시도가 이어받는다.
const CLAIM_CUTOFF_MS = 30 * 60_000;
const RUN_DEADLINE_MS = 42 * 60_000;

async function processBatch(
  supabase: ReturnType<typeof createServiceClient>,
  rows: PublishJobRow[],
  deadlineAt: number,
): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;

  // CONCURRENCY개씩 끊어서 처리.
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const slice = rows.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      slice.map((row) =>
        processClaimedPublishJob(supabase, row, MAX_ATTEMPTS, deadlineAt),
      ),
    );
    for (const r of results) {
      if (r.status === "fulfilled") ok++;
      else {
        failed++;
        // 상태/이력은 processor가 이미 DB에 기록함. 여기선 로그만.
        console.error(
          "[process-due] job 처리 실패:",
          r.reason instanceof Error ? r.reason.message : r.reason,
        );
      }
    }
  }
  return { ok, failed };
}

async function main() {
  const supabase = createServiceClient();
  const startedAt = Date.now();
  const deadlineAt = startedAt + RUN_DEADLINE_MS;

  let totalOk = 0;
  let totalFailed = 0;
  let totalClaimed = 0;

  // 1. due job이 없을 때까지 claim → 처리 반복 (run당 MAX_JOBS_PER_RUN 상한).
  //    실패한 job은 RETRYING으로 바로 due가 되므로 같은 run 안에서 다시 claim된다 —
  //    Instagram처럼 이어받기가 있는 어댑터는 이 덕에 run 예산 끝까지 연속으로 기다린다.
  let claimCutoffHit = false;
  while (totalClaimed < MAX_JOBS_PER_RUN) {
    if (Date.now() - startedAt > CLAIM_CUTOFF_MS) {
      claimCutoffHit = true;
      break;
    }
    const { data, error } = await supabase.rpc("claim_due_publish_jobs", {
      p_limit: Math.min(CLAIM_BATCH, MAX_JOBS_PER_RUN - totalClaimed),
      p_max_attempts: MAX_ATTEMPTS,
    });

    if (error) {
      console.error("[process-due] claim RPC 실패:", error.message);
      break;
    }

    const rows = (data ?? []) as PublishJobRow[];
    if (rows.length === 0) break; // 더 처리할 due job 없음

    totalClaimed += rows.length;
    console.log(`[process-due] claimed=${rows.length} (누적 ${totalClaimed})`);

    const { ok, failed } = await processBatch(supabase, rows, deadlineAt);
    totalOk += ok;
    totalFailed += failed;
  }

  if (totalClaimed >= MAX_JOBS_PER_RUN) {
    // 상한에 걸려 남은 job이 있을 수 있음 — 다음 cron/dispatch가 이어서 처리.
    console.warn(
      `[process-due] run 상한(${MAX_JOBS_PER_RUN}) 도달 — 잔여는 다음 sweep에서 처리.`,
    );
  }
  if (claimCutoffHit) {
    console.warn(
      `[process-due] run 시간 예산(${CLAIM_CUTOFF_MS / 60_000}분) 소진 — 잔여는 다음 sweep에서 처리.`,
    );
  }

  // 2. 토큰 만료 sweep (publish와 독립적으로 항상 1회).
  let tokenStats: Awaited<ReturnType<typeof processTokenRefreshSweep>> | null =
    null;
  try {
    tokenStats = await processTokenRefreshSweep();
  } catch (err) {
    console.error(
      "[process-due] 토큰 sweep 실패:",
      err instanceof Error ? err.message : err,
    );
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[process-due] 완료 | publish: claimed=${totalClaimed} ok=${totalOk} failed=${totalFailed} | token=${JSON.stringify(tokenStats)} | ${elapsed}s`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[process-due] 치명적 오류:", err);
    process.exit(1);
  });

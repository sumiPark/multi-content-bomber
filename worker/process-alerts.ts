// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions에선 no-op).
import "./load-env";

import { triggerEpisodeAlertRun } from "@/lib/github-dispatch";
import { createServiceClient } from "@/lib/supabase/service";
import type { Database } from "@/types/database";
import {
  processEpisodeAlertTask,
  releaseTask,
  type TaskOutcome,
} from "./processors/episode-alert-processor";

// ─────────────────────────────────────────────────────────────────────────────
// 다음 화 알림 워커 — "한 번 실행하고 종료"하는 배치.
//
// .github/workflows/episode-alerts.yml이 깨운다:
//   · workflow_run(publish 완료)  → 발행 워커가 만든 새 알림 작업을 바로 수집
//   · repository_dispatch         → 사용자가 "보내기"를 누름 / 이전 run이 시간 예산에 걸림
//
// 발행 워커와 분리한 이유: 답글은 스팸 제한을 피하려고 10~20초 간격으로 보내서 run이
// 길다. 같은 워크플로(concurrency 직렬화)에 두면 그동안 즉시 발행이 줄을 서게 된다.
//
// 계정끼리는 병렬, 한 계정 안의 작업은 순서대로 처리한다(계정별 발송 간격 유지).
// ─────────────────────────────────────────────────────────────────────────────

type TaskRow = Database["public"]["Tables"]["episode_alert_tasks"]["Row"];

// GitHub Actions job timeout(episode-alerts.yml timeout-minutes: 50) 안에서 스스로 끝낸다.
const RUN_DEADLINE_MS = 40 * 60_000;
const CLAIM_LIMIT = 20;
// 워커가 죽어 잠금이 남은 작업을 회수하는 기준. run 최대 길이(50분)보다 길게.
const STALE_LOCK_MINUTES = 60;

async function processAccount(
  supabase: ReturnType<typeof createServiceClient>,
  tasks: TaskRow[],
  deadlineAt: number,
): Promise<TaskOutcome[]> {
  const outcomes: TaskOutcome[] = [];
  for (const task of tasks) {
    if (Date.now() > deadlineAt - 60_000) {
      // 손대지 못한 작업은 잠금만 풀어 다음 run이 바로 집어가게 한다.
      await releaseTask(supabase, task.id);
      outcomes.push("continue");
      continue;
    }
    outcomes.push(await processEpisodeAlertTask(supabase, task, deadlineAt));
  }
  return outcomes;
}

async function main() {
  const supabase = createServiceClient();
  const startedAt = Date.now();
  const deadlineAt = startedAt + RUN_DEADLINE_MS;

  const { data, error } = await supabase.rpc("claim_episode_alert_tasks", {
    p_limit: CLAIM_LIMIT,
    p_stale_minutes: STALE_LOCK_MINUTES,
  });
  if (error) {
    console.error("[process-alerts] claim RPC 실패:", error.message);
    process.exitCode = 1;
    return;
  }

  const tasks = (data ?? []) as TaskRow[];
  if (tasks.length === 0) {
    console.log("[process-alerts] 처리할 알림 작업 없음");
    return;
  }

  const byAccount = new Map<string, TaskRow[]>();
  for (const t of tasks) {
    const list = byAccount.get(t.social_account_id) ?? [];
    list.push(t);
    byAccount.set(t.social_account_id, list);
  }
  console.log(
    `[process-alerts] claimed=${tasks.length} accounts=${byAccount.size}`,
  );

  const outcomes = (
    await Promise.all(
      Array.from(byAccount.values()).map((list) =>
        processAccount(supabase, list, deadlineAt),
      ),
    )
  ).flat();

  const summary = outcomes.reduce<Record<string, number>>((acc, o) => {
    acc[o] = (acc[o] ?? 0) + 1;
    return acc;
  }, {});

  // 시간 예산에 걸려 남은 일이 있으면 다음 run을 바로 깨운다. concurrency 그룹이라 이
  // run이 끝난 뒤에 시작된다. 실패해도 다음 publish 완료(workflow_run) 때 이어진다.
  if (outcomes.includes("continue")) {
    try {
      await triggerEpisodeAlertRun("continue");
      console.log("[process-alerts] 남은 작업 — 다음 run 예약");
    } catch (err) {
      console.error(
        "[process-alerts] 다음 run dispatch 실패:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[process-alerts] 완료 | ${JSON.stringify(summary)} | ${elapsed}s`);
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("[process-alerts] 치명적 오류:", err);
    process.exit(1);
  });

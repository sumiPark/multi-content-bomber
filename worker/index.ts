// .env.local 로드는 다른 어떤 import보다 먼저. Redis URL 등 환경변수가 module init에 쓰임.
import "./load-env";

import { Queue, Worker } from "bullmq";
import {
  PUBLISH_QUEUE_NAME,
  type PublishJobData,
} from "@/lib/queue/publish-queue";
import {
  TOKEN_REFRESH_INTERVAL_MS,
  TOKEN_REFRESH_QUEUE_NAME,
  TOKEN_REFRESH_SCHEDULER_ID,
  type TokenRefreshJobData,
} from "@/lib/queue/token-refresh-queue";
import { connection } from "./redis";
import { processPublishJob } from "./processors/publish-processor";
import { processTokenRefreshSweep } from "./processors/token-refresh-processor";

// ─────────────────────────────────────────────────────────────────────────────
// publish Worker — 콘텐츠 게시 (Phase 4b ①~④)
// ─────────────────────────────────────────────────────────────────────────────

const publishWorker = new Worker<PublishJobData>(
  PUBLISH_QUEUE_NAME,
  async (job) => {
    console.log(
      `[publish] job ${job.id} pickup | attempt=${job.attemptsMade + 1}/${job.opts.attempts}`,
    );
    return processPublishJob(job);
  },
  {
    connection,
    // 플랫폼별 rate limit은 워커가 늘어나면 별도 큐로 분리할 예정.
    concurrency: 5,
  },
);

publishWorker.on("ready", () => {
  console.log(`[publish] ready | queue=${PUBLISH_QUEUE_NAME} | concurrency=5`);
});

publishWorker.on("error", (err) => {
  console.error("[publish] error:", err);
});

publishWorker.on("failed", (job, err) => {
  console.error(
    `[publish] job ${job?.id ?? "?"} failed after ${job?.attemptsMade ?? 0} attempts:`,
    err.message,
  );
});

publishWorker.on("completed", (job, result) => {
  console.log(`[publish] job ${job.id} completed`, result);
});

// ─────────────────────────────────────────────────────────────────────────────
// token-refresh Worker + Scheduler — 30분 주기 토큰 sweep (Phase 4b ⑤-b / 4c)
// ─────────────────────────────────────────────────────────────────────────────

const tokenRefreshWorker = new Worker<TokenRefreshJobData>(
  TOKEN_REFRESH_QUEUE_NAME,
  async (job) => {
    console.log(`[token-refresh] job ${job.id} pickup`);
    return processTokenRefreshSweep(job);
  },
  {
    connection,
    // sweep은 한 번에 하나만 — 여러 인스턴스로 같은 계정을 동시에 refresh하면
    // refresh_token rotation 정책 있는 플랫폼(TikTok 등)이 깨질 수 있다.
    concurrency: 1,
  },
);

tokenRefreshWorker.on("ready", () => {
  console.log(
    `[token-refresh] ready | queue=${TOKEN_REFRESH_QUEUE_NAME} | every=${TOKEN_REFRESH_INTERVAL_MS}ms`,
  );
});

tokenRefreshWorker.on("error", (err) => {
  console.error("[token-refresh] error:", err);
});

tokenRefreshWorker.on("failed", (job, err) => {
  console.error(`[token-refresh] job ${job?.id ?? "?"} failed:`, err.message);
});

// Job Scheduler 등록은 부팅 시 한 번. upsert이므로 워커가 여러 번 재시작돼도 idempotent.
async function setupSchedulers() {
  const queue = new Queue<TokenRefreshJobData>(TOKEN_REFRESH_QUEUE_NAME, {
    connection,
  });
  try {
    await queue.upsertJobScheduler(
      TOKEN_REFRESH_SCHEDULER_ID,
      { every: TOKEN_REFRESH_INTERVAL_MS },
      {
        name: "sweep",
        data: {},
      },
    );
    console.log(
      `[token-refresh] scheduler upserted | id=${TOKEN_REFRESH_SCHEDULER_ID}`,
    );
  } finally {
    // Queue 인스턴스는 connection을 공유하지만 자체 리소스가 약간 있다. close()로 정리.
    // (connection 자체는 publishWorker/tokenRefreshWorker가 계속 사용하므로 quit 안 함.)
    await queue.close();
  }
}

setupSchedulers().catch((err) => {
  console.error("[worker] scheduler setup failed:", err);
  // 스케줄러 등록 실패해도 publish worker는 계속 살리고 다음 부팅에서 재시도.
});

// ─────────────────────────────────────────────────────────────────────────────
// Graceful shutdown — Railway가 SIGTERM 보내면 두 워커 모두 drain.
// ─────────────────────────────────────────────────────────────────────────────

async function shutdown(signal: string) {
  console.log(`[worker] received ${signal}, draining and shutting down…`);
  try {
    await Promise.all([publishWorker.close(), tokenRefreshWorker.close()]);
    await connection.quit();
    console.log("[worker] shutdown complete");
    process.exit(0);
  } catch (err) {
    console.error("[worker] shutdown error:", err);
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

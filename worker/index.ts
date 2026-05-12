// .env.local 로드는 다른 어떤 import보다 먼저. Redis URL 등 환경변수가 module init에 쓰임.
import "./load-env";

import { Worker } from "bullmq";
import {
  PUBLISH_QUEUE_NAME,
  type PublishJobData,
} from "@/lib/queue/publish-queue";
import { connection } from "./redis";
import { processPublishJob } from "./processors/publish-processor";

// Phase 4b ③ — processor는 publish_jobs 상태 머신 + status_history 기록까지 담당.
// 실제 게시는 processor 내부 stubPublish가 ④에서 lib/platforms 어댑터로 교체된다.
const worker = new Worker<PublishJobData>(
  PUBLISH_QUEUE_NAME,
  async (job) => {
    console.log(
      `[worker] job ${job.id} pickup | attempt=${job.attemptsMade + 1}/${job.opts.attempts}`,
    );
    return processPublishJob(job);
  },
  {
    connection,
    // 플랫폼별 rate limit은 워커가 늘어나면 별도 큐로 분리할 예정.
    concurrency: 5,
  },
);

worker.on("ready", () => {
  console.log(`[worker] ready | queue=${PUBLISH_QUEUE_NAME} | concurrency=5`);
});

worker.on("error", (err) => {
  console.error("[worker] error:", err);
});

worker.on("failed", (job, err) => {
  console.error(
    `[worker] job ${job?.id ?? "?"} failed after ${job?.attemptsMade ?? 0} attempts:`,
    err.message,
  );
});

worker.on("completed", (job, result) => {
  console.log(`[worker] job ${job.id} completed`, result);
});

async function shutdown(signal: string) {
  console.log(`[worker] received ${signal}, draining and shutting down…`);
  try {
    await worker.close();
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

// .env.local 로드는 다른 어떤 import보다 먼저. Redis URL 등 환경변수가 module init에 쓰임.
import "./load-env";

import { Worker, type Job } from "bullmq";
import { connection } from "./redis";
import { PUBLISH_QUEUE_NAME, type PublishJobData } from "./queue";

// Phase 4b ① 슬라이스 골격.
// 실제 게시 처리(④ 플랫폼 어댑터 호출, status 머신)는 다음 슬라이스에서 채운다.
// 지금은 큐 연결과 job 수신이 정상인지 검증하는 게 목표.
const worker = new Worker<PublishJobData>(
  PUBLISH_QUEUE_NAME,
  async (job: Job<PublishJobData>) => {
    console.log(
      `[worker] job ${job.id} received | publishJobId=${job.data.publishJobId} | attempt=${job.attemptsMade + 1}/${job.opts.attempts}`,
    );
    // TODO(slice ②③④): publish_jobs 상태 머신 + 플랫폼 어댑터 publish() 호출.
    return { received: true };
  },
  {
    connection,
    // 플랫폼별 rate limit은 워커가 늘어나면 별도 큐로 분리할 예정.
    // 지금은 단일 큐 동시성 5로 시작.
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
    // close()는 처리 중인 job 완료를 기다린다 (graceful).
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

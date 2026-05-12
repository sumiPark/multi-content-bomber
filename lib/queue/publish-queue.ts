import { Queue, type JobsOptions } from "bullmq";
import IORedis from "ioredis";

// Phase 4b — 큐 정의와 enqueue 헬퍼.
// 워커(worker/index.ts)와 Server Action(app/(dashboard)/actions.ts)이 공유한다.
//
// Connection 정책 (중요):
// - 워커는 상주 프로세스 → ioredis 싱글톤을 worker/redis.ts에서 만들어 재사용.
// - Server Action(Vercel function)은 함수 호출 단위로 죽으므로 상주 connection을 쓸 수 없다.
//   → 이 모듈의 `enqueuePublishJobs`가 매 호출마다 새 IORedis 생성 + 즉시 quit한다.
//   → 그래서 이 모듈은 Queue *인스턴스* 자체를 export하지 않는다. 잘못 import해 모듈
//     레벨로 잡으면 connection이 누적될 수 있다.

export const PUBLISH_QUEUE_NAME = "mcb-publish";

export interface PublishJobData {
  // publish_jobs.id (uuid). 페이로드 최소화 — 큰 데이터(미디어 URL, 캡션)는 워커가 DB에서 다시 읽는다.
  publishJobId: string;
}

export const PUBLISH_DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export interface EnqueueItem {
  data: PublishJobData;
  // 예약 업로드를 위한 delay 등 잡 단위 override.
  opts?: JobsOptions;
}

/**
 * Vercel function 안전한 enqueue.
 *
 * - 한 번 호출에서 N개 job을 묶어 등록 (fan-out: 한 콘텐츠 → 다수 계정).
 * - jobId를 publishJobId(= DB PK)로 고정 → 같은 publish_jobs.id가 두 번 enqueue돼도
 *   BullMQ가 중복으로 처리하지 않는다. 추후 cron이 "DB에는 있는데 큐에 없는 job"을
 *   찾을 때도 jobId로 빠르게 조회 가능.
 * - 함수 종료 시 connection을 반드시 quit해 누적 방지.
 */
export async function enqueuePublishJobs(items: EnqueueItem[]): Promise<string[]> {
  if (items.length === 0) return [];

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL 환경변수가 없습니다.");
  }

  const connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  const queue = new Queue<PublishJobData>(PUBLISH_QUEUE_NAME, {
    connection,
    defaultJobOptions: PUBLISH_DEFAULT_JOB_OPTIONS,
  });

  try {
    const jobs = await queue.addBulk(
      items.map((item) => ({
        name: "publish",
        data: item.data,
        opts: {
          ...item.opts,
          jobId: item.data.publishJobId,
        },
      })),
    );
    return jobs.map((j) => j.id ?? "");
  } finally {
    // close()는 진행 중 요청을 기다린다. connection.quit()이 진짜 connection 정리.
    await queue.close();
    await connection.quit();
  }
}

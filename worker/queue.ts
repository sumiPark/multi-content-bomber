import { Queue } from "bullmq";
import { connection } from "./redis";

// 배포 작업 큐. publish_jobs DB 레코드 1건당 BullMQ job 1건이 1:1로 매핑된다.
// Server Action이 publish_jobs INSERT 후 이 큐에 enqueue 하고, Worker가 처리한다.
// 큐 이름에 `:`는 BullMQ가 금지(내부 Redis 키 네임스페이스 충돌). kebab-case 사용.
export const PUBLISH_QUEUE_NAME = "mcb-publish";

export interface PublishJobData {
  // publish_jobs.id (uuid). 워커는 이걸 가지고 DB에서 상세 정보를 다시 읽는다.
  // 큰 페이로드(미디어 URL, 캡션)는 큐에 넣지 않는다 — DB가 단일 진실 소스.
  publishJobId: string;
}

export const publishQueue = new Queue<PublishJobData>(PUBLISH_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    // 재시도 3회 + 지수 백오프. rate limit / 일시 네트워크 오류 흡수.
    // 토큰 만료 같은 영구 실패는 워커 안에서 별도 분류해 즉시 fail 처리할 예정.
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    // 완료 작업은 24시간 또는 최근 1,000건까지만 Redis에 보관 (메모리 절약).
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    // 실패 작업은 7일간 보관 → 배포 관리 화면에서 재시도/원인 분석에 사용.
    removeOnFail: { age: 7 * 24 * 3600 },
  },
});

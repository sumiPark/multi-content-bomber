// 로컬 검증용 스크립트. 더미 publish job 하나를 큐에 넣고 종료한다.
// 워커를 띄운 다른 터미널에서 "job N received" 로그가 떠야 정상.
//
// 공유 모듈(lib/queue/publish-queue)의 enqueuePublishJobs를 사용해
// Server Action과 동일한 경로를 검증한다.
//
// 사용: npm run worker:enqueue
import "./load-env";

import { randomUUID } from "node:crypto";
import { enqueuePublishJobs } from "@/lib/queue/publish-queue";

async function main() {
  // jobId가 publishJobId로 고정되어 BullMQ가 중복을 자동 차단하므로,
  // 검증 스크립트는 매번 새 UUID로 enqueue해 같은 jobId 캐시를 피한다.
  const publishJobId = randomUUID();
  const ids = await enqueuePublishJobs([{ data: { publishJobId } }]);
  console.log(`[enqueue] added jobs: ${ids.join(", ")}`);
  console.log(
    `[enqueue] hint: 이 ID는 publish_jobs에 실제로 존재하지 않으므로 워커는 'row 없음' 에러 → 재시도 → FAILED 경로를 검증합니다.`,
  );
}

main().catch((err) => {
  console.error("[enqueue] failed:", err);
  process.exit(1);
});

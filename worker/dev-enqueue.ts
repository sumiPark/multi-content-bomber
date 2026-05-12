// 로컬 검증용 스크립트. 더미 publish job 하나를 큐에 넣고 종료한다.
// 워커를 띄운 다른 터미널에서 "job N received" 로그가 떠야 정상.
//
// 공유 모듈(lib/queue/publish-queue)의 enqueuePublishJobs를 사용해
// Server Action과 동일한 경로를 검증한다.
//
// 사용: npm run worker:enqueue
import "./load-env";

import { enqueuePublishJobs } from "@/lib/queue/publish-queue";

async function main() {
  const ids = await enqueuePublishJobs([
    { data: { publishJobId: "00000000-0000-0000-0000-000000000000" } },
  ]);
  console.log(`[enqueue] added jobs: ${ids.join(", ")}`);
}

main().catch((err) => {
  console.error("[enqueue] failed:", err);
  process.exit(1);
});

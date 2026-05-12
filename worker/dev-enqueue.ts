// 로컬 검증용 스크립트. 더미 job 하나를 큐에 넣고 종료한다.
// 워커를 띄운 다른 터미널에서 "job N received" 로그가 떠야 정상.
//
// 사용: npm run worker:enqueue
import "./load-env";

import { publishQueue } from "./queue";
import { connection } from "./redis";

async function main() {
  const job = await publishQueue.add("smoke-test", {
    publishJobId: "00000000-0000-0000-0000-000000000000",
  });
  console.log(`[enqueue] added job ${job.id} to ${publishQueue.name}`);

  // 단발 스크립트라 연결 정리 후 종료.
  await publishQueue.close();
  await connection.quit();
}

main().catch((err) => {
  console.error("[enqueue] failed:", err);
  process.exit(1);
});

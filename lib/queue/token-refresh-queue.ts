// Phase 4c / Phase 4b ⑤-b — 토큰 만료 임박 계정을 일괄 refresh하는 cron 큐.
//
// publish 큐와 분리한 이유:
// - 페이로드/로직이 완전히 다름 (publish는 row-level, refresh는 sweep)
// - rate-limit 정책도 다름 — refresh는 동시성 1로 충분, publish는 5+
// - 같은 큐에서 jobName 분기하면 BullMQ 메트릭/대시보드에서 섞여 보임
//
// Job Schedulers (BullMQ v5.40+):
//   워커 부팅 시 `upsertJobScheduler(id, { every: N })`로 idempotent 등록.
//   같은 schedulerId면 중복 등록 안 되고, every가 바뀌면 갱신됨.
//
// Sweep 자체는 페이로드가 비어있어 data 필드를 사용하지 않는다.
export const TOKEN_REFRESH_QUEUE_NAME = "mcb-token-refresh";

// 30분마다 만료 임박 토큰 sweep. YouTube access_token이 1시간 짜리이므로
// 30분 주기면 만료 직전 ~30분 윈도우 안에 한 번은 무조건 잡힌다.
export const TOKEN_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

// upsertJobScheduler의 idempotent key. 워커가 여러 번 부팅돼도 동일 sweep 하나.
export const TOKEN_REFRESH_SCHEDULER_ID = "token-refresh-sweep";

// sweep job 페이로드 — 빈 객체. 향후 강제 트리거(특정 account_id 지정 등) 위해 형은 남김.
export interface TokenRefreshJobData {
  /** 특정 계정만 refresh — 비워두면 만료 임박 전체 sweep. 운영 디버깅용. */
  accountIds?: string[];
}

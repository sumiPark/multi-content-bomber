import IORedis from "ioredis";

// BullMQ broker용 ioredis 싱글톤.
//
// 옵션 근거:
// - maxRetriesPerRequest: null
//     BullMQ는 BRPOPLPUSH 같은 blocking 명령을 영구 대기하므로 ioredis 기본
//     `maxRetriesPerRequest: 20` 으로는 큐가 일정 시간 후 fail로 끊긴다.
//     BullMQ 공식 권고: null로 설정해 무한 대기.
// - enableReadyCheck: false
//     Upstash 같은 일부 호스팅 Redis는 `INFO replication` 같은 ready check
//     커맨드를 제한할 수 있다. BullMQ는 자체적으로 연결 상태를 관리하므로 비활성화.
//
// Upstash URL은 반드시 `rediss://` (TLS) 접두사여야 한다 — `redis://`는 평문이라 Upstash가 거절.
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error(
    "REDIS_URL 환경변수가 설정되지 않았습니다. .env.local 또는 Railway 환경변수에 rediss:// 한 줄을 추가하세요.",
  );
}

// 진단: protocol/host만 로그(password는 노출 X). 'redis:' 평문 시도면 즉시 경고.
try {
  const parsed = new URL(redisUrl);
  console.log(
    `[redis] connecting | protocol=${parsed.protocol} | host=${parsed.host}`,
  );
  if (parsed.protocol === "redis:") {
    console.warn(
      "[redis] ⚠️ URL이 'redis://'로 시작합니다. Upstash는 TLS 필수이므로 'rediss://'를 사용해야 합니다.",
    );
  }
} catch {
  console.warn(
    "[redis] REDIS_URL parse 실패. 'rediss://default:<pw>@<host>:6379' 형식인지 확인하세요.",
  );
}

export const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

connection.on("error", (err) => {
  // 일시적 네트워크 오류는 ioredis가 자동 재시도하므로 로그만 남기고 throw 하지 않는다.
  console.error("[redis] connection error:", err.message);
});

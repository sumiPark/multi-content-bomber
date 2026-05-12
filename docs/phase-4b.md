# Phase 4b — BullMQ Worker 구축 진행 상황

이 문서는 새 세션이 빠르게 컨텍스트를 잡을 수 있도록 작성. 마지막 업데이트 2026-05-12.

## 슬라이스 진행 상태

| # | 슬라이스 | 상태 | 커밋 |
|---|---------|------|------|
| ① | 인프라 + Worker 골격 (Upstash, BullMQ, redis/queue/index) | ✅ 완료 | `1fd146c` |
| ② | Server Action enqueue 연결 (`enqueuePublishJobs`) | ✅ 완료 | `cd1f868` |
| ③ | Worker processor 상태 머신 + status_history + 멱등성 | ✅ 완료 | `80a1bf5` |
| ④ | 플랫폼별 `publish()` 어댑터 — `stubPublish` 교체 | ⏳ 다음 | — |
| ⑤ | Railway 배포 + Phase 4c 토큰 갱신 cron | ⏳ 추후 | — |

## 핵심 설계 결정 (확정)

- **인프라 2개**: Upstash Redis(BullMQ broker) + Railway(Worker 호스팅, 상주 프로세스). Vercel은 서버리스라 Worker 호스팅 불가.
- **호스팅 결정 근거**: 한 콘텐츠 → N개 SNS 채널 fan-out 규모와 플랫폼별 rate limit 제어가 BullMQ `concurrency`/`rate limiter`에 의존. QStash + Vercel function 패턴 검토 후 기각. 자세한 비교는 CLAUDE.md `## 주의사항` 참조.
- **Connection 분리**:
  - 워커는 [worker/redis.ts](../worker/redis.ts)의 상주 ioredis singleton 재사용
  - Server Action(Vercel function)은 [lib/queue/publish-queue.ts](../lib/queue/publish-queue.ts)의 `enqueuePublishJobs`가 매 호출 새 IORedis 생성 → addBulk → quit
- **jobId = publish_jobs.id (UUID)**: BullMQ가 중복 enqueue 자동 차단. 추후 cron이 "DB PENDING인데 큐 미존재" 조회 시 jobId로 즉시 lookup
- **부분 실패 정책**: enqueue 실패 시 DB rollback 안 함. publish_jobs는 PENDING으로 남고 자동 복구 cron은 Phase 4c에서 처리

## 주요 파일 위치

```
worker/
├── load-env.ts            # dev에서 .env.local 명시 로드 (prod는 Railway env)
├── redis.ts               # ioredis singleton (maxRetriesPerRequest:null, enableReadyCheck:false)
├── index.ts               # Worker entry + processPublishJob 호출 + graceful shutdown
├── dev-enqueue.ts         # 검증용 — 매번 randomUUID로 enqueue
└── processors/
    └── publish-processor.ts  # ③ 상태 머신 + status_history + stubPublish (④에서 교체)

lib/queue/publish-queue.ts  # PUBLISH_QUEUE_NAME, PublishJobData, enqueuePublishJobs (Vercel 안전)
lib/supabase/service.ts     # createServiceClient — server-only 가드 제거, typeof window 가드
app/(dashboard)/actions.ts  # createPublishJobsAction이 INSERT 후 enqueuePublishJobs 호출
.vercelignore               # worker/ 제외
```

큐 이름: **`mcb-publish`** (BullMQ가 `:` 금지하여 kebab-case)

## 검증 명령어

로컬에서:

```powershell
# 워커 띄우기 (Ctrl+C로 중단)
npm run worker

# 다른 터미널에서 더미 enqueue (매번 새 UUID, row 없음 → 3회 재시도 → FAILED 검증)
npm run worker:enqueue
```

성공 path 검증은 실제 `publish_jobs` row가 있어야 함 — 마법사로 콘텐츠 만들 때 자연스럽게 검증되거나, ④ 어댑터 완성 후 별도 e2e.

## ④ 슬라이스 진입 가이드

**목표**: `worker/processors/publish-processor.ts`의 `stubPublish()`를 실제 플랫폼 어댑터 호출로 교체.

**현재 stub** ([worker/processors/publish-processor.ts:166](../worker/processors/publish-processor.ts#L166)):
```ts
async function stubPublish(row: PublishJobRow): Promise<PublishResult> {
  await new Promise((resolve) => setTimeout(resolve, 200));
  return {
    platformPostId: `stub-${row.id.slice(0, 8)}-${Date.now()}`,
    platformPostUrl: `https://example.com/stub/${row.id}`,
  };
}
```

**작업 분해**:
1. `publish-processor`에서 `row.social_account_id`로 `social_accounts` 조회 → `platform`, 토큰(`access_token_encrypted` 복호화) 확보
2. `contents` 조회 → `media_urls`, `ai_captions`(jsonb) 확보. `media_urls`는 Supabase Storage 경로 → 단기 서명 URL 생성 필요 (Instagram이 cURL로 가져감)
3. `lib/platforms/{platform}.ts`에 `publish(account, content)` 메소드 추가 — 현재 OAuth 어댑터에 buildAuthUrl/exchangeCode만 있음
4. `processPublishJob` 안에서 platform 분기로 어댑터 호출 → `{platformPostId, platformPostUrl}` 반환
5. 에러 분류 — rate limit(재시도 가치 있음) vs 토큰 만료(즉시 FAILED, social_accounts.is_active=false) vs 기타

**첫 타깃 플랫폼 추천**: **YouTube** — `lib/platforms/youtube.ts` OAuth는 Phase 4a에서 완성 (`d7e9046`), 콘솔 가입이 가장 빠르고 할당량 명확 (10k units/day, 1.6k units/upload).

**플랫폼별 사양**: docs/functional-specification.md §5.

### Phase 4c 매끄러움을 위해 ④에서 같이 할 일 ⭐

각 플랫폼 어댑터에 `publish()` 추가할 때 **`refreshToken(account)`도 같은 파일에 함께 구현**. Phase 4c(토큰 자동 갱신 cron)가 같은 어댑터 패턴을 재사용하므로 0 비용으로 묶을 수 있고, 따로 짜면 어댑터 인터페이스를 두 번 재논의해야 함.

권장 인터페이스 확장 ([lib/platforms/types.ts](../lib/platforms/types.ts)):

```ts
export interface PlatformAdapter {
  buildAuthUrl(state: string): string;
  exchangeCode(code: string): Promise<TokenSet>;
  // ④ 신규
  publish(account: SocialAccount, content: Content): Promise<PublishResult>;
  // 4c용 — ④와 같이 추가
  refreshToken(account: SocialAccount): Promise<TokenSet>;
}
```

플랫폼별 refresh 주기 참고:
- Instagram: long-lived token 60일, 만료 전 refresh API로 연장
- TikTok: refresh_token으로 access_token 재발급, refresh_token도 주기적 갱신
- YouTube/Google: refresh_token 영구(폐기 안 하면), access_token 1시간

## 미해결 cleanup task

새 세션에서 ④ 시작 전 또는 별도 ad-hoc commit으로:

1. **`server-only` 패키지 제거** — Phase 4b ③에서 `lib/supabase/service.ts`가 더 이상 import하지 않음
   ```
   npm uninstall server-only
   ```
2. **`worker/processors/publish-processor.ts`의 untyped SupabaseClient cast 제거** — types/database.ts가 0007 컬럼을 반영하므로 cast 불필요. [publish-processor.ts:55](../worker/processors/publish-processor.ts#L55) 라인의 `as unknown as SupabaseClient` 제거하고 정상 generic client로 복귀.
3. **`npm audit` 경고** — next 16.2.5 → 16.2.6 권장 (postcss XSS, middleware bypass). 본 작업과 무관.

## 다음 세션 시작 체크리스트

새 세션이 ④로 진입하기 전:

- [ ] `git log --oneline -5`로 현재 위치 확인 (`80a1bf5` 또는 이후)
- [ ] `.env.local`에 `REDIS_URL=rediss://...` 있는지 (없으면 Upstash 콘솔에서 다시)
- [ ] **좀비 워커 정리**: 이전 세션의 워커 process가 살아있을 수 있음
  ```powershell
  Get-WmiObject Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match "worker/index\.ts" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  ```
- [ ] Upstash 콘솔에서 `bull:mcb-publish:*` 키 정리할지 결정 (이전 검증 잔재). 필요 시 `FLUSHDB`로 큐 초기화 — 다만 운영 데이터 없으므로 안전
- [ ] `lib/platforms/youtube.ts` (또는 첫 타깃 플랫폼)의 OAuth 어댑터 점검 — `publish()` 메소드를 어디 추가할지

## 트러블슈팅 노트 (이번 세션에서 발견·해결)

| 증상 | 원인 | 해결 |
|------|------|------|
| `Queue name cannot contain ':'` | BullMQ가 콜론 금지 (내부 키 충돌) | `mcb:publish` → `mcb-publish` |
| `ECONNRESET` 즉시 | URL이 `redis://` (평문). Upstash는 TLS 필수 | `rediss://` (s 두 개)로 정정 |
| `server-only` throw | server-only 패키지가 항상 throw, Next.js가 빌드 시 alias로 우회. 워커(tsx)는 우회 없음 | service.ts에서 import 제거 + `typeof window` 가드로 대체 |
| 새 enqueue가 worker pickup 안 됨 | TaskStop이 ioredis blocking command를 깨끗이 안 죽여 좀비 워커 18개 누적. 좀비가 새 job 가로챔 | PowerShell `Stop-Process -Force`로 직접 정리 |
| `types/database.ts`가 0007 컬럼 미반영 | 마이그레이션 적용 후 `supabase gen types` 미실행 | 사용자가 재생성. 다음 cleanup에서 cast 제거 |

## 진행 명령 모음 (재현용)

```powershell
# 워커 + 검증
npm run worker
npm run worker:enqueue   # 다른 터미널

# 좀비 정리
Get-WmiObject Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match "worker/index\.ts" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# Redis 큐 상태 확인 (Upstash CLI 탭)
KEYS bull:mcb-publish:*
HGETALL bull:mcb-publish:meta
LRANGE bull:mcb-publish:wait 0 -1

# 타입 체크
npx tsc --noEmit
```

## 외부 참조

- BullMQ docs: https://docs.bullmq.io
- Upstash + BullMQ 가이드: https://upstash.com/docs/redis/integrations/bullmq
- `CLAUDE.md` `## 주의사항`의 "Worker 호스팅 결정" 단락 — 인프라 결정 근거 단일 출처

# Phase 4b — BullMQ Worker 구축 진행 상황

이 문서는 새 세션이 빠르게 컨텍스트를 잡을 수 있도록 작성. 마지막 업데이트 2026-05-13.

## 슬라이스 진행 상태

| # | 슬라이스 | 상태 | 커밋 |
|---|---------|------|------|
| ① | 인프라 + Worker 골격 (Upstash, BullMQ, redis/queue/index) | ✅ 완료 | `1fd146c` |
| ② | Server Action enqueue 연결 (`enqueuePublishJobs`) | ✅ 완료 | `cd1f868` |
| ③ | Worker processor 상태 머신 + status_history + 멱등성 | ✅ 완료 | `80a1bf5` |
| ④ | YouTube `publish()` 어댑터 + 토큰 자동 refresh | ✅ 완료 | `4cd92af` |
| ⑤-a | Railway 배포 설정 (railway.json, package.json engines, tsx→deps) | ✅ 완료 | (이 커밋) |
| ⑤-b | Phase 4c 토큰 갱신 cron (BullMQ repeatable) | ⏳ 다음 | — |
| 후속 | Instagram / TikTok `publish()` 구현 | ⏳ 추후 | — |

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

## ④ 완료 요약 (commit `4cd92af`)

`lib/platforms/types.ts`에 인터페이스 확장:
```ts
interface PlatformAdapter {
  buildAuthUrl(state, redirectUri): string;
  exchangeCode(code, redirectUri): Promise<OAuthTokens>;
  publish(ctx: PublishContext, accessToken: string): Promise<PublishResult>;
  refreshToken(refreshTokenPlain: string): Promise<RefreshedTokens>;
}
```

어댑터는 plain text만 다루고 **암복호화는 워커가 책임**. 에러 분류 클래스 4개(`TokenExpiredError` / `RateLimitedError` / `MediaError` / `PublishError`)로 워커가 instanceof 분기.

- **YouTube** (`lib/platforms/youtube.ts`): videos.insert multipart upload + oauth2/token refresh_token grant. HTTP 401/403 quotaExceeded/429 → 우리 에러 매핑. invalid_grant는 TokenExpired로 분류.
- **Instagram / TikTok**: 후속 슬라이스 stub (`throw new PublishError("…")`).
- **server-only 제거**: lib/platforms/*는 워커가 import해야 하는데 server-only가 tsx에서 throw. `lib/platforms/server-guard.ts`의 `typeof window` 가드로 대체.
- **워커 processor**: `social_accounts`/`contents` 조회 + 만료 1분 전 자동 refresh + DB 재암호화 + Storage 단기 서명 URL(10분) + `ai_captions`(jsonb)에서 플랫폼별 필드 추출. TokenExpired 시 `is_active=false` 마킹.

### e2e 검증 절차 (사용자 환경)

타입 검증은 통과했지만 실제 업로드 검증은 사용자 환경에서만 가능:

1. Google Cloud Console에서 OAuth 클라이언트 발급 + YouTube Data API v3 활성화
2. `.env.local`에 `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` 입력
3. 앱에서 YouTube 계정 연동 (`/accounts`)
4. `/upload`에서 영상 콘텐츠 마법사 진행 → YouTube 채널 선택 → 게시
5. Vercel function이 `publish_jobs` row INSERT + `enqueuePublishJobs` 호출
6. Railway 워커가 pickup → 멀티파트 업로드 → `https://www.youtube.com/watch?v=<id>` 반환
7. UI `/postings`에서 status_history 확인

## ⑤-a 완료 요약 (이 커밋)

Railway 배포 준비:
- `railway.json` — Nixpacks 빌드 + `startCommand: npm run worker` + ON_FAILURE 재시작(10회)
- `package.json` — `engines.node: ">=20.0.0"`, **tsx를 dependencies로 이동** (Railway는 NODE_ENV=production에서 devDeps 미설치 → `npm run worker`가 tsx 찾지 못함)
- `.env.example` — Railway env 명세 + AES-256-GCM 오기를 CBC로 정정 (`lib/crypto.ts`와 일치)

### 사용자 콘솔 작업 (Railway)

1. https://railway.app 가입 + GitHub repo 연결
2. New Project → Deploy from GitHub repo → `multi-content-bomber` 선택
3. Service Settings → 자동 감지(Nixpacks) + railway.json의 startCommand 사용 확인
4. Variables 탭에 prod env 입력 (`.env.example` 하단 명세 참조)
5. Deploy 트리거 → Logs에서 `[redis] connecting` + `[worker] ready` 두 줄 확인
6. Upstash 콘솔에서 동일 Redis URL 사용 — Vercel(producer)과 Railway(consumer)가 같은 큐 공유

### 주의

- Vercel과 Railway가 **같은 Upstash Redis**를 봐야 큐가 통한다. 다른 인스턴스 쓰면 무한 PENDING.
- `ENCRYPTION_KEY`는 prod와 dev가 **같은 값**이어야 토큰 복호화 가능. Railway에 다른 값 넣으면 모든 토큰 unrecoverable.

## ⑤-b 진입 가이드 (Phase 4c — 토큰 갱신 cron)

**목표**: 만료 임박한 access_token을 미리 자동 refresh해서, 실제 publish 시점에 만료된 토큰으로 실패하는 케이스를 줄인다.

**전략**: BullMQ **repeatable job**으로 매 N분마다 만료 임박 계정을 일괄 refresh.

**작업 분해**:
1. 새 큐 `mcb-token-refresh` (또는 같은 워커에서 별도 processor) 정의
2. Repeatable job 등록: 워커 부팅 시 `queue.add(..., { repeat: { every: 30 * 60 * 1000 } })` — 30분 주기
3. Processor: `social_accounts`에서 `token_expires_at < now + 1h AND is_active = true AND refresh_token_encrypted IS NOT NULL` 일괄 조회 → 각각 `adapter.refreshToken()` 호출 → DB 업데이트
4. `TokenExpiredError`(invalid_grant) 받은 계정은 `is_active=false`로 마킹
5. 같은 어댑터 인터페이스 재사용 — ④에서 이미 refreshToken을 같이 구현했으므로 추가 어댑터 수정 없음 ⭐

**참고 — 플랫폼별 refresh 주기**:
- YouTube/Google: refresh_token 영구(폐기 안 하면), access_token 1시간
- TikTok: refresh_token으로 access_token 재발급, refresh_token도 주기적 갱신
- Instagram: long-lived token 60일, 만료 전 refresh API로 연장 (단 refreshToken stub 아직 미구현)

## 다음 세션 시작 체크리스트

새 세션이 ⑤-b(Phase 4c cron)로 진입하기 전:

- [ ] `git log --oneline -5`로 현재 위치 확인 (`4cd92af` 또는 이후)
- [ ] `.env.local`에 `REDIS_URL=rediss://...` 있는지 (없으면 Upstash 콘솔에서 다시)
- [ ] **좀비 워커 정리**: 이전 세션의 워커 process가 살아있을 수 있음
  ```powershell
  Get-WmiObject Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match "worker/index\.ts" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  ```
- [ ] Upstash 콘솔에서 `bull:mcb-publish:*` 키 정리할지 결정 (이전 검증 잔재). 필요 시 `FLUSHDB`로 큐 초기화 — 다만 운영 데이터 없으므로 안전
- [ ] Railway가 이미 배포 중이면 — 새 큐 추가 시 같은 워커 프로세스에서 처리할지(권장) 별도 서비스로 분리할지 결정

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

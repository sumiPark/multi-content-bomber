# Phase 4b — BullMQ Worker 구축 진행 상황

이 문서는 새 세션이 빠르게 컨텍스트를 잡을 수 있도록 작성. 마지막 업데이트 2026-05-13.

## 슬라이스 진행 상태

| # | 슬라이스 | 상태 | 커밋 |
|---|---------|------|------|
| ① | 인프라 + Worker 골격 (Upstash, BullMQ, redis/queue/index) | ✅ 완료 | `1fd146c` |
| ② | Server Action enqueue 연결 (`enqueuePublishJobs`) | ✅ 완료 | `cd1f868` |
| ③ | Worker processor 상태 머신 + status_history + 멱등성 | ✅ 완료 | `80a1bf5` |
| ④ | YouTube `publish()` 어댑터 + 토큰 자동 refresh | ✅ 완료 | `4cd92af` |
| ⑤-a | Railway 배포 설정 (railway.json, package.json engines, tsx→deps) | ✅ 완료 | `60c50cf` |
| ⑤-b | Phase 4c 토큰 갱신 cron (BullMQ Job Scheduler) | ✅ 완료 | `99d034e` |
| 후속-a | Instagram `publish()` / `refreshToken()` 구현 | ✅ 완료 | (이 커밋) |
| 후속-b | TikTok `publish()` / `refreshToken()` 구현 | ⏳ 추후 | — |

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

## ⑤-b 완료 요약 (이 커밋)

만료 임박 access_token을 30분 주기로 일괄 refresh하는 BullMQ Job Scheduler.

- `lib/queue/token-refresh-queue.ts` — 큐 이름 `mcb-token-refresh`, 주기 30분, scheduler ID `token-refresh-sweep`. publish 큐와 분리 (페이로드/동시성 정책이 완전히 다름).
- `worker/processors/token-refresh-processor.ts` — `social_accounts`에서 `token_expires_at < now + 1h AND is_active = true AND refresh_token_encrypted IS NOT NULL`인 행 최대 100개를 조회해 직렬로 `adapter.refreshToken()` 호출. 성공 시 새 토큰을 암호화해 DB 업데이트. `TokenExpiredError`(invalid_grant)면 `is_active=false`로 마킹.
- `worker/index.ts` — 두 번째 `Worker(TOKEN_REFRESH_QUEUE_NAME, …, { concurrency: 1 })` 추가 + `setupSchedulers()`에서 `queue.upsertJobScheduler()`로 idempotent 등록. shutdown은 두 워커 동시에 drain.

운영 디버그용 — 특정 계정만 강제 refresh: `TokenRefreshJobData.accountIds`에 ID 배열을 넣고 `queue.add()`로 1회성 등록. sweep 본래 로직(만료 임박 필터)을 우회한다.

**플랫폼별 refresh 주기**:
- YouTube/Google: refresh_token 영구(폐기 안 하면), access_token 1시간
- TikTok: refresh_token으로 access_token 재발급, refresh_token도 주기적 갱신
- Instagram: long-lived token 60일, 만료 전 refresh API로 연장 (refreshToken stub 아직 미구현)

## 다음 세션 시작 체크리스트

Phase 4b 코어 슬라이스(①~⑤-b)는 모두 완료. 새 세션 진입 시점에 따라:

**Railway 배포 / e2e 검증으로 진입할 때**
- [ ] `git log --oneline -5`로 현재 위치 확인
- [ ] Railway 콘솔에서 GitHub 연결 + Variables 입력 (.env.example 하단 참조)
- [ ] Deploy 후 Logs에 `[publish] ready` + `[token-refresh] ready` + `[token-refresh] scheduler upserted` 세 줄 확인
- [ ] 첫 30분 뒤 `[token-refresh] sweep start` 로그가 뜨는지 (없으면 scheduler 미등록)

**Instagram / TikTok publish 후속 슬라이스로 진입할 때**
- [ ] `lib/platforms/{instagram,tiktok}.ts`의 `publish()` stub 자리 교체. PlatformAdapter 인터페이스는 이미 정의됨
- [ ] Instagram: container 생성 → publish 2단계, business 계정 검증 필요
- [ ] TikTok: PULL_FROM_URL 흐름 — Storage 서명 URL을 그대로 넘기면 TikTok이 fetch
- [ ] 어댑터 추가 후 `refreshToken()`도 동시에 구현 — sweep이 자동으로 잡아줌

**좀비 워커 정리** (로컬에서 worker 재시작 전):
```powershell
Get-WmiObject Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match "worker/index\.ts" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

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

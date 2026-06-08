@AGENTS.md

# MCB (Multi-Channel Broadcast) - AI 멀티 채널 콘텐츠 배포 시스템

## 프로젝트 개요
YouTube, Instagram, TikTok에 영상/이미지를 동시 업로드하는 AI 기반 콘텐츠 배포 플랫폼.
OpenAI GPT-4o로 플랫폼별 캡션을 자동 생성하고, 최적 시간에 예약 업로드한다.

## 기술 스택
- **프레임워크:** Next.js 16 (App Router, Turbopack 기본)
- **언어:** TypeScript (strict mode)
- **인증/DB:** Supabase (Auth + PostgreSQL + Storage)
- **상태관리:** React useState/useReducer 기본 — 글로벌 상태가 필요해지면 Zustand 도입 검토
- **UI:** Tailwind CSS v4 (config-less) + shadcn/ui (base-nova) + framer-motion
- **AI:** OpenAI GPT-4o API (Vision + JSON Schema strict mode)
- **큐:** Postgres(publish_jobs 테이블) + `claim_due_publish_jobs` RPC(FOR UPDATE SKIP LOCKED) — BullMQ/Redis 제거
- **배포:** Vercel (프론트, 서버리스) + GitHub Actions (워커 — cron 30분 sweep + repository_dispatch 즉시)

## ⚠️ Next.js 16 차이점 (자주 틀리는 지점)
- `middleware.ts` → **`proxy.ts`** (이름 변경, 함수명도 `proxy`)
- `cookies()` / `headers()`가 **async** (`await cookies()` 필요)
- Tailwind v4는 **config-less** — `tailwind.config.js` 없음. `app/globals.css`에 `@theme inline` 블록으로 토큰 정의
- `next build`는 자동 lint 실행 안 함 — `npm run lint` 별도 호출
- 자세한 가이드는 `node_modules/next/dist/docs/01-app/` 정독

## 프로젝트 구조 (실제 현황)

```
multi-content-bomber/
├── CLAUDE.md / AGENTS.md
├── package.json
├── next.config.ts
├── tsconfig.json
├── proxy.ts                            # Next.js 16 proxy (구 middleware)
├── .env.local / .env.example
│
├── app/                                # App Router (src/ 미사용)
│   ├── layout.tsx
│   ├── globals.css                     # Tailwind v4 + shadcn 토큰
│   ├── (auth)/
│   │   ├── layout.tsx
│   │   ├── actions.ts                  # login, signup, signOut
│   │   ├── login/{page,login-form}.tsx
│   │   └── signup/{page,signup-form}.tsx
│   └── (dashboard)/
│       ├── layout.tsx                  # 4-그룹 사이드바: (대시보드/분석) · 콘텐츠 · 자동화 · 설정
│       ├── page.tsx                    # 액션 허브 대시보드 (또는 ?content=<id>로 단건 보기)
│       ├── actions.ts                  # generateCaptions, updateCaptions, createPublishJobs
│       ├── onboarding/{page,onboarding-forms,actions}.ts
│       ├── accounts/page.tsx           # 계정 연동 (OAuth + 그룹)
│       ├── presets/{page,actions}.tsx  # AI 프리셋 (캡션 템플릿)
│       ├── contents/page.tsx           # 보관함
│       ├── upload/page.tsx             # 콘텐츠 생성 (5-step 마법사 진입)
│       ├── postings/page.tsx           # 배포 관리
│       ├── analytics/page.tsx          # 분석 (Phase 1 골격)
│       ├── auto-reply/page.tsx         # DM 자동 응답 (coming soon)
│       ├── schedule-rules/page.tsx     # 예약 규칙 (coming soon)
│       └── uploads/page.tsx            # /postings 영구 리다이렉트 (구 업로드 이력)
│
├── components/
│   ├── ui/                             # shadcn/ui 기본 (kebab-case 파일명)
│   ├── layout/
│   │   ├── sidebar-shell.tsx           # 4-그룹 사이드바 + 모바일 drawer + 뱃지(count/soon)
│   │   └── coming-soon.tsx             # 자동화 그룹 추후 구현 안내 화면
│   ├── dashboard/
│   │   ├── dashboard-hub.tsx           # 액션 허브 (헤더/실패바/통계/예정/연동/빠른작업)
│   │   └── organization-card.tsx
│   ├── accounts/accounts-page.tsx      # 계정 그룹 카드 + inline 그룹 이동
│   ├── postings/postings-page.tsx      # 배포 관리 필터·테이블·일괄 작업
│   ├── presets/presets-manager.tsx
│   ├── ai/caption-result.tsx
│   └── upload/
│       ├── image-dropzone.tsx          # framer-motion Reorder
│       └── wizard/
│           ├── upload-wizard.tsx       # 5-step 오케스트레이터
│           └── step-indicator.tsx
│
├── lib/
│   ├── supabase/
│   │   ├── client.ts                   # createBrowserClient<Database>
│   │   ├── server.ts                   # createServerClient<Database> (async cookies)
│   │   ├── service.ts                  # service_role 클라이언트 (토큰 컬럼/워커용)
│   │   └── proxy.ts                    # 토큰 갱신 헬퍼 (proxy.ts에서 사용)
│   ├── supabase.ts                     # 타입 안전 싱글톤 (anon)
│   ├── auth.ts                         # 요청 단위 getSessionUser/getCurrentProfile (react.cache)
│   ├── ai/caption-generator.ts         # GPT-4o + zod schema + 프롬프트
│   ├── openai.ts                       # OpenAI 싱글톤
│   ├── storage/upload.ts               # 클라이언트 Storage 업로드 헬퍼
│   ├── crypto.ts                       # 토큰 AES-256-GCM 암호화 (Phase 4a 구현)
│   ├── platforms/                      # OAuth 어댑터 (Phase 4a)
│   │   ├── types.ts                    # PlatformAdapter 인터페이스
│   │   ├── instagram.ts                # buildAuthUrl + exchangeCode
│   │   ├── tiktok.ts
│   │   ├── youtube.ts
│   │   └── index.ts
│   └── utils.ts                        # cn()
│
├── types/
│   └── database.ts                     # supabase gen types로 자동 생성
│
├── supabase/
│   └── migrations/                     # 4자리 일련번호
│       ├── 0001_init.sql               # 코어 스키마 + RLS
│       ├── 0002_invitations.sql
│       ├── 0003_storage.sql
│       ├── 0004_caption_presets.sql
│       ├── 0005_storage_video.sql
│       ├── 0006_token_columns_text.sql # bytea → text (base64) 전환
│       ├── 0007_publish_jobs_management.sql # CANCELLED + soft delete + status_history
│       ├── 0008_contents_internal_title.sql
│       ├── 0009_account_groups.sql     # 계정 그룹 (1:N)
│       └── 0010_dashboard_partial_indexes.sql
│
└── worker/                             # Postgres 큐 워커 (process-due.ts — GitHub Actions가 실행)
    ├── load-env.ts                     # dev .env.local 로드 (Actions/prod에선 no-op)
    ├── process-due.ts                  # 엔트리: claim_due_publish_jobs → 처리 → 토큰 sweep → exit
    └── processors/                     # publish / token-refresh 코어 (BullMQ-free)
```

## 코딩 컨벤션

### 일반
- 모든 응답과 주석은 **한국어**
- TypeScript strict mode 준수, `any` 사용 지양
- **파일명: kebab-case** (shadcn 관행)
- 컴포넌트는 함수형 (named export 권장)
- import 순서: react/next → 외부 → 내부 (`@/...`) → 타입

### Next.js 16
- App Router만 (`pages/` 금지)
- 서버 컴포넌트 기본, 인터랙션 필요 시 `'use client'`
- **데이터 변경은 Server Actions 우선** (`actions.ts`에 `"use server"`)
  - REST API Route는 외부 웹훅/콜백 등 꼭 필요할 때만
- 환경변수: `.env.local`, 클라이언트 노출은 `NEXT_PUBLIC_` 접두사

### 데이터베이스 (Supabase)
- 마이그레이션으로 스키마 관리 (`supabase/migrations/0001_*.sql` 4자리 일련번호)
- **RLS 필수** — 모든 테이블에 정책 적용
- 테이블/컬럼명 snake_case
- 직접 INSERT/UPDATE를 차단할 땐 `SECURITY DEFINER` RPC로 우회 (예: `create_organization`, `accept_invitation`)
- 타입은 `npx supabase gen types typescript --project-id <ref> > types/database.ts`로 자동 생성

### Supabase 클라이언트 사용 가이드
- **서버 컴포넌트/액션:** `lib/supabase/server.ts` (async cookies로 세션 동기화)
- **클라이언트 컴포넌트:** `lib/supabase/client.ts` (browser cookies)
- **proxy.ts:** `lib/supabase/proxy.ts` (토큰 갱신 전용)
- **익명 단순 쿼리:** `lib/supabase.ts` 싱글톤

### 에러 처리
- Server Action: discriminated union 반환 (`{ ok: true, ... } | { ok: false, error: string }`)
- 클라이언트: 인라인 메시지 (`text-destructive`)
- 토큰 관련 에러는 자동 재시도 로직 포함 (Phase 4)

### 시간 표시
- 서버에서 `Intl.DateTimeFormat`으로 ko-KR 포맷팅 시 hydration mismatch 발생 가능 (Node ICU 한정)
- 시각 표시는 `<RelativeTime iso={...} />` (`components/ui/relative-time.tsx`) 사용 — 클라이언트 마운트 후 포맷팅

## 주의사항
- OAuth 토큰은 반드시 AES-256-GCM으로 앱 레이어에서 암호화 후 DB 저장 (`bytea` 컬럼)
- YouTube API 일일 할당량(10,000 units) 고려한 업로드 수 제한
- Instagram API는 비즈니스/크리에이터 계정만 지원
- TikTok API 승인 난이도 높음 — Buffer/Hootsuite 우회 옵션 검토
- **Worker 호스팅 결정 (Phase 4b — 갱신됨):** 원래 BullMQ + Upstash Redis + Railway 상주 워커로 설계했으나, **상주 워커가 Redis를 24/7 폴링해 Upstash 무료 50만 커맨드/월을 며칠 만에 소진**(실제로 한도 초과로 발행 전체가 막힘)하고 Railway($5/월)+Upstash 비용이 이중으로 드는 문제로 **Postgres 큐 + GitHub Actions**로 전환했다.
  - **큐 = `publish_jobs` 테이블.** `claim_due_publish_jobs` RPC가 `FOR UPDATE SKIP LOCKED`로 due job(예약 시각 지난 PENDING/RETRYING + stale PROCESSING 회수)을 원자적으로 선점 → 동시 실행해도 중복 처리 없음. fan-out·동시성은 워커 스크립트(`process-due.ts`)가 `CONCURRENCY`로 제어, rate limit은 플랫폼 어댑터에서.
  - **실행 = GitHub Actions** (`.github/workflows/publish.yml`). `schedule` cron 30분(예약 발행 sweep) + `repository_dispatch`(즉시 발행 — 서버 액션 `lib/github-dispatch.ts`의 `triggerPublishRun()`이 깸, 지연 없음). 상주 프로세스 없음 → **Upstash·Railway 비용 0.** private repo도 ~1,440 run/월로 무료 2,000분 안.
  - **재시도:** BullMQ backoff 대신, 실패 시 row를 RETRYING으로 남기면 다음 sweep이 다시 claim. `attempts < 3` 동안 반복.
  - **트레이드오프:** 예약 발행은 cron best-effort라 5~30분 지연 가능(즉시 발행은 dispatch라 무관). 신뢰성이 더 필요하면 cron만 Railway Cron($5)으로 승격 — `process-due.ts`는 그대로 재사용.
  - **⚠️ GitHub Actions 함정:** `schedule` 워크플로는 repo가 **60일 무커밋이면 자동 비활성화**된다. 또 처리 단계는 **Vercel 함수(60초 timeout)에서 절대 돌리면 안 됨** — 긴 영상 업로드(IG 컨테이너 폴링 등)는 timeout 없는 Actions 러너에서만.

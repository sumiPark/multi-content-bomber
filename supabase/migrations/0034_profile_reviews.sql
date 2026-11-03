-- =====================================================================
-- 0034 — 계정 점검: 프로필 점수 (ig-profile-ko)
--
-- 인스타 계정 프로필을 12개 기준 100점으로 채점한 기록. 한 번 채점 = 한 행이라
-- 고친 뒤 다시 채점하면 점수 변화가 쌓인다.
--
--   status        PENDING(요청) → RUNNING(워커가 채점 중) → DONE / FAILED
--   manual_input  사람이 넣은 것 — 하이라이트 · 고정 게시물 · 스토리 빈도 · 연락 버튼 ·
--                 카테고리(API에 없음), 이름 칸 · 소개 · 링크(API가 안 주면 직접)
--                 다음 채점 때 화면이 마지막 값을 다시 채워 준다.
--   snapshot      채점에 쓴 프로필 (API 값 + 사람 입력을 합친 것)
--   items         12개 항목 [{id, label, max, score, auto, findings, reason}]
--                 auto=true는 규칙 채점(profile_ko.py), false는 AI 판단 채점
--   rewrites      고칠 순서대로 [{item_id, title, options[], why, warnings[]}]
--   rescore       다시 쓴 문구를 그대로 반영했을 때 예상 점수
--
-- 쓰기는 서버 액션(요청)과 워커(worker/review-profiles.ts)가 service_role로 한다.
-- authenticated는 같은 조직 SELECT만.
--
-- 적용: `supabase db push`. 앱 코드가 이 테이블을 조회하므로 배포 전에 먼저 적용할 것.
--   types/database.ts에는 수동으로 추가해 뒀다.
-- 기존 테이블은 건드리지 않는다.
-- =====================================================================

create table if not exists public.profile_reviews (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  social_account_id  uuid not null references public.social_accounts (id),
  status             text not null default 'PENDING'
    check (status in ('PENDING', 'RUNNING', 'DONE', 'FAILED')),
  manual_input       jsonb not null default '{}'::jsonb,
  snapshot           jsonb,
  total_score        int,
  items              jsonb,
  rewrites           jsonb,
  rescore            int,
  summary            text,
  model              text,
  tokens_input       int,
  tokens_output      int,
  error              text,
  requested_by       uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  started_at         timestamptz,
  finished_at        timestamptz
);

create index if not exists profile_reviews_account_created_idx
  on public.profile_reviews (social_account_id, created_at desc);

-- 워커가 대기 건만 빠르게 찾는다.
create index if not exists profile_reviews_pending_idx
  on public.profile_reviews (created_at)
  where status in ('PENDING', 'RUNNING');

alter table public.profile_reviews enable row level security;

drop policy if exists "profile_reviews_select_org" on public.profile_reviews;
create policy "profile_reviews_select_org" on public.profile_reviews
  for select to authenticated
  using (organization_id = public.current_org_id());

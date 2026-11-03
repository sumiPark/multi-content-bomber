-- =====================================================================
-- 0035 — 계정 점검: 스토리 올린 날 기록
--
-- 인스타 스토리는 24시간만 떠 있어서, 하루 한 번 "지금 떠 있는 스토리"를 보면 지난 24시간에
-- 올렸는지 알 수 있다. 프로필 자동 채점 워커(worker/review-profiles.ts)가 매일 기록하고,
-- 최근 7일 중 스토리 올린 날 수를 프로필 점수(스토리 항목)에 쓴다.
--
-- account_daily(성과 수집)와 따로 둔다 — 거기에 행을 만들면 분석 · 대시보드가 "수집됨"으로 읽는다.
-- 쓰기는 워커가 service_role로. authenticated는 같은 조직 SELECT만. 기존 테이블은 건드리지 않는다.
-- =====================================================================

create table if not exists public.account_story_days (
  social_account_id  uuid not null references public.social_accounts (id),
  day                date not null,                 -- KST 날짜 (확인한 날)
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  stories_count      int not null default 0,         -- 그때 떠 있던 스토리 수 (지난 24시간에 올린 것)
  checked_at         timestamptz not null default now(),
  primary key (social_account_id, day)
);

alter table public.account_story_days enable row level security;

drop policy if exists "account_story_days_select_org" on public.account_story_days;
create policy "account_story_days_select_org" on public.account_story_days
  for select to authenticated
  using (organization_id = public.current_org_id());

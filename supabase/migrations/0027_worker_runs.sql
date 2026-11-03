-- =====================================================================
-- 0027 — 워커 실행 기록 (상품 수집 · 상세페이지 분석 · 성과 수집)
--
-- GitHub Actions에서 도는 콘텐츠 자동화 워커가 시작 · 끝을 남긴다. 상품 화면의
-- "수집 · 분석 현황" 카드가 읽는다(지금 도는 중인지, 마지막으로 언제 돌았는지, 무엇이 실패했는지,
-- AI 토큰을 얼마나 썼는지). 기존 발행 · 시리즈 댓글 워커는 기록하지 않는다(건드리지 않음).
--
-- 쓰기는 워커가 service_role로 한다. authenticated는 SELECT만.
-- 적용: `supabase db push`. 기록이 실패해도 워커는 멈추지 않으므로 순서에 민감하지 않다.
-- =====================================================================

create table if not exists public.worker_runs (
  id             uuid primary key default gen_random_uuid(),
  worker         text not null check (worker in ('collect-products', 'analyze-products', 'collect-metrics')),
  -- running → success | failed. 러너가 죽어 running으로 남은 행은 화면이 오래되면 "중단됨"으로 본다.
  status         text not null default 'running' check (status in ('running', 'success', 'failed')),
  trigger        text,            -- schedule / repository_dispatch / workflow_dispatch / manual(로컬)
  github_run_url text,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  summary        jsonb not null default '{}'::jsonb,
  error          text
);

create index if not exists worker_runs_worker_started_idx
  on public.worker_runs (worker, started_at desc);

alter table public.worker_runs enable row level security;

drop policy if exists "worker_runs_select_auth" on public.worker_runs;
create policy "worker_runs_select_auth" on public.worker_runs
  for select to authenticated using (public.current_org_id() is not null);

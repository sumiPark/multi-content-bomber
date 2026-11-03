-- =====================================================================
-- 0032 — 에이전트 · 학습 (콘텐츠 자동화 5단계 5-3)
--
--   agent_settings   에이전트별 피드백 반영 방식 — HUMAN(사람 승인, 기본) / AUTO(자동 승인)
--   agent_playbooks  에이전트 지시문에 덧붙는 "추가 지침"의 버전 기록. 가장 큰 version이 지금 쓰는 것.
--                    비어 있으면(행이 없으면) 에이전트는 코드에 있는 기본 규칙만 쓴다.
--   agent_feedback   성과 분석 에이전트(6)가 올리는 플레이북 고치기 제안 — 사람이 반영 / 고쳐서 반영 / 거절.
--                    거절 이유는 다음 제안의 재료가 된다. (제안 만들기는 운영 7번부터)
--
-- 대상 에이전트: select(1 상품 선정) · plan(2 기획 · 글) · edit(3 편집).
--   check(4 점검)는 잠김(규칙은 광고 문구 규칙 화면에서 사람만), upload(5)는 학습 없음, analyze(6)는 제안하는 쪽.
-- 쓰기는 서버 액션이 service_role로(ADMIN · MANAGER 확인 뒤). authenticated는 같은 조직 SELECT만.
-- 적용: `supabase db push`. ⚠️ 앱 배포 전에 먼저. types/database.ts에는 수동으로 추가.
-- =====================================================================

create table if not exists public.agent_settings (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  agent           text not null check (agent in ('select', 'plan', 'edit')),
  approval_mode   text not null default 'HUMAN' check (approval_mode in ('HUMAN', 'AUTO')),
  updated_by      uuid references public.profiles (id) on delete set null,
  updated_at      timestamptz not null default now(),
  primary key (organization_id, agent)
);

drop trigger if exists trg_agent_settings_updated_at on public.agent_settings;
create trigger trg_agent_settings_updated_at before update on public.agent_settings
  for each row execute function public.set_updated_at();

create table if not exists public.agent_feedback (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  agent           text not null check (agent in ('select', 'plan', 'edit')),
  status          text not null default 'PENDING' check (status in ('PENDING', 'APPLIED', 'REJECTED')),
  title           text not null,
  -- 반영하면 플레이북이 이 글로 바뀐다(전 / 후 비교는 화면에서 지금 버전과)
  proposed_body   text not null check (char_length(proposed_body) <= 4000),
  -- 근거: {summary, sample, baseline, metric} — 표본 수 · 비교 기준
  evidence        jsonb not null default '{}'::jsonb,
  reject_reason   text,
  decided_by      uuid references public.profiles (id) on delete set null,
  decided_at      timestamptz,
  applied_version int,
  created_at      timestamptz not null default now()
);

create index if not exists agent_feedback_org_status_idx on public.agent_feedback (organization_id, status, created_at desc);

create table if not exists public.agent_playbooks (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  agent           text not null check (agent in ('select', 'plan', 'edit')),
  version         int not null check (version >= 1),
  body            text not null check (char_length(body) <= 4000),
  note            text check (char_length(note) <= 200),
  -- HUMAN 사람이 고침 · AUTO 제안 자동 반영 · FEEDBACK 제안을 사람이 반영 · ROLLBACK 예전 버전으로 되돌림
  source          text not null check (source in ('HUMAN', 'AUTO', 'FEEDBACK', 'ROLLBACK')),
  feedback_id     uuid references public.agent_feedback (id) on delete set null,
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (organization_id, agent, version)
);

alter table public.agent_settings  enable row level security;
alter table public.agent_playbooks enable row level security;
alter table public.agent_feedback  enable row level security;

drop policy if exists "agent_settings_select_org" on public.agent_settings;
create policy "agent_settings_select_org" on public.agent_settings
  for select to authenticated using (organization_id = public.current_org_id());

drop policy if exists "agent_playbooks_select_org" on public.agent_playbooks;
create policy "agent_playbooks_select_org" on public.agent_playbooks
  for select to authenticated using (organization_id = public.current_org_id());

drop policy if exists "agent_feedback_select_org" on public.agent_feedback;
create policy "agent_feedback_select_org" on public.agent_feedback
  for select to authenticated using (organization_id = public.current_org_id());

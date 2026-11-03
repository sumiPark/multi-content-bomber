-- =====================================================================
-- 0028 — 편성 · 기획안 · 에이전트 실행 기록 (콘텐츠 자동화 3단계 B 트랙)
--
--   slot_rules      계정마다 하루 발행 칸 — 기본 08:00 B · 12:00 A · 18:00 A · 21:00 B (KST)
--   track_settings  계정별 트랙 설정: 어떤 몰 · 종류 상품을 쓰는지, B 컨펌 마감, B 완전 자동(기본 꺼짐)
--   content_plans   칸 하나 = 기획안 하나. 상품 선정 에이전트(1)가 제안 → 사람 컨펌 → 대본(2) →
--                   영상(3) → 점검(4) → 예약(5). 상태로 흐름을 따라간다.
--   agent_runs      에이전트 실행 기록 — 어떤 스킬을 어떤 입력으로 불렀는지, 토큰, 결과.
--                   5단계 "에이전트 · 학습" 화면과 피드백(플레이북 개선)의 재료.
--
-- 쓰기는 워커 · 서버 액션이 service_role로. authenticated는 같은 조직 SELECT만.
-- 적용: `supabase db push`. ⚠️ 앱 배포 전에 먼저. types/database.ts에는 수동으로 추가.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. slot_rules
-- ---------------------------------------------------------------------
create table if not exists public.slot_rules (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  social_account_id uuid not null references public.social_accounts (id),
  slot_time         text not null check (slot_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),  -- KST HH:MM
  track             text not null check (track in ('A', 'B')),
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  unique (social_account_id, slot_time)
);

-- ---------------------------------------------------------------------
-- 2. track_settings
-- ---------------------------------------------------------------------
create table if not exists public.track_settings (
  social_account_id   uuid primary key references public.social_accounts (id),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  -- 이 계정이 쓰는 상품: [{"shop":"ru","kind":"COSMETIC"}, ...]
  product_scopes      jsonb not null default '[]'::jsonb,
  -- B 상품 컨펌 마감 — 발행 전날 이 시각(KST)까지. 지나면 그 칸은 건너뛴다.
  b_confirm_deadline  text not null default '18:00' check (b_confirm_deadline ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  -- B 완전 자동: 상품 고르기까지 AI가. 처음엔 꺼 둔다(검사 기록이 쌓인 계정부터 사람이 켬).
  b_full_auto         boolean not null default false,
  -- 같은 상품을 이 계정에서 다시 쓰기까지 최소 간격(일)
  repeat_gap_days     int not null default 14 check (repeat_gap_days between 0 and 365),
  updated_at          timestamptz not null default now()
);

drop trigger if exists trg_track_settings_updated_at on public.track_settings;
create trigger trg_track_settings_updated_at before update on public.track_settings
  for each row execute function public.set_updated_at();

-- 기본값 — 2026-11-03 사용자 확정 역할. 지금 연결된 계정만 채워지고(@jior_joong은 미연결),
-- 나중에 연결되는 계정은 화면에서 추가한다.
--   fruit_cuma → 오늘과일 과일 / joongdi → 리유 화장품 + 건기식(리유 건강식품 · 쿠마마켓 식품)
--   jjoongb → 리유 화장품 / jior_joong → 리유 의류
insert into public.track_settings (social_account_id, organization_id, product_scopes)
select s.id, s.organization_id,
  case s.display_name
    when 'fruit_cuma' then '[{"shop":"cuma","kind":"FRUIT"}]'::jsonb
    when 'joongdi'    then '[{"shop":"ru","kind":"COSMETIC"},{"shop":"ru","kind":"HEALTH_FOOD"},{"shop":"cm","kind":"HEALTH_FOOD"}]'::jsonb
    when 'jjoongb'    then '[{"shop":"ru","kind":"COSMETIC"}]'::jsonb
    when 'jior_joong' then '[{"shop":"ru","kind":"CLOTHING"}]'::jsonb
  end
from public.social_accounts s
where s.platform = 'INSTAGRAM'
  and s.disconnected_at is null
  and s.display_name in ('fruit_cuma', 'joongdi', 'jjoongb', 'jior_joong')
on conflict (social_account_id) do nothing;

insert into public.slot_rules (organization_id, social_account_id, slot_time, track)
select t.organization_id, t.social_account_id, v.slot_time, v.track
from public.track_settings t
cross join (values ('08:00', 'B'), ('12:00', 'A'), ('18:00', 'A'), ('21:00', 'B')) as v(slot_time, track)
on conflict (social_account_id, slot_time) do nothing;

-- ---------------------------------------------------------------------
-- 3. content_plans
--    PROPOSED  상품 선정 에이전트가 제안(사람 컨펌 대기)
--    CONFIRMED 사람이 컨펌(또는 완전 자동) → 대본 대기
--    SCRIPTED  기획 · 글 에이전트가 대본 · 캡션 작성 → 영상 대기
--    RENDERED  편집 에이전트가 영상 완성 → 점검 대기
--    BLOCKED   점검에 걸림 — 멈추고 알림 (사람이 고치거나 건너뜀)
--    SCHEDULED 점검 통과 → publish_jobs 예약
--    PUBLISHED 발행됨 / SKIPPED 컨펌 마감 지남 · 사람이 건너뜀 / FAILED 처리 오류
-- ---------------------------------------------------------------------
create table if not exists public.content_plans (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  social_account_id uuid not null references public.social_accounts (id),
  slot_date         date not null,          -- KST 발행 날짜
  slot_time         text not null,          -- KST HH:MM
  track             text not null check (track in ('A', 'B')),
  status            text not null default 'PROPOSED'
    check (status in ('PROPOSED', 'CONFIRMED', 'SCRIPTED', 'RENDERED', 'BLOCKED', 'SCHEDULED', 'PUBLISHED', 'SKIPPED', 'FAILED')),
  product_id        uuid references public.products (id) on delete set null,
  -- 선정 이유와 다른 후보 [{product_id, reason}] — 컨펌 화면에서 바꿀 때 보여 준다
  proposal          jsonb not null default '{}'::jsonb,
  -- 사람이 컨펌할 때 상품을 바꿨는지 (선정 에이전트 피드백 재료)
  product_changed   boolean not null default false,
  confirmed_by      uuid references public.profiles (id) on delete set null,
  confirmed_at      timestamptz,
  script            jsonb,                  -- 대본 · 화면 문구 · 캡션 · 해시태그
  check_result      jsonb,                  -- 점검 결과 (걸린 항목)
  content_id        uuid references public.contents (id) on delete set null,
  publish_job_id    uuid references public.publish_jobs (id) on delete set null,
  note              text,
  error             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (social_account_id, slot_date, slot_time)
);

create index if not exists content_plans_status_idx on public.content_plans (status, slot_date);
create index if not exists content_plans_product_idx on public.content_plans (product_id, slot_date desc);

drop trigger if exists trg_content_plans_updated_at on public.content_plans;
create trigger trg_content_plans_updated_at before update on public.content_plans
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 4. agent_runs
-- ---------------------------------------------------------------------
create table if not exists public.agent_runs (
  id            uuid primary key default gen_random_uuid(),
  -- 1 select · 2 plan · 3 edit · 4 check · 5 upload · 6 analyze
  agent         text not null check (agent in ('select', 'plan', 'edit', 'check', 'upload', 'analyze')),
  plan_id       uuid references public.content_plans (id) on delete set null,
  status        text not null default 'running' check (status in ('running', 'success', 'failed')),
  model         text,
  playbook_version int,                     -- 5단계 agent_playbooks 버전 (그 전엔 null)
  input         jsonb not null default '{}'::jsonb,
  -- [{skill, args, ok, ms}] — 어떤 스킬을 불렀는지
  skill_calls   jsonb not null default '[]'::jsonb,
  output        jsonb,
  tokens_input  int,
  tokens_output int,
  error         text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);

create index if not exists agent_runs_agent_started_idx on public.agent_runs (agent, started_at desc);
create index if not exists agent_runs_plan_idx on public.agent_runs (plan_id);

-- ---------------------------------------------------------------------
-- 5. RLS — 같은 조직 SELECT만 (agent_runs는 조직 컬럼이 없어 로그인 사용자 SELECT)
-- ---------------------------------------------------------------------
alter table public.slot_rules     enable row level security;
alter table public.track_settings enable row level security;
alter table public.content_plans  enable row level security;
alter table public.agent_runs     enable row level security;

drop policy if exists "slot_rules_select_org" on public.slot_rules;
create policy "slot_rules_select_org" on public.slot_rules
  for select to authenticated using (organization_id = public.current_org_id());

drop policy if exists "track_settings_select_org" on public.track_settings;
create policy "track_settings_select_org" on public.track_settings
  for select to authenticated using (organization_id = public.current_org_id());

drop policy if exists "content_plans_select_org" on public.content_plans;
create policy "content_plans_select_org" on public.content_plans
  for select to authenticated using (organization_id = public.current_org_id());

drop policy if exists "agent_runs_select_auth" on public.agent_runs;
create policy "agent_runs_select_auth" on public.agent_runs
  for select to authenticated using (public.current_org_id() is not null);

-- =====================================================================
-- 0055 — lemo 코드 애니메이션 제작 기록 · 계정 캐릭터 라이브러리 (2026-11-10)
--
-- lemo 경로(lib/lemo, worker/lemo-video.ts)는 명시적으로 고를 때만 돈다. 기존 AI 자동 · 직접 촬영 흐름은 이 표를 읽지 않는다.
--
--   lemo_productions  영상 한 편의 제작 기록: 제작 방식 선택(choice) · 장면 데이터(production) · 캐릭터 재사용/새로(characters)
--                     · 자동 검사(checks) · 사용량과 비용(usage: lib/lemo/usage.ts UsageLedger.summarize) · 완성본 경로 · 오류.
--                     plan_id는 null 허용(로컬 대본 시험 · 비교 시험은 칸이 없다).
--   lemo_characters   계정(account_key) · 시리즈별 캐릭터 명세. 같은 계정 안에서만 재사용한다(다른 계정 캐릭터를 쓰지 않는다).
--                     rig_path · sheet_path는 저장 공간 경로(코드 · 시트 그림), spec은 contract.ts characterSpecSchema.
--   account_concepts.lemo_preferred_styles  계정의 선호 lemo 스타일 slug(기본값일 뿐 강제하지 않는다). 기본 빈 배열.
--
-- 쓰기는 워커가 service_role로 한다. authenticated는 같은 조직 SELECT만(0030 · 0038과 같은 방식).
-- 추가만 한다. 기존 화면 · 쿼리는 account_concepts를 칸 이름으로 골라 읽어(select * 없음) 새 칸의 영향이 없다.
-- 적용: `supabase db push`. types/database.ts에는 아직 넣지 않았다(워커는 이 두 표를 타입 없이 쓴다).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. lemo_productions
--    status: PLANNED(선택까지) · RENDERING · RENDERED(완성본) · NEEDS_REVIEW(완성본은 있으나 캐릭터 시트 · 렌더 검사 문제가 남음) · FAILED
-- ---------------------------------------------------------------------
create table if not exists public.lemo_productions (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  plan_id            uuid references public.content_plans (id) on delete set null,
  social_account_id  uuid references public.social_accounts (id),
  account_key        text not null,
  backend            text not null check (backend in ('lemo-code', 'auto-video')),
  style              text,
  render_mode        text check (render_mode in ('2d', '2.5d', '3d')),
  status             text not null default 'PLANNED'
    check (status in ('PLANNED', 'RENDERING', 'RENDERED', 'NEEDS_REVIEW', 'FAILED')),
  -- ProductionChoice (contract.ts productionChoiceSchema)
  choice             jsonb not null default '{}'::jsonb,
  -- Production (contract.ts productionSchema)
  production         jsonb,
  -- {reused: [character id], created: [{id, sheet}]}
  characters         jsonb not null default '{"reused": [], "created": []}'::jsonb,
  -- lib/lemo/checks.ts 요약 (길이 · 빈 프레임 · 정지 장면 · 음량)
  checks             jsonb,
  -- lib/lemo/usage.ts UsageSummary (actual · api_rate · estimate 비용 분리)
  usage              jsonb,
  video_path         text,
  cover_path         text,
  error              text,
  started_at         timestamptz,
  finished_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists lemo_productions_org_idx on public.lemo_productions (organization_id, created_at desc);
create index if not exists lemo_productions_plan_idx on public.lemo_productions (plan_id) where plan_id is not null;

drop trigger if exists trg_lemo_productions_updated_at on public.lemo_productions;
create trigger trg_lemo_productions_updated_at before update on public.lemo_productions
  for each row execute function public.set_updated_at();

alter table public.lemo_productions enable row level security;

drop policy if exists "lemo_productions_select_org" on public.lemo_productions;
create policy "lemo_productions_select_org" on public.lemo_productions
  for select to authenticated using (organization_id = public.current_org_id());

-- ---------------------------------------------------------------------
-- 2. lemo_characters — 계정 · 시리즈 단위 캐릭터 라이브러리
--    series가 null이면 계정 공용. 유일 키는 (조직, 계정, 시리즈, 캐릭터)로 null 시리즈도 하나만 둔다.
-- ---------------------------------------------------------------------
create table if not exists public.lemo_characters (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  account_key        text not null,
  social_account_id  uuid references public.social_accounts (id),
  series             text,
  character_id       text not null,
  -- CharacterSpec (contract.ts characterSpecSchema)
  spec               jsonb not null,
  rig_path           text,
  sheet_path         text,
  made_for           uuid references public.lemo_productions (id) on delete set null,
  use_count          integer not null default 0,
  last_used_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create unique index if not exists lemo_characters_unique_idx
  on public.lemo_characters (organization_id, account_key, coalesce(series, ''), character_id);

drop trigger if exists trg_lemo_characters_updated_at on public.lemo_characters;
create trigger trg_lemo_characters_updated_at before update on public.lemo_characters
  for each row execute function public.set_updated_at();

alter table public.lemo_characters enable row level security;

drop policy if exists "lemo_characters_select_org" on public.lemo_characters;
create policy "lemo_characters_select_org" on public.lemo_characters
  for select to authenticated using (organization_id = public.current_org_id());

-- ---------------------------------------------------------------------
-- 3. account_concepts — 선호 lemo 스타일(기본값일 뿐 강제하지 않는다)
-- ---------------------------------------------------------------------
alter table public.account_concepts
  add column if not exists lemo_preferred_styles text[] not null default '{}';

comment on column public.account_concepts.lemo_preferred_styles is
  'lemo 코드 애니메이션 선호 스타일 slug (0055). 제작 방식 선택의 기본값일 뿐 강제하지 않는다';

-- 0060_style_short_jobs.sql — 스타일 쇼츠: 만들기 · 완성본 버전 · 수정 주석 (2026-11-19 사용자 결정)
--
-- 찍은 영상 여러 개 + 스타일 폴더(카드) + 소리 모드 + 대본 · 컨셉으로 쇼츠를 만든다(2단계).
-- 완성본은 버전으로 누적된다(v1, v2 …). 수정은 완성본 위에 단 주석(시각 · 위치 · 내용)으로 요청한다(3단계, 표만 미리 만든다).
--   style_short_jobs      만들기 요청 하나. 카드는 만들 때의 것을 그대로 저장한다(폴더를 고쳐도 이 영상은 그대로)
--   style_short_versions  완성본 버전. 워커(worker/edit-style-shorts.ts)가 PENDING을 집어 편집한다
--   style_short_notes     완성본 버전에 단 수정 주석. 수정 요청을 보내면 다음 버전의 request로 묶인다
-- 원본 촬영본은 30일 뒤 지운다(clips_deleted_at). 완성본은 모든 버전을 보관한다.
-- 쓰기는 서버 액션 · 워커가 service_role로 하고, authenticated는 같은 조직 SELECT만. 기존 테이블은 바꾸지 않는다.

create table public.style_short_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  folder_id uuid references public.style_folders (id) on delete set null,
  folder_name text not null,
  -- 만들 때의 스타일 카드(lib/style-shorts/card.ts의 StyleCard)
  card jsonb not null,
  title text check (title is null or char_length(title) <= 60),
  -- AI 음성(대본 · 컨셉으로 AI가 읽는다) · LIVE(찍은 영상의 말소리를 그대로)
  voice_mode text not null check (voice_mode in ('AI', 'LIVE')),
  script text check (script is null or char_length(script) <= 3000),
  concept text check (concept is null or char_length(concept) <= 1000),
  -- 올린 촬영본, 편집 순서대로 [{ path, name, size }]
  clips jsonb not null,
  clips_deleted_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index style_short_jobs_org_idx on public.style_short_jobs (organization_id, created_at desc);

alter table public.style_short_jobs enable row level security;

create policy "style_short_jobs_select_org" on public.style_short_jobs
  for select to authenticated using (organization_id = public.current_org_id());

create table public.style_short_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  job_id uuid not null references public.style_short_jobs (id) on delete cascade,
  version int not null check (version >= 1),
  -- PENDING 편집 대기 · EDITING 편집 중 · DONE 완성 · FAILED 실패
  status text not null default 'PENDING' check (status in ('PENDING', 'EDITING', 'DONE', 'FAILED')),
  -- 이 버전을 만든 요청. v1은 null, 수정 버전은 { from: 이전 버전 번호, notes: [...], overall: [...] }
  request jsonb,
  video_path text,
  cover_path text,
  seconds numeric,
  -- 다시 편집 · 수정에 쓰는 편집 계획(고른 음악 · 자막 디자인 포함)
  plan jsonb,
  -- 주석 시각을 장면에 맞추는 데 쓰는 시각표 요약 { cuts: [...], captions: [...] }
  timeline jsonb,
  warnings text[] not null default '{}',
  -- 쓴 음악 · 효과음 출처
  sounds jsonb,
  error text,
  editing_since timestamptz,
  finished_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (job_id, version)
);

create index style_short_versions_job_idx on public.style_short_versions (job_id, version desc);
create index style_short_versions_status_idx on public.style_short_versions (status) where status in ('PENDING', 'EDITING');

alter table public.style_short_versions enable row level security;

create policy "style_short_versions_select_org" on public.style_short_versions
  for select to authenticated using (organization_id = public.current_org_id());

create table public.style_short_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  version_id uuid not null references public.style_short_versions (id) on delete cascade,
  -- 화면에 보이는 번호(①②③). 영상 전체 의견은 at · x · y가 null
  no int not null check (no >= 1),
  at numeric check (at is null or at >= 0),
  x numeric check (x is null or (x >= 0 and x <= 1)),
  y numeric check (y is null or (y >= 0 and y <= 1)),
  body text not null check (char_length(body) between 1 and 500),
  -- 수정 요청으로 보낸 뒤에는 고치거나 지우지 않는다
  sent_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index style_short_notes_version_idx on public.style_short_notes (version_id, no);

alter table public.style_short_notes enable row level security;

create policy "style_short_notes_select_org" on public.style_short_notes
  for select to authenticated using (organization_id = public.current_org_id());

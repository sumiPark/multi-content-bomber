-- 0059_style_shorts.sql — 스타일 쇼츠: 레퍼런스 스타일 폴더 (2026-11-19 사용자 결정)
--
-- 직접 찍은 영상을 레퍼런스 스타일대로 자동 편집하는 숨김 페이지(/style-shorts)의 1단계.
--   style_folders     스타일 폴더 하나 = 레퍼런스 묶음 + AI가 만든 스타일 카드(사람이 고칠 수 있음)
--   style_references  폴더에 넣은 레퍼런스. 영상 파일(UPLOAD, media 버킷) 또는 인스타 릴스 링크(INSTAGRAM)
-- 레퍼런스는 스타일만 참고한다. 남의 릴스 영상은 저장하지 않고 분석 값만 남긴다.
-- 분석 · 카드 생성은 워커(worker/analyze-style-refs.ts, GitHub Actions)가 service_role로 쓴다.
-- 화면의 쓰기는 서버 액션이 service_role로 하고, authenticated는 같은 조직 SELECT만.
-- 기존 테이블은 바꾸지 않는다. 앱 코드가 조회하므로 배포 전에 먼저 적용할 것.

create table public.style_folders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  memo text check (memo is null or char_length(memo) <= 300),
  -- 스타일 카드(lib/style-shorts/card.ts의 StyleCard). AI가 만들고 사람이 고친 값
  card jsonb,
  -- EMPTY 레퍼런스 없음 · PENDING 카드 만들기 대기 · ANALYZING 만드는 중 · READY 완성 · FAILED 실패
  card_status text not null default 'EMPTY' check (card_status in ('EMPTY', 'PENDING', 'ANALYZING', 'READY', 'FAILED')),
  card_error text,
  -- 사람이 카드를 고쳤는지 — 레퍼런스가 바뀌어도 자동으로 덮어쓰지 않는다
  card_edited boolean not null default false,
  -- 카드를 만들 때 쓴 레퍼런스. 지금 레퍼런스와 다르면 화면이 "다시 만들기"를 권한다
  card_built_from uuid[] not null default '{}',
  card_updated_at timestamptz,
  card_started_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index style_folders_org_idx on public.style_folders (organization_id, created_at desc);
create index style_folders_card_status_idx on public.style_folders (card_status) where card_status in ('PENDING', 'ANALYZING');

alter table public.style_folders enable row level security;

create policy "style_folders_select_org" on public.style_folders
  for select to authenticated using (organization_id = public.current_org_id());

create table public.style_references (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  folder_id uuid not null references public.style_folders (id) on delete cascade,
  kind text not null check (kind in ('UPLOAD', 'INSTAGRAM')),
  -- UPLOAD: media 버킷 경로 ({org}/{user}/style-shorts/refs/…)와 원래 파일 이름
  storage_path text,
  file_name text check (file_name is null or char_length(file_name) <= 200),
  -- INSTAGRAM: 릴스 주소와 계정 아이디(Business Discovery 조회용)
  permalink text check (permalink is null or permalink ~ '^https://(www\.)?instagram\.com/'),
  username text check (username is null or username ~ '^[A-Za-z0-9._]{1,30}$'),
  -- PENDING 분석 대기 · ANALYZING 분석 중 · DONE 완료 · FAILED 실패
  status text not null default 'PENDING' check (status in ('PENDING', 'ANALYZING', 'DONE', 'FAILED')),
  -- 레퍼런스 하나의 분석 값(lib/style-shorts/card.ts의 ReferenceAnalysis)
  analysis jsonb,
  -- VIDEO 영상까지 분석 · COVER 영상 주소를 못 받아 표지 · 캡션만 분석
  analyzed_from text check (analyzed_from is null or analyzed_from in ('VIDEO', 'COVER')),
  error text,
  analyzing_since timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (kind = 'UPLOAD' and storage_path is not null)
    or (kind = 'INSTAGRAM' and permalink is not null)
  )
);

create index style_references_folder_idx on public.style_references (folder_id, created_at);
create index style_references_status_idx on public.style_references (status) where status in ('PENDING', 'ANALYZING');

alter table public.style_references enable row level security;

create policy "style_references_select_org" on public.style_references
  for select to authenticated using (organization_id = public.current_org_id());

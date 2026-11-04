-- =====================================================================
-- 0041 — 다른 계정 잘된 릴스 종합 분석 (영상 스타일) + 게시물 성과 핵심 한 줄
--
--   benchmark_posts.video_url          인스타가 준 영상 주소(며칠 뒤 만료). 없는 릴스가 많다 — 그럴 땐 표지만 본다
--   benchmark_posts.style              영상 스타일 판정(첫 장면 · 촬영 방식 · 컷 수 · 말 유무 등)
--   benchmark_posts.style_source       VIDEO(영상을 봄) / COVER(표지와 캡션만 봄)
--   benchmark_analyses                 우리 계정별 종합 분석 (실행 한 번 = 한 행). 잘된 릴스와 같은 계정의 평소 릴스를 비교
--   post_analyses.headline             게시물 성과 "데이터가 말하는 것"의 핵심 한 줄
--
-- 다른 계정 영상 파일 · 프레임 · 음성은 저장하지 않는다. 워커(worker/analyze-benchmarks.ts)가 임시 폴더에서 분석하고 지운다.
-- 쓰기는 워커가 service_role로 한다. authenticated는 같은 조직 SELECT만. 기존 데이터는 바꾸지 않는다.
-- 앱 코드가 조회하므로 배포 전에 먼저 적용할 것. types/database.ts에는 수동으로 추가해 뒀다.
-- =====================================================================

alter table public.post_analyses
  add column if not exists headline text;

alter table public.benchmark_posts
  add column if not exists video_url text,
  add column if not exists style jsonb,
  add column if not exists style_source text check (style_source in ('VIDEO', 'COVER')),
  add column if not exists style_analyzed_at timestamptz;

create table if not exists public.benchmark_analyses (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  social_account_id  uuid not null references public.social_accounts (id) on delete cascade,
  hits_count         int not null default 0,
  normal_count       int not null default 0,
  video_count        int not null default 0,
  stats              jsonb not null default '{}'::jsonb,
  summary            jsonb not null default '{}'::jsonb,
  model              text,
  tokens_input       int,
  tokens_output      int,
  created_at         timestamptz not null default now()
);

create index if not exists benchmark_analyses_account_created_idx
  on public.benchmark_analyses (social_account_id, created_at desc);

alter table public.benchmark_analyses enable row level security;

drop policy if exists "benchmark_analyses_select_org" on public.benchmark_analyses;
create policy "benchmark_analyses_select_org" on public.benchmark_analyses
  for select to authenticated using (organization_id = public.current_org_id());

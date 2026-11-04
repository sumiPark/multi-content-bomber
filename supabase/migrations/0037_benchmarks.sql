-- =====================================================================
-- 0037 — 다른 계정 비교 (ig-viral-ko)
--
-- 우리 인스타 계정마다 참고할 다른 계정을 두고, 그 계정 릴스가 평소보다 몇 배 잘됐는지 본다.
-- 데이터는 Meta Business Discovery로 읽는다(비즈니스 · 크리에이터 계정만, 저장 · 공유 수는 안 나옴).
--
--   benchmark_accounts  조회 대상 계정 하나 = 한 행. 우리 계정도 같은 공개 조회수로 비교하려고
--                       own_account_id를 채워 함께 수집한다(그 행은 비교 목록에 안 나온다).
--   benchmark_links     우리 계정 ↔ 비교 계정. group_type · reason(왜 참고하나) · source(AI 제안 / 직접 추가)
--   benchmark_posts     비교 계정 게시물. multiple = 공개 조회수 ÷ 그 계정 평소 조회 중앙값
--                       ad_suspected = 조회수에 비해 좋아요가 극단적으로 적음(광고로 키운 것으로 추정)
--
-- 쓰기는 서버 액션과 워커(worker/collect-benchmarks.ts)가 service_role로 한다.
-- authenticated는 같은 조직 SELECT만. 기존 테이블은 건드리지 않는다.
-- 앱 코드가 조회하므로 배포 전에 먼저 적용할 것. types/database.ts에는 수동으로 추가해 뒀다.
-- =====================================================================

create table if not exists public.benchmark_accounts (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  username           text not null check (username = lower(username)),
  own_account_id     uuid references public.social_accounts (id) on delete set null,
  status             text not null default 'PENDING'
    check (status in ('PENDING', 'OK', 'NOT_FOUND', 'ERROR')),
  error              text,
  display_name       text,
  biography          text,
  followers_count    int,
  media_count        int,
  median_views       int,
  reels_sampled      int,
  reels_30d          int,
  last_post_at       timestamptz,
  last_collected_at  timestamptz,
  created_at         timestamptz not null default now(),
  unique (organization_id, username)
);

create index if not exists benchmark_accounts_collected_idx
  on public.benchmark_accounts (last_collected_at nulls first);

create table if not exists public.benchmark_links (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id) on delete cascade,
  social_account_id     uuid not null references public.social_accounts (id) on delete cascade,
  benchmark_account_id  uuid not null references public.benchmark_accounts (id) on delete cascade,
  group_type            text not null default 'SAME' check (group_type in ('SAME', 'ADJACENT', 'LARGE')),
  reason                text check (char_length(reason) <= 300),
  source                text not null default 'MANUAL' check (source in ('SUGGESTED', 'MANUAL')),
  created_by            uuid references auth.users (id) on delete set null,
  created_at            timestamptz not null default now(),
  unique (social_account_id, benchmark_account_id)
);

create index if not exists benchmark_links_benchmark_idx
  on public.benchmark_links (benchmark_account_id);

create table if not exists public.benchmark_posts (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id) on delete cascade,
  benchmark_account_id  uuid not null references public.benchmark_accounts (id) on delete cascade,
  platform_media_id     text not null,
  media_product_type    text,
  permalink             text,
  caption               text,
  thumbnail_url         text,
  posted_at             timestamptz,
  view_count            int,
  like_count            int,
  comments_count        int,
  reposts_count         int,
  multiple              numeric(8, 2),
  ad_suspected          boolean not null default false,
  formula               text,
  hook_score            numeric(5, 1),
  first_seen_at         timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (benchmark_account_id, platform_media_id)
);

create index if not exists benchmark_posts_account_multiple_idx
  on public.benchmark_posts (benchmark_account_id, multiple desc nulls last);

alter table public.benchmark_accounts enable row level security;
alter table public.benchmark_links    enable row level security;
alter table public.benchmark_posts    enable row level security;

drop policy if exists "benchmark_accounts_select_org" on public.benchmark_accounts;
create policy "benchmark_accounts_select_org" on public.benchmark_accounts
  for select to authenticated using (organization_id = public.current_org_id());

drop policy if exists "benchmark_links_select_org" on public.benchmark_links;
create policy "benchmark_links_select_org" on public.benchmark_links
  for select to authenticated using (organization_id = public.current_org_id());

drop policy if exists "benchmark_posts_select_org" on public.benchmark_posts;
create policy "benchmark_posts_select_org" on public.benchmark_posts
  for select to authenticated using (organization_id = public.current_org_id());

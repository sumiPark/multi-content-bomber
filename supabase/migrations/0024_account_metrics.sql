-- =====================================================================
-- 0024 — 계정 분석: 계정 역할 · 성과 권한 · 성과 스냅샷 (콘텐츠 자동화 1단계)
--
-- 인스타 4개 계정의 지금 수준(기준선)을 잡고, 이후 매일 쌓는다. 성과 분석
-- 에이전트(6)가 읽는 원재료.
--
--   social_accounts.granted_scopes  연결 때 사용자가 동의한 권한. 성과 권한
--                                   (instagram_business_manage_insights)이 없으면
--                                   계정 연동 화면에 "다시 연결 필요"로 보인다.
--   social_accounts.role_focus      계정 역할 — PRODUCT(상품 중심) / PERSON(사람 중심)
--   social_accounts.role_note       역할 메모 (예: "쿠마 건기식 + 리유 화장품")
--   account_daily                   계정 하루 스냅샷 (팔로워 수 → 증감, 하루 도달 · 조회)
--   social_posts                    인스타 게시물 (MCB로 올린 건 publish_job_id가 채워짐)
--   post_metrics                    게시물 하루 스냅샷 (조회 · 도달 · 저장 · 공유 · 시청 시간)
--   post_latest_metrics             게시물별 가장 최근 스냅샷 뷰
--
-- 쓰기는 수집 워커(worker/collect-metrics.ts)와 서버 액션이 service_role로 한다.
-- authenticated는 같은 조직 SELECT만.
--
-- 적용: Supabase SQL Editor (또는 `supabase db push`).
--   ⚠️ 앱 코드가 이 컬럼 · 테이블을 조회하므로 배포 전에 먼저 적용할 것.
--   types/database.ts에는 수동으로 추가해 뒀다.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. social_accounts — 동의 권한 + 계정 역할
-- ---------------------------------------------------------------------
alter table public.social_accounts
  add column if not exists granted_scopes text[],
  add column if not exists role_focus text
    check (role_focus in ('PRODUCT', 'PERSON')),
  add column if not exists role_note text
    check (char_length(role_note) <= 100);

comment on column public.social_accounts.granted_scopes is
  '연결(OAuth) 때 동의된 권한 목록. NULL이면 0024 이전 연결이라 모름 — 다시 연결하면 채워진다.';
comment on column public.social_accounts.role_focus is
  '계정 역할: PRODUCT(상품 중심) / PERSON(사람 중심). 기획 에이전트가 영상 방향을 정할 때 쓴다.';
comment on column public.social_accounts.role_note is
  '계정 역할 메모 (어느 몰 · 어떤 상품을 다루는지).';

-- ---------------------------------------------------------------------
-- 2. account_daily — 계정 하루 스냅샷
--    day는 KST 날짜. 같은 날 다시 수집하면 덮어쓴다.
--    팔로워 증감은 전날 행과의 차이로 계산한다(insights 없이도 프로필 숫자만으로).
-- ---------------------------------------------------------------------
create table if not exists public.account_daily (
  social_account_id  uuid not null references public.social_accounts (id),
  day                date not null,
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  followers_count    int,
  follows_count      int,
  media_count        int,
  -- 아래는 성과 권한이 있을 때만 채워진다 (전날 하루 합계).
  reach              int,
  views              int,
  accounts_engaged   int,
  total_interactions int,
  raw                jsonb not null default '{}'::jsonb,
  collected_at       timestamptz not null default now(),
  primary key (social_account_id, day)
);

create index if not exists account_daily_org_day_idx
  on public.account_daily (organization_id, day desc);

-- ---------------------------------------------------------------------
-- 3. social_posts — 인스타 게시물 한 건 = 한 행
-- ---------------------------------------------------------------------
create table if not exists public.social_posts (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  social_account_id  uuid not null references public.social_accounts (id),
  platform_media_id  text not null,
  -- MCB로 올린 게시물이면 채워진다 (publish_jobs.platform_post_id로 매칭).
  publish_job_id     uuid references public.publish_jobs (id) on delete set null,
  media_type         text,            -- IMAGE / VIDEO / CAROUSEL_ALBUM
  media_product_type text,            -- FEED / REELS / STORY
  permalink          text,
  caption            text,
  thumbnail_url      text,
  posted_at          timestamptz,
  first_seen_at      timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (social_account_id, platform_media_id)
);

create index if not exists social_posts_account_posted_idx
  on public.social_posts (social_account_id, posted_at desc);

drop trigger if exists trg_social_posts_updated_at on public.social_posts;
create trigger trg_social_posts_updated_at before update on public.social_posts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 4. post_metrics — 게시물 하루 스냅샷 (collected_on = KST 날짜)
--    같은 게시물을 매일 다시 재서 "올린 지 N일째" 성장 곡선을 만든다.
-- ---------------------------------------------------------------------
create table if not exists public.post_metrics (
  post_id             uuid not null references public.social_posts (id) on delete cascade,
  collected_on        date not null,
  views               int,
  reach               int,
  likes               int,
  comments            int,
  saved               int,
  shares              int,
  total_interactions  int,
  -- 릴스 전용 (ms)
  avg_watch_time_ms   int,
  total_watch_time_ms bigint,
  raw                 jsonb not null default '{}'::jsonb,
  collected_at        timestamptz not null default now(),
  primary key (post_id, collected_on)
);

-- ---------------------------------------------------------------------
-- 5. 게시물별 가장 최근 스냅샷 (security_invoker — 조회자의 RLS가 그대로 적용)
-- ---------------------------------------------------------------------
create or replace view public.post_latest_metrics
with (security_invoker = true) as
select distinct on (m.post_id)
  m.post_id,
  m.collected_on,
  m.views,
  m.reach,
  m.likes,
  m.comments,
  m.saved,
  m.shares,
  m.total_interactions,
  m.avg_watch_time_ms
from public.post_metrics m
order by m.post_id, m.collected_on desc;

-- ---------------------------------------------------------------------
-- 6. RLS — 같은 조직 SELECT만. 쓰기 정책 없음(service_role 전용).
-- ---------------------------------------------------------------------
alter table public.account_daily enable row level security;
alter table public.social_posts  enable row level security;
alter table public.post_metrics  enable row level security;

drop policy if exists "account_daily_select_org" on public.account_daily;
create policy "account_daily_select_org" on public.account_daily
  for select to authenticated
  using (organization_id = public.current_org_id());

drop policy if exists "social_posts_select_org" on public.social_posts;
create policy "social_posts_select_org" on public.social_posts
  for select to authenticated
  using (organization_id = public.current_org_id());

drop policy if exists "post_metrics_select_org" on public.post_metrics;
create policy "post_metrics_select_org" on public.post_metrics
  for select to authenticated
  using (
    exists (
      select 1 from public.social_posts p
       where p.id = post_metrics.post_id
         and p.organization_id = public.current_org_id()
    )
  );

grant select on public.post_latest_metrics to authenticated;

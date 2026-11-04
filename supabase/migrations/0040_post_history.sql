-- =====================================================================
-- 0040 — 게시물 성과 분석: 지난 릴스 전체 · 통계 · AI 해석 (ig-audit-ko)
--
-- 분석 화면 "게시물 성과" 탭이 계정의 모든 릴스를 평소 대비 배수로 본다. 수집 워커는 최근 게시물만
-- 다루므로, worker/sync-post-history.ts가 지난 릴스를 한 번 끝까지 채운다.
--
--   social_posts.thumb_path           보관한 표지(media 버킷) — 인스타 표지 주소는 며칠 뒤 만료된다
--   social_posts.insights_checked_at  지난 릴스 성과를 읽어 봤나 (지표를 못 받은 옛 게시물을 다시 안 묻게)
--   post_history_sync                 계정별 지난 게시물 목록을 끝까지 읽었는지
--   post_analyses                     계정별 통계와 AI 해석 (실행 한 번 = 한 행)
--   account_reel_stats                릴스 + 가장 최근 성과 (security_invoker — 조회자 RLS 적용)
--
-- 쓰기는 워커가 service_role로 한다. authenticated는 같은 조직 SELECT만.
-- 앱 코드가 조회하므로 배포 전에 먼저 적용할 것. types/database.ts에는 수동으로 추가해 뒀다.
-- =====================================================================

alter table public.social_posts
  add column if not exists thumb_path text,
  add column if not exists insights_checked_at timestamptz;

create index if not exists social_posts_account_type_posted_idx
  on public.social_posts (social_account_id, media_product_type, posted_at desc);

create table if not exists public.post_history_sync (
  social_account_id  uuid primary key references public.social_accounts (id) on delete cascade,
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  listed_at          timestamptz,
  media_listed       int,
  reels_listed       int,
  updated_at         timestamptz not null default now()
);

create table if not exists public.post_analyses (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  social_account_id  uuid not null references public.social_accounts (id) on delete cascade,
  reels_count        int not null default 0,
  stats              jsonb not null default '{}'::jsonb,
  findings           jsonb not null default '[]'::jsonb,
  actions            jsonb not null default '[]'::jsonb,
  model              text,
  tokens_input       int,
  tokens_output      int,
  created_at         timestamptz not null default now()
);

create index if not exists post_analyses_account_created_idx
  on public.post_analyses (social_account_id, created_at desc);

create or replace view public.account_reel_stats
with (security_invoker = true) as
select
  p.id as post_id,
  p.organization_id,
  p.social_account_id,
  p.platform_media_id,
  p.permalink,
  p.caption,
  p.thumb_path,
  p.thumbnail_url,
  p.posted_at,
  p.insights_checked_at,
  m.views,
  m.reach,
  m.likes,
  m.comments,
  m.saved,
  m.shares,
  m.avg_watch_time_ms
from public.social_posts p
left join lateral (
  select x.views, x.reach, x.likes, x.comments, x.saved, x.shares, x.avg_watch_time_ms
  from public.post_metrics x
  where x.post_id = p.id
  order by x.collected_on desc
  limit 1
) m on true
where p.media_product_type = 'REELS';

alter table public.post_history_sync enable row level security;
alter table public.post_analyses     enable row level security;

drop policy if exists "post_history_sync_select_org" on public.post_history_sync;
create policy "post_history_sync_select_org" on public.post_history_sync
  for select to authenticated using (organization_id = public.current_org_id());

drop policy if exists "post_analyses_select_org" on public.post_analyses;
create policy "post_analyses_select_org" on public.post_analyses
  for select to authenticated using (organization_id = public.current_org_id());

grant select on public.account_reel_stats to authenticated;

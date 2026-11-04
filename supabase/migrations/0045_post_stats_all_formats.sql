-- =====================================================================
-- 0045 — 게시물 성과를 릴스에서 모든 게시물로 확장
--
-- 계정 점검은 릴스만 보면 안 된다. 사진 · 캐러셀도 같이 읽는다.
--
--   post_history_sync.all_listed_at  모든 유형의 지난 게시물을 읽었는지 (0040의 listed_at은 릴스만 넣던 때의 값)
--   account_post_stats               게시물 + 가장 최근 성과 (security_invoker — 조회자 RLS 적용)
--
-- 인스타가 옛 피드 게시물의 조회수를 0으로 준다(2026-11-04 실측: 2023년 이전 사진 · 캐러셀 전부 0, 2021년 이전은 성과 없음).
-- 진짜 0이 아니라 값이 없는 것이라 뷰에서 null로 바꾼다.
--
-- account_reel_stats는 이전 배포가 도는 동안 쓰이므로 이번에는 남겨 둔다. 기존 데이터는 바꾸지 않는다.
-- 앱 코드가 조회하므로 배포 전에 먼저 적용할 것. types/database.ts에는 수동으로 추가해 뒀다.
-- =====================================================================

alter table public.post_history_sync
  add column if not exists all_listed_at timestamptz;

create index if not exists social_posts_account_posted_idx
  on public.social_posts (social_account_id, posted_at desc);

create or replace view public.account_post_stats
with (security_invoker = true) as
select
  p.id as post_id,
  p.organization_id,
  p.social_account_id,
  p.platform_media_id,
  p.media_type,
  p.media_product_type,
  p.permalink,
  p.caption,
  p.thumb_path,
  p.thumbnail_url,
  p.posted_at,
  p.insights_checked_at,
  nullif(m.views, 0) as views,
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
) m on true;

grant select on public.account_post_stats to authenticated;

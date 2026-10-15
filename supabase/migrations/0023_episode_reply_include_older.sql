-- =====================================================================
-- 0023 — 시리즈 댓글 자동화: 최신화 소식을 이전 회차 댓글에도
--
-- 지금까지 N화 답글은 직전 화(N-1) 댓글 단 사람에게만 갔다. 최신화 줄에서 "이전 화 댓글에도
-- 보내기"를 누르면 1~(N-1)화 전체에 댓글 단 사람에게 "N화 올라왔어요"를 보낸다.
-- 한 사람에게 답글 하나(가장 최근 화에 단 댓글), 이미 N화 답글을 받았거나 N화에 댓글 단 사람은 뺀다.
--
--   · episode_alert_tasks.include_older        이전 회차 댓글까지 대상인지. 이 회차가 최신화인
--                                              동안만 유효하다 — 다음 화가 올라오면 "N화 올라왔어요"가
--                                              철 지난 소식이 되므로 이전 화 쪽은 멈추고(남은 대상 제외)
--                                              직전 화만 남는다. 판단은 앱이 한다(lib/episode-alerts/scope.ts).
--   · episode_alert_replies.source_episode_id  어느 회차 댓글인지. 기존 행은 작업의 직전 화로 채운다.
--   · episode_alert_task_stats.sent_older      이전 회차 댓글에 보낸 수 (화면에 따로 보여준다).
--
-- 적용: Supabase SQL Editor. 앱 배포 전에 먼저 적용할 것.
-- =====================================================================

alter table public.episode_alert_tasks
  add column if not exists include_older boolean not null default false;

comment on column public.episode_alert_tasks.include_older is
  '이전 회차 댓글에도 보내기(0023). 이 회차가 최신화인 동안 1~(N-1)화 전체 댓글이 대상. 끄거나 다음 화가 올라와도 기록으로 남긴다.';

alter table public.episode_alert_replies
  add column if not exists source_episode_id uuid references public.series_episodes (id) on delete set null;

comment on column public.episode_alert_replies.source_episode_id is
  '이 댓글이 달린 회차. 직전 화만 대상이면 작업의 source_episode_id와 같다.';

update public.episode_alert_replies r
   set source_episode_id = t.source_episode_id
  from public.episode_alert_tasks t
 where r.task_id = t.id
   and r.source_episode_id is null;

-- 기존 열 순서는 그대로 두고 sent_older만 뒤에 붙인다(create or replace view 규칙).
create or replace view public.episode_alert_task_stats
with (security_invoker = true) as
select
  r.task_id,
  count(*)::int                                        as total,
  count(*) filter (where r.status = 'PENDING')::int    as pending,
  count(*) filter (where r.status = 'SENT')::int       as sent,
  count(*) filter (where r.status = 'SKIPPED')::int    as skipped,
  count(*) filter (where r.status = 'EXCLUDED')::int   as excluded,
  count(*) filter (where r.status = 'FAILED')::int     as failed,
  count(*) filter (
    where r.status = 'SENT' and r.source_episode_id <> t.source_episode_id
  )::int                                               as sent_older
from public.episode_alert_replies r
join public.episode_alert_tasks t on t.id = r.task_id
group by r.task_id;

grant select on public.episode_alert_task_stats to authenticated;

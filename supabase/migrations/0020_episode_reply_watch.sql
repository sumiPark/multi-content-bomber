-- =====================================================================
-- 0020 — 시리즈 댓글 자동화: 켜져 있는 동안 새 댓글에도 답글
--
-- 지금까지는 회차 답글을 켜는 순간의 댓글에만 보내고 끝났다. 이제 답글이 켜져 있는 동안
-- (켠 뒤 7일) 직전 화에 새로 달린 댓글도 찾아서 보낸다.
--
--   · episode_alert_tasks.watch_until      새 댓글을 지켜볼 기한(켤 때 +7일, 끄면 NULL)
--   · episode_alert_tasks.last_checked_at  마지막으로 새 댓글을 확인한 시각
--   · episode_alert_tasks.last_comment_count 그때 게시물 댓글 수 — 늘었을 때만 전체를 다시 읽는다
--
-- 주기: GitHub Actions 예약 실행은 실측 2~5시간씩 밀려서 쓸 수 없다. 대신 Supabase pg_cron이
--   5분마다(분 단위로 정확) 앱의 /api/cron/episode-replies를 부른다. 앱은 새 댓글을 찾아
--   대상을 더하고, 보낼 게 생겼을 때만 GitHub 답글 워커를 깨운다.
--   지켜볼 작업이나 밀린 발송이 없으면 앱을 부르지도 않는다.
--
-- 호출 인증: 무작위 비밀값을 이 마이그레이션이 Vault에 만들어 둔다(저장소·채팅에 노출 없음).
--   pg_cron은 Vault에서 꺼내 헤더에 싣고, 앱은 verify_episode_replies_cron_secret RPC로 확인한다.
--   그래서 Vercel 환경변수를 따로 넣을 필요가 없다.
--
-- 적용: Supabase SQL Editor. 앱 배포 전에 먼저 적용할 것. (배포 전까지 5분마다 404가 나지만 무해)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 지켜보기 컬럼
-- ---------------------------------------------------------------------
alter table public.episode_alert_tasks
  add column if not exists watch_until timestamptz,
  add column if not exists last_checked_at timestamptz,
  add column if not exists last_comment_count int;

create index if not exists episode_alert_tasks_watch_idx
  on public.episode_alert_tasks (last_checked_at)
  where status = 'DONE' and watch_until is not null;

-- ---------------------------------------------------------------------
-- 2. 호출 비밀값 (Vault) + 확인 RPC
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'episode_replies_cron_secret') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      'episode_replies_cron_secret',
      'pg_cron → /api/cron/episode-replies 호출 인증 (0020)'
    );
  end if;
end
$$;

create or replace function public.verify_episode_replies_cron_secret(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from vault.decrypted_secrets
     where name = 'episode_replies_cron_secret'
       and decrypted_secret = p_secret
  );
$$;

revoke execute on function public.verify_episode_replies_cron_secret(text) from public, anon, authenticated;
grant  execute on function public.verify_episode_replies_cron_secret(text) to service_role;

-- ---------------------------------------------------------------------
-- 3. pg_cron + pg_net — 5분마다 앱 호출 (할 일이 있을 때만)
-- ---------------------------------------------------------------------
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;

select cron.schedule(
  'episode-replies-recheck',
  '*/5 * * * *',
  $cron$
  select net.http_post(
    url := 'https://mcb.cuma.co.kr/api/cron/episode-replies',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret
          from vault.decrypted_secrets
         where name = 'episode_replies_cron_secret'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  )
  where exists (
    select 1
      from public.episode_alert_tasks t
     where (t.status = 'DONE' and t.watch_until > now())
        or (
          t.status in ('COLLECTING', 'SENDING')
          and t.scheduled_for <= now() - interval '3 minutes'
          and t.locked_at is null
        )
  );
  $cron$
);

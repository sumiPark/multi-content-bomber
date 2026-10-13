-- =====================================================================
-- 0022 — 예약 발행을 제시간에: pg_cron이 1분마다 발행 워커 깨우기
--
-- 증상: 예약 발행이 예약 시각이 지나도 "대기"로 남았다. 예약 발행은 GitHub Actions 30분
--   예약 실행(schedule)에만 기대는데, GitHub이 이걸 실측 5~6시간씩 미뤘다
--   (2026-10-13: UTC 17:10 → 23:40 → 04:44). 즉시 발행은 버튼을 누를 때 직접 깨워서 문제없었다.
--
-- 해결: Supabase pg_cron(분 단위로 정확)이 1분마다 확인해서, 깨워야 할 발행 건이 있을 때만
--   앱의 /api/cron/publish-due를 부르고, 앱이 발행 워커를 dispatch로 바로 깨운다.
--   깨울 건이 없으면 아무것도 호출하지 않는다. GitHub 예약 실행은 백업으로 그대로 둔다.
--
--   깨우는 경우 (PENDING/RETRYING, 시도 3회 미만, 삭제 안 됨):
--     · 이번 1분 안에 예약 시각이 된 건 — 제시간 발행
--     · 예약 시각이 2분 넘게 지났는데 아직 안 집힌 건 — 워커가 못 깨어났을 때 다시
--     · 즉시 발행인데 2분 넘게 안 집힌 건 — 버튼 누를 때 dispatch가 실패했을 때
--   (예약 시각 직후 1~2분은 방금 깨운 워커가 집어가는 중이라 다시 부르지 않는다)
--
-- 인증: 0020이 Vault에 만든 비밀값(episode_replies_cron_secret)을 같이 쓴다.
--
-- 적용: Supabase SQL Editor. (0020의 pg_cron·pg_net·비밀값이 있어야 함)
--   앱 배포 전에 적용해도 된다 — 배포 전까지는 예약 시각에 404가 날 뿐 무해.
-- =====================================================================

select cron.schedule(
  'publish-due',
  '* * * * *',
  $cron$
  select net.http_post(
    url := 'https://mcb.cuma.co.kr/api/cron/publish-due',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret
          from vault.decrypted_secrets
         where name = 'episode_replies_cron_secret'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  )
  where exists (
    select 1
      from public.publish_jobs j
     where j.deleted_at is null
       and j.status in ('PENDING', 'RETRYING')
       and j.attempts < 3
       and (
         (j.scheduled_for > now() - interval '1 minute' and j.scheduled_for <= now())
         or j.scheduled_for <= now() - interval '2 minutes'
         or (j.scheduled_for is null and j.created_at <= now() - interval '2 minutes')
       )
  );
  $cron$
);

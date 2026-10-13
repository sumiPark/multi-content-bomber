-- =====================================================================
-- 0021 — 시리즈 댓글 자동화: 7일 지켜보기가 끝나면 회차 답글 자동으로 끄기
--
-- 0020에서는 7일이 지나면 새 댓글 확인만 멈추고 회차 스위치는 켜진 채로 남아, "켜져
-- 있는데 아무것도 안 하는" 상태가 됐다. 이제 다 보낸(DONE) 회차는 지켜보기 기한이 지나면
-- 스위치도 꺼진다. 아직 보내는 중이면(하루 상한 등) 다 보낸 다음 주기에 꺼진다.
--
-- 꺼진 이유 구분: 손으로 끄면 watch_until을 지우고(disableEpisodeReplies), 자동으로 끌 땐
--   watch_until을 남겨둔다 → 화면이 "7일 지나 꺼짐"으로 보여준다. 다시 켜면 그 사이 새로
--   댓글 단 사람에게 보내고 다시 7일을 지켜본다.
--
-- 앱 호출이 필요 없는 순수 SQL이라 pg_cron에 따로 등록한다(5분마다, 대상 없으면 0행 갱신).
--
-- 적용: Supabase SQL Editor. (0020의 pg_cron이 켜져 있어야 함)
-- =====================================================================

select cron.schedule(
  'episode-replies-expire',
  '*/5 * * * *',
  $cron$
  update public.series_episodes e
     set reply_enabled = false
    from public.episode_alert_tasks t
   where t.target_episode_id = e.id
     and e.reply_enabled
     and t.status = 'DONE'
     and t.watch_until is not null
     and t.watch_until <= now();
  $cron$
);

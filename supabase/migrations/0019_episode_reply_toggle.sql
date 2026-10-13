-- =====================================================================
-- 0019 — 시리즈 댓글 자동화: 바로 보내기 고정 + 회차별 답글 켜기/끄기
--
--   · "확인 후 보내기"(AWAITING_APPROVAL) 제거 — 답글은 항상 바로 보낸다.
--     episode_alert_settings.mode, episode_alert_tasks.mode 제거.
--   · 회차마다 답글 발송을 켜고 끈다(series_episodes.reply_enabled). 회차를 추가하면
--     꺼진 상태로 시작하고, 켜는 순간 직전 화에 댓글 단 사람들에게 답글을 보낸다.
--     끄면 남은 답글은 보내지 않는다(이미 보낸 답글은 그대로).
--   · 업로드 마법사에서 "다음 화로 올리기"와 함께 답글을 켜고 올릴 수 있다
--     (publish_jobs.series_reply_enabled, 기본 false).
--
-- 기존 데이터: 시리즈 2개, 회차 1개(2026-10-13 확인) — 회차는 꺼진 상태로 남는다.
--   답글 작업·계정 설정은 0행이라 상태/컬럼 정리에 영향 없음.
--
-- 적용: Supabase SQL Editor. 앱 배포 전에 먼저 적용할 것.
-- =====================================================================

alter table public.series_episodes
  add column if not exists reply_enabled boolean not null default false;

comment on column public.series_episodes.reply_enabled is
  '이 회차의 답글 발송 켜기/끄기. 켜면 직전 화에 댓글 단 사람들에게 바로 대댓글을 단다. 기본 꺼짐.';

alter table public.publish_jobs
  add column if not exists series_reply_enabled boolean not null default false;

-- 확인 후 보내기 제거. (대기 중 작업이 있었다면 바로 보내기로 넘긴다 — 현재 0건)
update public.episode_alert_tasks set status = 'SENDING' where status = 'AWAITING_APPROVAL';

alter table public.episode_alert_tasks
  drop constraint if exists episode_alert_tasks_status_check;
alter table public.episode_alert_tasks
  add constraint episode_alert_tasks_status_check
  check (status in ('COLLECTING', 'SENDING', 'DONE', 'FAILED', 'CANCELLED'));

alter table public.episode_alert_tasks drop column if exists mode;
alter table public.episode_alert_settings drop column if exists mode;

-- =====================================================================
-- 0018 — 시리즈 댓글 자동화: 답글 문구를 시리즈별로
--
-- 0017에서는 답글 문구가 계정 설정(episode_alert_settings.templates)에 하나뿐이라
-- 시리즈마다 다른 말투·내용을 쓸 수 없었다. 문구를 시리즈로 옮긴다.
--
--   series.reply_templates          시리즈별 답글 문구. 비어 있으면 앱 기본 문구.
--   episode_alert_settings.templates 제거 — 시리즈로 옮김
--   episode_alert_settings.enabled   제거 — 업로드 마법사에서 "다음 화로 올리기"를 고르는
--                                    것 자체가 켜는 것이고, 확인 후 보내기면 "이번엔 안
--                                    보내기"로 건너뛸 수 있어 따로 끄는 스위치가 필요 없다.
--   계정 설정에는 보내는 방식(확인 후/바로)과 하루 최대 답글 수만 남는다.
--
-- 0017 테이블은 배포 직후라 비어 있다(2026-10-13 확인: 모든 테이블 0행).
--
-- 적용: Supabase SQL Editor (또는 `supabase db push`). 앱 배포 전에 먼저 적용할 것.
-- =====================================================================

alter table public.series
  add column if not exists reply_templates text[] not null default '{}';

comment on column public.series.reply_templates is
  '시리즈별 답글 문구. 순서대로 돌려쓴다. 비어 있으면 앱 기본 문구(lib/episode-alerts/templates.ts).';

alter table public.episode_alert_settings
  drop column if exists templates,
  drop column if exists enabled;

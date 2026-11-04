-- 0044_shoot_voice_mode.sql — 직접 촬영 영상의 음성을 영상 방향에서 분리한다 (2026-11-04 사용자 결정)
--
-- 사용자 결정: 영상 안에서 말한 소리는 주로 쓰지 않는다. 그래서 기본은 AI 음성이다.
--   AI    찍은 사람은 말하지 않고 AI 음성이 내레이션을 읽는다(사람이 나오는 계정도 마찬가지)
--   LIVE  컷 목록에 사람이 말할 대사를 넣고, 찍을 때 말한 소리를 그대로 쓴다
-- 영상 방향(shoot_role_focus)은 사람이 나오는 장면이냐, 손 · 제품 위주냐만 정한다.

alter table public.account_concepts
  add column if not exists shoot_voice_mode text not null default 'AI' check (shoot_voice_mode in ('AI', 'LIVE'));

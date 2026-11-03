-- =====================================================================
-- 0029 — AI 자동 업로드 상품 확인 마감: "올리기 전날 18시" → "올리는 날 07시" (2026-11-03 사용자 결정)
--
-- track_settings.b_confirm_deadline의 뜻이 바뀐다: 이제 올리는 날(slot_date) 그 시각(KST)까지.
-- 08:00 · 21:00 칸 모두 그날 07:00에 닫힌다. 앱 코드(lib/automation/deadline.ts)도 같은 날 기준으로 바뀐다.
-- =====================================================================

alter table public.track_settings
  alter column b_confirm_deadline set default '07:00';

update public.track_settings
   set b_confirm_deadline = '07:00'
 where b_confirm_deadline = '18:00';

comment on column public.track_settings.b_confirm_deadline is
  'AI 자동 업로드 상품 확인 마감 — 올리는 날(slot_date) 이 시각(KST)까지. 지나면 확인 안 된 칸은 건너뛴다.';

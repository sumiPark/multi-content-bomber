-- 0054_auto_storyboard_stage.sql — AI 자동 콘텐츠: 장면표를 정식 단계로 저장하고, 다시 만들기를 둘로 나누고, 같은 칸이 겹쳐 만들어지지 않게 한다 (2026-11-10 1차)
--
--   storyboard   : 상품을 확인하면 영상 워커가 장면표를 먼저 쓰고 여기에 저장한다(SCRIPTED).
--                  장면표 + 쓴 소재 목록(사진 · 움직이는 이미지 · 자사 촬영 컷 번호와 원본) + 근거 카드(K번호) + 말 속도 · 고정 문구.
--                  영상은 저장된 장면표로 만든다. 만드는 도중 끊기면 다음 실행이 장면표부터 다시 쓰지 않고 이어 만든다.
--   redo         : 사람이 누른 다시 만들기 요청. {"kind":"visual"|"script","memo":"...","at":"..."}
--                  visual = 말 · 후킹 · 캡션은 두고 화면 소재만 다시, script = 메모를 반영해 장면표부터 다시(그 칸에만 적용).
--   making_since : 워커가 이 칸을 만들기 시작한 시각. 조건부 UPDATE로 한 실행만 집는다. 끝나면 비운다.
--
-- 추가만 한다. 지금 main 코드는 세 칸을 읽지 않으니 마이그레이션을 먼저 올려도 동작이 그대로다.

alter table public.content_plans
  add column if not exists storyboard jsonb,
  add column if not exists redo jsonb,
  add column if not exists making_since timestamptz;

comment on column public.content_plans.storyboard is 'AI 자동 영상 장면표 + 쓴 소재 · 근거 스냅숏 (0054). 영상은 이 장면표로 만든다';
comment on column public.content_plans.redo is '다시 만들기 요청 {kind: visual|script, memo, at} (0054)';
comment on column public.content_plans.making_since is '영상 워커가 이 칸을 집은 시각 (0054). 오래되면 끊긴 것으로 보고 다시 집는다';

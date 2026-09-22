-- =====================================================================
-- 0015 — publish_jobs.resume_state: 재시도가 이어받는 어댑터 상태
--
-- 증상: 818MB 릴스가 "Instagram container 폴링 타임아웃"으로 시도마다 실패.
--   인스타는 컨테이너를 만들면 원본을 받아가 자기 서버에서 인코딩하는데,
--   큰 영상은 10분 안에 안 끝난다. 그런데 재시도마다 워커가 새 컨테이너를
--   만들어 0부터 다시 기다렸다 — 앞 시도의 진행분은 버려지고, 인스타 쪽엔
--   같은 영상 컨테이너가 시도 수만큼 쌓여 서로 느려졌다.
--
-- 해결: 어댑터가 재시도 때 이어받을 상태(인스타는 container id)를 job에 남긴다.
--   다음 시도는 새로 만들지 않고 그 컨테이너를 이어서 폴링 — 대기 시간이
--   시도를 넘어 누적된다. (인스타 컨테이너는 24시간 유효.)
--
-- 적용: Supabase SQL Editor (또는 `supabase db push`).
--   워커는 이 컬럼이 없어도 죽지 않는다 — 저장 실패 시 경고만 남기고
--   발행은 계속하되, 이어받기만 꺼진다(= 이전 동작). types/database.ts에는
--   resume_state를 수동으로 추가해 뒀다.
-- =====================================================================

alter table public.publish_jobs
  add column if not exists resume_state jsonb;

comment on column public.publish_jobs.resume_state is
  '어댑터가 재시도 때 이어받는 상태 (예: Instagram container id). 워커(service_role)만 쓴다.';

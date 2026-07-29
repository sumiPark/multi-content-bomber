-- =====================================================================
-- 0013 — 중복 발행 차단 (같은 콘텐츠를 같은 계정에 두 번 올리던 문제)
--
-- 증상: 마법사 5단계 '완료'를 누르면 계정당 job이 2개 생겨 Instagram에
--   같은 릴스가 2개씩 올라갔다. insert 배치가 4.5~7.7초 간격으로 두 번
--   들어온 것 — 서버 액션 1회 소요시간과 일치(= '완료' 재클릭).
--
-- 방어: "살아있는(아직 처리 안 끝난) job은 콘텐츠+계정당 1개"를 DB가 보장.
--   SUCCESS/FAILED/CANCELLED는 predicate에서 빠지므로,
--     · 기존 발행 이력(중복 포함)과 충돌하지 않고
--     · 나중에 같은 콘텐츠를 같은 계정에 다시 올리는 것도 계속 가능하다.
--   막히는 건 "앞 job이 아직 처리 중인데 같은 조합이 또 들어오는" 경우뿐.
--
-- 적용: Supabase SQL Editor (또는 `supabase db push`).
-- =====================================================================

create unique index if not exists publish_jobs_live_unique_idx
  on public.publish_jobs (content_id, social_account_id)
  where deleted_at is null
    and status in ('PENDING', 'PROCESSING', 'RETRYING');

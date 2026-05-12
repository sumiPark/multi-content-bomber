-- =====================================================================
-- 0010 — Partial indexes used by the dashboard hub queries.
--
-- 두 인덱스 모두 `where` 절이 좁아 row 수가 적고, IF NOT EXISTS / 부분
-- 인덱스라 추가 비용이 매우 낮다. 기존 publish_jobs 인덱스들과 겹치지 않는
-- 영역(미래 예약 시간 + 주간 완료 시각)을 커버한다.
--
-- Apply via Supabase SQL Editor 또는 `supabase db push`.
-- =====================================================================

-- 1) 대시보드 "다음 예약 시간" + "오늘 예약 카운트" 쿼리.
--    publish_jobs_status_filter_idx (status, scheduled_for desc) 가 비슷한
--    범위를 커버하지만, 정렬 방향이 desc라 "가장 빠른 시간 1건" 조회에는
--    역방향 스캔이 필요하다. asc + PENDING-only 부분 인덱스로 직접 첫 행을 잡는다.
create index if not exists publish_jobs_pending_sched_asc_idx
  on public.publish_jobs (scheduled_for asc)
  where deleted_at is null and status = 'PENDING';

-- 2) "이번 주 / 지난 주 완료 건수" 비교 쿼리.
--    completed_at 인덱스가 없어 SUCCESS row 전체를 풀스캔 후 필터링하던 부분.
create index if not exists publish_jobs_success_completed_idx
  on public.publish_jobs (completed_at desc)
  where deleted_at is null and status = 'SUCCESS';

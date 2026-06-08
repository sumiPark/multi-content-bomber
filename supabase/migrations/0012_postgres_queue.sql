-- =====================================================================
-- 0012 — Postgres as the publish queue (BullMQ/Redis 제거)
-- 큐를 Upstash/BullMQ 대신 publish_jobs 테이블로 대체한다.
-- GitHub Actions cron(예약) + repository_dispatch(즉시)가 워커 스크립트를
-- 깨우면, 그 스크립트가 이 RPC로 "지금 처리할 job"을 원자적으로 집어간다.
-- 적용: Supabase SQL Editor (또는 `supabase db push`).
--       이후 types/database.ts에 claim_due_publish_jobs 시그니처 추가 필요.
-- =====================================================================

-- ---------------------------------------------------------------------
-- claim_due_publish_jobs
--   처리할 job을 FOR UPDATE SKIP LOCKED로 잠그고 PROCESSING으로 전환해
--   "선점"한 뒤 그 행들을 반환한다. 동시에 여러 워커 run이 떠도 같은 job을
--   두 번 집지 않는다(SKIP LOCKED + 단일 트랜잭션 내 상태 전환).
--
--   대상:
--     · PENDING / RETRYING 이고 예약 시각이 지났거나 없는 것
--     · PROCESSING 인데 updated_at이 너무 오래된 것(= 워커가 처리 중 크래시 →
--       유실 방지로 회수). p_stale_minutes 기본 15분.
--   제외: deleted_at 있는 것, attempts가 한도 이상인 것.
-- ---------------------------------------------------------------------
create or replace function public.claim_due_publish_jobs(
  p_limit         int default 20,
  p_max_attempts  int default 3,
  p_stale_minutes int default 15
)
returns setof public.publish_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  update public.publish_jobs pj
     set status     = 'PROCESSING',
         updated_at = now()
   where pj.id in (
     select c.id
       from public.publish_jobs c
      where c.deleted_at is null
        and c.attempts < p_max_attempts
        and (
          (
            c.status in ('PENDING', 'RETRYING')
            and (c.scheduled_for is null or c.scheduled_for <= now())
          )
          or (
            -- 처리 중 크래시 회수
            c.status = 'PROCESSING'
            and c.updated_at < now() - make_interval(mins => p_stale_minutes)
          )
        )
      order by coalesce(c.scheduled_for, c.created_at) asc
      limit p_limit
      for update skip locked
   )
  returning pj.*;
end;
$$;

-- 워커는 service_role 키로 호출한다. SECURITY DEFINER 함수라 명시적 grant 필요.
revoke execute on function public.claim_due_publish_jobs(int, int, int) from anon, authenticated;
grant  execute on function public.claim_due_publish_jobs(int, int, int) to service_role;

-- =====================================================================
-- 0016 — social_accounts 소프트 연결 해제 (발행 이력 보존)
--
-- 증상: 계정 연결 해제가 social_accounts 행을 DELETE 했고,
--   publish_jobs.social_account_id가 ON DELETE CASCADE라 그 계정의 발행 이력
--   (게시 완료 건 포함)이 배포 관리에서 통째로 사라졌다.
--
-- 해결:
--   1. 연결 해제 = disconnected_at 기록 + 토큰 컬럼 NULL (행은 유지).
--      계정 목록/업로드 마법사에서는 숨기고, 배포 관리 이력에는 "연결 해제됨"으로 남는다.
--      같은 계정을 다시 연결하면 (organization_id, platform, platform_account_id)
--      unique로 같은 행이 upsert되며 disconnected_at이 풀려 이력이 그대로 이어진다.
--   2. 토큰 만료(is_active=false)는 연결 해제와 별개 상태 — 계정 목록에 "비활성"으로
--      계속 보이고 재연결로 복구한다. 어느 쪽이든 발행 이력은 지우지 않는다.
--   3. FK를 CASCADE → NO ACTION으로 바꿔, 누가 social_accounts를 직접 DELETE 해도
--      이력이 조용히 같이 지워지지 않게 막는다. (조직 삭제처럼 contents 쪽 cascade로
--      publish_jobs가 같은 문장 안에서 먼저 지워지는 경우는 NO ACTION이라 통과.)
--
-- 적용: Supabase SQL Editor (또는 `supabase db push`).
--   ⚠️ 앱 코드가 disconnected_at을 조회하므로 배포 전에 먼저 적용할 것.
--   types/database.ts에는 disconnected_at을 수동으로 추가해 뒀다.
-- =====================================================================

alter table public.social_accounts
  add column if not exists disconnected_at timestamptz;

comment on column public.social_accounts.disconnected_at is
  '사용자가 연결 해제한 시각. NULL이면 연결 중. 해제돼도 행은 남겨 발행 이력을 보존한다.';

alter table public.publish_jobs
  drop constraint if exists publish_jobs_social_account_id_fkey;

alter table public.publish_jobs
  add constraint publish_jobs_social_account_id_fkey
  foreign key (social_account_id)
  references public.social_accounts (id)
  on delete no action;

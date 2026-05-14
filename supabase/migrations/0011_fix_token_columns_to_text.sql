-- =====================================================================
-- 0011 — Convert encrypted token columns from bytea to text (UTF-8).
--
-- 배경:
--   - 0006이 컬럼을 text로 바꾸려 했으나 실제 DB에는 적용 안 됨
--     (Supabase는 자동 적용 아님 — SQL Editor / `supabase db push` 필요).
--   - 0006의 USING은 `encode(col, 'base64')` 였으나 현재 `lib/crypto.ts`
--     는 `iv_hex:cipher_hex` 형식의 일반 텍스트 문자열을 반환한다.
--     base64로 감싸면 코드와 형식이 어긋남.
--
-- 현 상태(2026-05-14 진단으로 확인):
--   - 컬럼 타입: bytea
--   - 저장된 값: `iv_hex:cipher_hex` 문자열을 ASCII 바이트로 저장한 상태
--   - PostgREST가 반환할 때 `\x` prefix의 hex 표현으로 노출
--   - 결과: `decryptToken`이 콜론을 못 찾고 IV 길이 검증 실패 →
--           "Invalid initialization vector"
--
-- 이 마이그레이션:
--   - 컬럼을 text로 변경하면서 `convert_from(col, 'UTF8')`로 ASCII 복원.
--   - 기존 데이터는 그대로 살아남는다 (재연동 불필요).
--
-- 적용:
--   Supabase SQL Editor에서 통째로 붙여넣고 실행. 또는 `supabase db push`.
--   적용 후 `scripts/diagnose-tokens.ts`로 검증.
-- =====================================================================

alter table public.social_accounts
  alter column access_token_encrypted type text
    using case
            when access_token_encrypted is null then null
            else convert_from(access_token_encrypted, 'UTF8')
         end,
  alter column refresh_token_encrypted type text
    using case
            when refresh_token_encrypted is null then null
            else convert_from(refresh_token_encrypted, 'UTF8')
         end;

-- 0001에서 적용한 컬럼-레벨 REVOKE(authenticated/anon)는 타입 변경 후에도 유지된다.
-- service_role은 그대로 full access.

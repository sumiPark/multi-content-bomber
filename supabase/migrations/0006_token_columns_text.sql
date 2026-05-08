-- =====================================================================
-- 0006 — Convert encrypted token columns from bytea to text (base64).
-- Reason: Supabase JS client serializes bytea awkwardly via PostgREST.
-- Storing AES-256-GCM ciphertext as base64 text is functionally identical
-- (still encrypted) and far simpler to insert/read from Node.
-- Apply via Supabase SQL Editor (or `supabase db push`), then regenerate
-- types: npx supabase gen types typescript --project-id <ref> > types/database.ts
-- =====================================================================

alter table public.social_accounts
  alter column access_token_encrypted type text
    using case when access_token_encrypted is null
              then null
              else encode(access_token_encrypted, 'base64')
         end,
  alter column refresh_token_encrypted type text
    using case when refresh_token_encrypted is null
              then null
              else encode(refresh_token_encrypted, 'base64')
         end;

-- The column-level revokes from 0001 (REVOKE SELECT/INSERT/UPDATE on
-- access_token_encrypted, refresh_token_encrypted FROM authenticated, anon)
-- still apply after the type change. service_role retains full access.

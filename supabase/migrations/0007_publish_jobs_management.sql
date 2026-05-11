-- =====================================================================
-- 0007 — Posting management columns + cancelled status.
-- See docs/functional-specification.md §6 for the management UI spec.
-- Apply via Supabase SQL Editor (or `supabase db push`).
-- =====================================================================

-- 1. Add CANCELLED to publish_status enum (idempotent guard).
alter type public.publish_status add value if not exists 'CANCELLED';

-- 2. New management columns on publish_jobs.
alter table public.publish_jobs
  add column if not exists cancelled_at   timestamptz,
  add column if not exists deleted_at     timestamptz,
  add column if not exists status_history jsonb not null default '[]'::jsonb;

-- 3. Indexes for common management queries.
--    a) Filter by deletion status + recency (most listings exclude deleted rows).
create index if not exists publish_jobs_active_created_idx
  on public.publish_jobs (created_at desc)
  where deleted_at is null;

--    b) Status filter combined with scheduled_for (used by status summary cards).
create index if not exists publish_jobs_status_filter_idx
  on public.publish_jobs (status, scheduled_for desc)
  where deleted_at is null;

-- 4. UPDATE/DELETE policies intentionally remain absent — server actions
--    use the service_role key (see 0001_init.sql §10.5 comment block).

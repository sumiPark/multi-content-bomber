-- =====================================================================
-- 0009 — Account groups (1:N relationship to social_accounts).
-- See docs/functional-specification.md §1 / §4.2.
-- =====================================================================

-- 1. account_groups table
create table if not exists public.account_groups (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null,
  description     text,
  -- UI 식별용 색상 토큰. Tailwind 색상 키와 매칭. 자유 문자열로 두되 코드에서 화이트리스트 검증.
  color           text not null default 'zinc',
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint account_groups_name_per_org_unique unique (organization_id, name)
);

create index if not exists account_groups_org_idx on public.account_groups (organization_id);

create trigger trg_account_groups_updated_at
  before update on public.account_groups
  for each row execute function public.set_updated_at();

-- 2. social_accounts에 group_id 추가 (1:N, NULL 허용 = "미지정")
alter table public.social_accounts
  add column if not exists group_id uuid references public.account_groups (id) on delete set null;

create index if not exists social_accounts_group_idx on public.social_accounts (group_id);

-- 3. RLS
alter table public.account_groups enable row level security;

create policy "account_groups_select_org" on public.account_groups
  for select to authenticated
  using (organization_id = public.current_org_id());

create policy "account_groups_insert_admin_manager" on public.account_groups
  for insert to authenticated
  with check (
    organization_id = public.current_org_id()
    and public.current_role() in ('ADMIN', 'MANAGER')
  );

create policy "account_groups_update_admin_manager" on public.account_groups
  for update to authenticated
  using (
    organization_id = public.current_org_id()
    and public.current_role() in ('ADMIN', 'MANAGER')
  )
  with check (organization_id = public.current_org_id());

create policy "account_groups_delete_admin_manager" on public.account_groups
  for delete to authenticated
  using (
    organization_id = public.current_org_id()
    and public.current_role() in ('ADMIN', 'MANAGER')
  );

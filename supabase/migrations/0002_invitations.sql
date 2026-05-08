-- =====================================================================
-- 0002 — Invitation flow for joining an existing organization.
-- Apply via Supabase SQL Editor (or `supabase db push`), then regenerate
-- types: npx supabase gen types typescript --project-id <ref> > types/database.ts
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------
create table public.invitations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  invited_email   text not null,
  role            public.user_role not null default 'STAFF',
  token           text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  expires_at      timestamptz not null default (now() + interval '7 days'),
  accepted_at     timestamptz,
  invited_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now()
);

create index invitations_token_active_idx on public.invitations (token) where accepted_at is null;
create index invitations_email_active_idx on public.invitations (invited_email) where accepted_at is null;

-- ---------------------------------------------------------------------
-- 2. RLS — org members can see their pending invitations.
--    All writes go through the RPCs below.
-- ---------------------------------------------------------------------
alter table public.invitations enable row level security;

create policy "invitation_select_org" on public.invitations
  for select to authenticated
  using (organization_id = public.current_org_id());

-- ---------------------------------------------------------------------
-- 3. RPC: create_invitation (ADMIN/MANAGER only)
-- ---------------------------------------------------------------------
create or replace function public.create_invitation(
  p_email text,
  p_role  public.user_role default 'STAFF'
)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_org_id uuid := public.current_org_id();
  v_role   public.user_role := public.current_role();
  v_token  text;
begin
  if v_org_id is null then raise exception 'no organization context'; end if;
  if v_role not in ('ADMIN', 'MANAGER') then raise exception 'forbidden'; end if;

  insert into public.invitations (organization_id, invited_email, role, invited_by)
  values (v_org_id, lower(p_email), p_role, auth.uid())
  returning token into v_token;

  return v_token;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. RPC: accept_invitation
--    The invitee redeems a token. Bound to their auth.users.email so a
--    leaked token cannot be redeemed by an arbitrary account.
-- ---------------------------------------------------------------------
create or replace function public.accept_invitation(p_token text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_user_id   uuid := auth.uid();
  v_email     text;
  v_inv_id    uuid;
  v_inv_org   uuid;
  v_inv_role  public.user_role;
  v_inv_email text;
begin
  if v_user_id is null then raise exception 'authentication required'; end if;

  select email into v_email from auth.users where id = v_user_id;

  select id, organization_id, role, invited_email
    into v_inv_id, v_inv_org, v_inv_role, v_inv_email
  from public.invitations
  where token = p_token
    and accepted_at is null
    and expires_at > now()
  for update;

  if v_inv_id is null then raise exception 'invalid or expired invitation'; end if;
  if lower(v_inv_email) <> lower(v_email) then
    raise exception 'invitation is for a different email address';
  end if;

  if exists (select 1 from public.profiles where id = v_user_id and organization_id is not null) then
    raise exception 'user already belongs to an organization';
  end if;

  update public.profiles
     set organization_id = v_inv_org,
         role            = v_inv_role
   where id = v_user_id;

  update public.invitations set accepted_at = now() where id = v_inv_id;

  return v_inv_org;
end;
$$;

grant execute on function public.create_invitation(text, public.user_role) to authenticated;
grant execute on function public.accept_invitation(text) to authenticated;

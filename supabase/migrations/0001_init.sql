-- =====================================================================
-- Multi-Content Bomber — initial schema
-- Apply via Supabase SQL Editor (or `supabase db push`).
-- Order: extensions → enums → tables → indexes → triggers → RLS → RPC
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Extensions
-- ---------------------------------------------------------------------
create extension if not exists "pgcrypto" with schema extensions;

-- ---------------------------------------------------------------------
-- 2. Enums
-- ---------------------------------------------------------------------
create type public.user_role      as enum ('ADMIN', 'MANAGER', 'STAFF');
create type public.social_platform as enum ('YOUTUBE', 'INSTAGRAM', 'TIKTOK');
create type public.media_type     as enum ('VIDEO', 'IMAGE');
create type public.publish_status as enum ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'RETRYING');
create type public.post_type      as enum ('SHORTS', 'REELS', 'FEED', 'CAROUSEL', 'PHOTO_MODE', 'VIDEO', 'PHOTO');

-- ---------------------------------------------------------------------
-- 3. Generic updated_at trigger fn
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Tables
-- ---------------------------------------------------------------------

-- 4.1 organizations
create table public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 4.2 profiles (1:1 with auth.users)
create table public.profiles (
  id              uuid primary key references auth.users (id) on delete cascade,
  organization_id uuid references public.organizations (id) on delete set null,
  role            public.user_role not null default 'STAFF',
  email           text,
  full_name       text,
  avatar_url      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- 4.3 social_accounts
-- Tokens are AES-256-GCM encrypted in Node BEFORE insert. The encryption
-- key must live in env (or Supabase Vault) — never in this database.
create table public.social_accounts (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations (id) on delete cascade,
  connected_by             uuid references public.profiles (id) on delete set null,
  platform                 public.social_platform not null,
  platform_account_id      text not null,
  display_name             text,
  avatar_url               text,
  access_token_encrypted   bytea,
  refresh_token_encrypted  bytea,
  token_expires_at         timestamptz,
  is_active                boolean not null default true,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (organization_id, platform, platform_account_id)
);

-- 4.4 contents
create table public.contents (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  created_by      uuid references public.profiles (id) on delete set null,
  title           text,
  media_type      public.media_type not null,
  media_urls      text[] not null,
  metadata        jsonb not null default '{}'::jsonb,
  ai_captions     jsonb,                              -- { youtube: {...}, instagram: {...}, tiktok: {...} }
  ai_analyzed_at  timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint media_urls_count check (
    case media_type
      when 'VIDEO' then array_length(media_urls, 1) = 1
      when 'IMAGE' then array_length(media_urls, 1) between 1 and 10
    end
  )
);

-- 4.5 publish_jobs
create table public.publish_jobs (
  id                 uuid primary key default gen_random_uuid(),
  content_id         uuid not null references public.contents (id) on delete cascade,
  social_account_id  uuid not null references public.social_accounts (id) on delete cascade,
  post_type          public.post_type not null,
  status             public.publish_status not null default 'PENDING',
  scheduled_for      timestamptz,
  caption_override   text,
  is_ai_generated    boolean not null default true,    -- platform AI-label flag
  attempts           int not null default 0,
  last_error         text,
  platform_post_id   text,
  platform_post_url  text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  completed_at       timestamptz
);

-- ---------------------------------------------------------------------
-- 5. Indexes
-- ---------------------------------------------------------------------
create index profiles_org_idx              on public.profiles (organization_id);
create index social_accounts_org_idx       on public.social_accounts (organization_id);
create index social_accounts_platform_idx  on public.social_accounts (organization_id, platform);
create index contents_org_created_idx      on public.contents (organization_id, created_at desc);
create index publish_jobs_content_idx      on public.publish_jobs (content_id);
create index publish_jobs_social_idx       on public.publish_jobs (social_account_id);
create index publish_jobs_status_sched_idx on public.publish_jobs (status, scheduled_for);

-- ---------------------------------------------------------------------
-- 6. updated_at triggers
-- ---------------------------------------------------------------------
create trigger trg_organizations_updated_at  before update on public.organizations  for each row execute function public.set_updated_at();
create trigger trg_profiles_updated_at       before update on public.profiles       for each row execute function public.set_updated_at();
create trigger trg_social_accounts_updated_at before update on public.social_accounts for each row execute function public.set_updated_at();
create trigger trg_contents_updated_at       before update on public.contents       for each row execute function public.set_updated_at();
create trigger trg_publish_jobs_updated_at   before update on public.publish_jobs   for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 7. New auth.users → bootstrap public.profiles row
--    organization_id stays NULL until the user creates / joins an org.
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- 8. RLS helpers
--    SECURITY DEFINER + locked search_path: callers cannot redirect
--    these lookups via shadowed schemas.
-- ---------------------------------------------------------------------
create or replace function public.current_org_id()
returns uuid
language sql stable
security definer
set search_path = public, pg_temp
as $$
  select organization_id from public.profiles where id = auth.uid();
$$;

create or replace function public.current_role()
returns public.user_role
language sql stable
security definer
set search_path = public, pg_temp
as $$
  select role from public.profiles where id = auth.uid();
$$;

grant execute on function public.current_org_id() to authenticated;
grant execute on function public.current_role()   to authenticated;

-- ---------------------------------------------------------------------
-- 9. Enable RLS
-- ---------------------------------------------------------------------
alter table public.organizations  enable row level security;
alter table public.profiles       enable row level security;
alter table public.social_accounts enable row level security;
alter table public.contents       enable row level security;
alter table public.publish_jobs   enable row level security;

-- ---------------------------------------------------------------------
-- 10. RLS policies
-- ---------------------------------------------------------------------

-- 10.1 organizations
create policy "org_select_members" on public.organizations
  for select to authenticated
  using (id = public.current_org_id());

create policy "org_update_admin" on public.organizations
  for update to authenticated
  using (id = public.current_org_id() and public.current_role() = 'ADMIN')
  with check (id = public.current_org_id());

-- INSERT/DELETE on organizations is forbidden directly — use the
-- public.create_organization() RPC defined below.

-- 10.2 profiles
create policy "profile_select_self_or_org" on public.profiles
  for select to authenticated
  using (
    id = auth.uid()
    or (organization_id is not null and organization_id = public.current_org_id())
  );

create policy "profile_update_self" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy "profile_update_admin" on public.profiles
  for update to authenticated
  using (organization_id = public.current_org_id() and public.current_role() = 'ADMIN')
  with check (organization_id = public.current_org_id());

-- 10.3 social_accounts
create policy "social_select_org" on public.social_accounts
  for select to authenticated
  using (organization_id = public.current_org_id());

create policy "social_write_managers" on public.social_accounts
  for all to authenticated
  using (
    organization_id = public.current_org_id()
    and public.current_role() in ('ADMIN', 'MANAGER')
  )
  with check (
    organization_id = public.current_org_id()
    and public.current_role() in ('ADMIN', 'MANAGER')
  );

-- 10.4 contents
create policy "content_select_org" on public.contents
  for select to authenticated
  using (organization_id = public.current_org_id());

create policy "content_insert_org" on public.contents
  for insert to authenticated
  with check (
    organization_id = public.current_org_id()
    and created_by = auth.uid()
  );

create policy "content_update_creator_or_admin" on public.contents
  for update to authenticated
  using (
    organization_id = public.current_org_id()
    and (created_by = auth.uid() or public.current_role() = 'ADMIN')
  )
  with check (organization_id = public.current_org_id());

create policy "content_delete_creator_or_admin" on public.contents
  for delete to authenticated
  using (
    organization_id = public.current_org_id()
    and (created_by = auth.uid() or public.current_role() = 'ADMIN')
  );

-- 10.5 publish_jobs (insert needs BOTH content & social account in caller's org)
create policy "publish_select_org" on public.publish_jobs
  for select to authenticated
  using (
    exists (
      select 1 from public.contents c
      where c.id = publish_jobs.content_id
        and c.organization_id = public.current_org_id()
    )
  );

create policy "publish_insert_org" on public.publish_jobs
  for insert to authenticated
  with check (
    exists (
      select 1 from public.contents c
      where c.id = publish_jobs.content_id
        and c.organization_id = public.current_org_id()
    )
    and exists (
      select 1 from public.social_accounts s
      where s.id = publish_jobs.social_account_id
        and s.organization_id = public.current_org_id()
    )
  );

-- UPDATE / DELETE on publish_jobs intentionally has NO policy for
-- `authenticated` — the BullMQ worker uses the service_role key and
-- bypasses RLS. Cancel/retry actions should also go through a server
-- action with service_role.

-- ---------------------------------------------------------------------
-- 11. Defense in depth — column-level lockdown
-- ---------------------------------------------------------------------

-- 11.1 Encrypted token columns are SERVER-ONLY (service_role).
revoke select (access_token_encrypted, refresh_token_encrypted) on public.social_accounts from authenticated, anon;
revoke insert (access_token_encrypted, refresh_token_encrypted) on public.social_accounts from authenticated, anon;
revoke update (access_token_encrypted, refresh_token_encrypted) on public.social_accounts from authenticated, anon;

-- 11.2 Block users from rewriting their own org membership / role
--      via the "profile_update_self" policy. Org join flows must go
--      through public.create_organization() or a server action that
--      uses service_role.
revoke update (organization_id, role) on public.profiles from authenticated, anon;

-- ---------------------------------------------------------------------
-- 12. RPC: create_organization
--     Atomically creates an org and promotes the caller to ADMIN.
--     Required because direct INSERT on organizations is forbidden,
--     and column-level revoke prevents a user from setting their own
--     organization_id / role afterwards.
-- ---------------------------------------------------------------------
create or replace function public.create_organization(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org_id  uuid;
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'authentication required';
  end if;

  if exists (select 1 from public.profiles where id = v_user_id and organization_id is not null) then
    raise exception 'user already belongs to an organization';
  end if;

  insert into public.organizations (name) values (p_name)
  returning id into v_org_id;

  update public.profiles
     set organization_id = v_org_id,
         role            = 'ADMIN'
   where id = v_user_id;

  return v_org_id;
end;
$$;

grant execute on function public.create_organization(text) to authenticated;

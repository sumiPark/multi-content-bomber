-- =====================================================================
-- 0004 — Caption presets (자주 사용하는 캡션 스타일 템플릿).
-- Apply via Supabase SQL Editor (or `supabase db push`), then regenerate
-- types: npx supabase gen types typescript --project-id <ref> > types/database.ts
-- =====================================================================

create table public.caption_presets (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  created_by      uuid references public.profiles (id) on delete set null,
  name            text not null,
  description     text,
  instructions    text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index caption_presets_org_idx on public.caption_presets (organization_id);

create trigger trg_caption_presets_updated_at
  before update on public.caption_presets
  for each row execute function public.set_updated_at();

alter table public.caption_presets enable row level security;

create policy "preset_select_org" on public.caption_presets
  for select to authenticated
  using (organization_id = public.current_org_id());

create policy "preset_insert_org" on public.caption_presets
  for insert to authenticated
  with check (
    organization_id = public.current_org_id()
    and created_by = auth.uid()
  );

create policy "preset_update_creator_or_admin" on public.caption_presets
  for update to authenticated
  using (
    organization_id = public.current_org_id()
    and (created_by = auth.uid() or public.current_role() = 'ADMIN')
  )
  with check (organization_id = public.current_org_id());

create policy "preset_delete_creator_or_admin" on public.caption_presets
  for delete to authenticated
  using (
    organization_id = public.current_org_id()
    and (created_by = auth.uid() or public.current_role() = 'ADMIN')
  );

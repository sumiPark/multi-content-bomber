-- =====================================================================
-- 0003 — Storage bucket for uploaded media + RLS policies.
-- Apply via Supabase SQL Editor (or `supabase db push`).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Bucket: 'media'
--    Private (public=false) — clients fetch via signed URLs only.
--    25MB per file, JPG/PNG/WEBP only.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'media',
  'media',
  false,
  26214400,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 2. RLS policies on storage.objects for the 'media' bucket.
--    Path convention: {organization_id}/{user_id}/{uuid}.{ext}
--    The first folder segment must match the caller's org.
-- ---------------------------------------------------------------------
create policy "media_select_org" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = public.current_org_id()::text
  );

create policy "media_insert_org" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = public.current_org_id()::text
    and (storage.foldername(name))[2] = auth.uid()::text
  );

create policy "media_delete_org" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = public.current_org_id()::text
    and (
      (storage.foldername(name))[2] = auth.uid()::text
      or public.current_role() = 'ADMIN'
    )
  );

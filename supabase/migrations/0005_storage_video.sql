-- =====================================================================
-- 0005 — Expand 'media' bucket to accept video (MP4/MOV) and bump size.
-- Apply via Supabase SQL Editor (or `supabase db push`).
-- =====================================================================

update storage.buckets
   set file_size_limit    = 104857600,                                              -- 100MB
       allowed_mime_types = array[
         'image/jpeg', 'image/png', 'image/webp',
         'video/mp4',  'video/quicktime'
       ]
 where id = 'media';

-- Note: Supabase project may also have a global upload limit (default 50MB).
-- For files >50MB, raise the project limit in Dashboard → Storage → Settings.

-- 0048_shoot_archive.sql — 자사 촬영 아카이브 (2026-11-05)
--
-- "올렸어요"를 누른 직접 촬영본에서 얼굴이 안 나오고 품질이 좋은 짧은 제품 컷만(손 · 팔 허용) 따로 남겨 AI 자동 영상에 다시 쓴다.
-- 원본 삭제 기간(올린 뒤 14일 · 안 올리면 30일)은 그대로다. 소리는 남기지 않는다.
-- 워커(service_role)만 쓴다 — RLS를 켜고 정책을 두지 않는다.

alter table public.shoot_requests
  add column if not exists archived_at timestamptz,
  add column if not exists archive_attempts integer not null default 0;

create table if not exists public.shoot_archive_clips (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  product_id       uuid not null references public.products (id) on delete cascade,
  shoot_request_id uuid references public.shoot_requests (id) on delete set null,
  source_path      text not null,
  source_start     numeric not null,
  seconds          numeric not null,
  what             text not null,
  path             text not null unique,
  use_count        integer not null default 0,
  last_used_at     timestamptz,
  created_at       timestamptz not null default now(),
  unique (source_path, source_start)
);
create index if not exists shoot_archive_clips_product_idx
  on public.shoot_archive_clips (organization_id, product_id, last_used_at);
alter table public.shoot_archive_clips enable row level security;

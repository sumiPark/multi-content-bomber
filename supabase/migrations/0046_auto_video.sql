-- 0046_auto_video.sql — AI 자동 콘텐츠 영상 (2026-11-04)
--
-- content_plans.video: AI 자동 칸의 완성본 경로 · 편집 계획 · 쓴 소재 출처를 담는다.
--   직접 촬영은 shoot_requests에 따로 있으므로 이 칸은 track 'B'에서만 쓴다.
--   { state, startedAt, attempts, path, thumbnail, seconds, plan, sources, sounds, warnings, madeAt }
-- stock_searches: Pixabay API 조건(요청을 24시간 저장)대로 검색 결과를 저장한다.
-- stock_videos: 로고 · 사람 · 글자 · 실사가 아니어서 탈락한 스톡 영상을 저장해 같은 영상을 다시 검수하지 않는다.
-- 스톡 표 두 개는 워커(service_role)만 쓴다 — RLS를 켜고 정책을 두지 않는다.

alter table public.content_plans
  add column if not exists video jsonb;

create table if not exists public.stock_searches (
  query      text primary key,
  hits       jsonb not null default '[]'::jsonb,
  fetched_at timestamptz not null default now()
);
alter table public.stock_searches enable row level security;

create table if not exists public.stock_videos (
  provider   text not null,
  video_id   bigint not null,
  rejected   boolean not null default false,
  reason     text,
  page_url   text,
  checked_at timestamptz not null default now(),
  primary key (provider, video_id)
);
alter table public.stock_videos enable row level security;

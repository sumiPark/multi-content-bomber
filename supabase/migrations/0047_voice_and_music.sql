-- 0047_voice_and_music.sql — 계정별 목소리와 영상별 음악 검색 (2026-11-04)
--
-- account_concepts: 목소리를 방식별로 따로 저장한다. AI 자동은 auto_voice_id, 직접 촬영은 shoot_voice_id만 읽는다.
--   비어 있으면 기본 목소리. 음성 모델은 코드(kit.json)에 무료 모델로 고정돼 있어 여기 없다.
-- stock_music: 검색해서 쓴 CC0 곡의 기록. 무음이 많거나 너무 작은 곡은 다시 받지 않고, 같은 곡을 14일 안에 반복하지 않는다.
--   워커(service_role)만 쓴다 — RLS를 켜고 정책을 두지 않는다.

alter table public.account_concepts
  add column if not exists auto_voice_id text,
  add column if not exists shoot_voice_id text;

create table if not exists public.stock_music (
  track_id     text primary key,
  title        text,
  creator      text,
  landing      text,
  license      text,
  rejected     boolean not null default false,
  reason       text,
  last_used_at timestamptz,
  checked_at   timestamptz not null default now()
);
alter table public.stock_music enable row level security;

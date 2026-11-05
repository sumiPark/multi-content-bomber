-- 0050_generated_visuals.sql — 영상 중간에 넣는 AI 이미지 라이브러리 (2026-11-05)
--
-- 성분 · 원료 · 원리를 설명하는 그림을 key로 저장해 다시 쓴다. 같은 그림은 한 번만 생성한다.
-- 공개 안 함, 정책 없음: service_role(워커)만 읽고 쓴다. 기존 테이블은 바꾸지 않는다.

create table public.generated_visuals (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  subject text not null,
  prompt text not null,
  model text not null,
  quality text,
  path text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd numeric(10, 5) not null default 0,
  use_count integer not null default 0,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.generated_visuals enable row level security;

insert into storage.buckets (id, name, public)
values ('generated-visuals', 'generated-visuals', false)
on conflict (id) do nothing;

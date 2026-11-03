-- =====================================================================
-- 0033 — 보관함 = 사람이 '임시 저장'을 누른 콘텐츠만
--
-- 지금까지는 콘텐츠 생성 3단계(캡션 만들기 · 직접 쓰기 시작)에서 contents 행이 생기는 순간
-- 보관함에 보였다(발행 잡이 없는 콘텐츠 전부). 작업하다 그만둔 것까지 쌓여서, 사용자 결정으로
-- 콘텐츠 생성 화면의 '임시 저장'을 눌렀을 때만 보관함에 넣는다(2026-11-03).
--
-- contents.draft_saved_at  임시 저장한 시각. null이면 보관함에 안 보인다(이 마이그레이션 전 행도 null —
--                          예전에 저절로 쌓인 초안은 보관함에서 빠진다. 지우지는 않는다).
-- contents.draft_state     이어서 하기용 마법사 상태(고른 계정 · 단계 · 캡션 방식 · 예약 시각 · 시리즈 선택 ·
--                          미디어 검증 결과 등). 화면 상태라 서버 로직은 읽지 않는다.
--
-- 보관함은 여전히 "발행 잡이 없는" 콘텐츠만 — 발행을 등록하면 배포 관리로 넘어간다.
-- 쓰기는 기존 content_update_creator_or_admin 정책(만든 사람 또는 ADMIN) 그대로.
-- 적용: `supabase db push`. ⚠️ 앱 배포 전에 먼저. types/database.ts에는 수동으로 추가.
-- =====================================================================

alter table public.contents
  add column if not exists draft_saved_at timestamptz,
  add column if not exists draft_state jsonb;

create index if not exists contents_draft_saved_idx
  on public.contents (organization_id, draft_saved_at desc)
  where draft_saved_at is not null;

comment on column public.contents.draft_saved_at is
  '콘텐츠 생성 화면에서 임시 저장한 시각. null이면 보관함에 안 보인다.';
comment on column public.contents.draft_state is
  '이어서 하기용 마법사 상태(화면 전용). 서버 로직은 읽지 않는다.';

-- 0042_shoot_list.sql — 직접 촬영을 날짜 · 시각 칸에서 떼어 "계정별 기획 목록 + 직접 업로드"로 (2026-11-04 사용자 결정)
--
-- 흐름 (content_plans.track = 'A'):
--   PROPOSED(목록에 있는 기획, 계정당 5개 유지) → 고르면 CONFIRMED → 컷 리스트 SCRIPTED → 촬영 SHOT → 편집 RENDERED
--   → 사람이 받아서 직접 올린 뒤 "올렸어요" + 릴스 선택 → PUBLISHED(posted_*). 자동 예약 · 시각 지나면 건너뛰기는 없다.
-- AI 자동(track = 'B')은 지금처럼 날짜 · 시각이 있어야 한다.

alter table public.content_plans
  alter column slot_date drop not null,
  alter column slot_time drop not null;

alter table public.content_plans drop constraint if exists content_plans_auto_has_slot;
alter table public.content_plans
  add constraint content_plans_auto_has_slot check (track <> 'B' or (slot_date is not null and slot_time is not null));

alter table public.content_plans
  -- "올렸어요"로 연결한 인스타 릴스 (social_posts.platform_media_id와 같은 값)
  add column if not exists posted_media_id  text,
  add column if not exists posted_permalink text,
  add column if not exists posted_at        timestamptz,
  add column if not exists posted_by        uuid references public.profiles (id) on delete set null,
  -- 받기 전에 사람이 확인한 광고 문구 · 판매 상태 경고 (문구 그대로 저장 — 새 경고가 생기면 다시 확인받는다)
  add column if not exists warnings_ack     jsonb not null default '[]'::jsonb,
  add column if not exists warnings_ack_by  uuid references public.profiles (id) on delete set null,
  add column if not exists warnings_ack_at  timestamptz;

-- 한 릴스는 기획 하나에만 연결한다
create unique index if not exists content_plans_posted_media_uq
  on public.content_plans (social_account_id, posted_media_id) where posted_media_id is not null;

create index if not exists content_plans_shoot_list_idx
  on public.content_plans (social_account_id, status, created_at) where track = 'A';

-- 기획 목록을 만들 계정 (쓸 상품 범위는 AI 자동과 함께 쓴다)
alter table public.track_settings
  add column if not exists shoot_enabled boolean not null default false;

update public.track_settings t
   set shoot_enabled = true
 where exists (select 1 from public.slot_rules r where r.social_account_id = t.social_account_id and r.track = 'A' and r.active);

-- 예전 칸 정리: 아직 고르지 않은 기획(촬영 요청 없음)과 직접 촬영 칸 규칙.
-- 규칙을 끄지 않고 지우는 이유: slot_rules는 계정 · 시각이 유일해서, 남겨 두면 같은 시각에 AI 자동 칸을 넣지 못한다.
delete from public.content_plans where track = 'A' and status = 'PROPOSED';
delete from public.slot_rules where track = 'A';

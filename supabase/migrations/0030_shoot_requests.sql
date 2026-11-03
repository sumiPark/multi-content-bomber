-- =====================================================================
-- 0030 — 직접 촬영 콘텐츠(12 · 18시 칸, 콘텐츠 자동화 4단계 A 트랙)
--
-- 흐름 (content_plans.status, track = 'A'):
--   PROPOSED  AI가 칸마다 기획안 후보 2~3개 제안 (proposal.ideas)
--   CONFIRMED 사람이 후보를 고르거나 상품을 직접 지정 → 촬영 컷 리스트 대기
--   SCRIPTED  기획 · 글 에이전트(2)가 컷 리스트 · 화면 문구 · 캡션 작성 → 촬영 대기 (shoot_requests 생김)
--   SHOT      촬영본을 다 올림 → 자동 편집 대기  ← 새 상태
--   RENDERED  편집본 완성 → 사람이 완성본 확인
--   SCHEDULED 확인 → publish_jobs 예약 / SKIPPED · BLOCKED · FAILED는 B와 같다
--
-- shoot_requests  칸 하나의 촬영 일: 찍을 컷 목록(체크) · 컷마다 올린 촬영본 · 촬영 마감 · 편집 결과.
--                 컷 리스트 원본(AI 출력)은 content_plans.script, 촬영 진행 상태는 여기.
-- track_settings.a_shoot_deadline  촬영 마감(안내용) — 올리기 전날 이 시각(KST). 지나도 막지 않는다.
-- content_plans.human_brief        상품을 직접 지정할 때 사람이 남긴 메모(찍고 싶은 것)
--
-- 쓰기는 워커 · 서버 액션이 service_role로. authenticated는 같은 조직 SELECT만.
-- 촬영본 파일은 기존 'media' 버킷 경로 규칙({org}/{user}/...)을 그대로 쓴다(0003).
-- 적용: `supabase db push`. ⚠️ 앱 배포 전에 먼저. types/database.ts에는 수동으로 추가.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. content_plans — SHOT 상태 · 사람 메모
-- ---------------------------------------------------------------------
alter table public.content_plans drop constraint if exists content_plans_status_check;
alter table public.content_plans add constraint content_plans_status_check
  check (status in ('PROPOSED', 'CONFIRMED', 'SCRIPTED', 'SHOT', 'RENDERED', 'BLOCKED', 'SCHEDULED', 'PUBLISHED', 'SKIPPED', 'FAILED'));

alter table public.content_plans add column if not exists human_brief text;

-- ---------------------------------------------------------------------
-- 2. track_settings — 촬영 마감(안내용)
-- ---------------------------------------------------------------------
alter table public.track_settings
  add column if not exists a_shoot_deadline text not null default '14:00'
    check (a_shoot_deadline ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

comment on column public.track_settings.a_shoot_deadline is
  '직접 촬영 칸 촬영 마감 — 올리기 전날 이 시각(KST). 안내용이라 지나도 올릴 수 있다.';

-- ---------------------------------------------------------------------
-- 3. shoot_requests
--    OPEN      촬영 대기 (컷마다 촬영본을 올리는 중)
--    UPLOADED  사람이 "다 올렸어요" → 편집 대기
--    EDITING   편집 워커가 작업 중
--    EDITED    편집본 완성 (rendered_path)
--    FAILED    편집 실패 (error) / CANCELLED 칸을 건너뜀
-- ---------------------------------------------------------------------
create table if not exists public.shoot_requests (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  plan_id         uuid not null unique references public.content_plans (id) on delete cascade,
  status          text not null default 'OPEN'
    check (status in ('OPEN', 'UPLOADED', 'EDITING', 'EDITED', 'FAILED', 'CANCELLED')),
  -- [{no, seconds, shot, how, on_screen, voice, done}] — 컷 리스트에서 복사, done은 사람이 체크
  cuts            jsonb not null default '[]'::jsonb,
  -- [{cut, path, name, size, type, uploaded_at, uploaded_by}] — 컷마다 올린 촬영본(media 버킷)
  clips           jsonb not null default '[]'::jsonb,
  due_at          timestamptz,
  -- 편집 결과: 컷별 사용 구간 · 길이 · 자막 등 (편집 에이전트(3))
  edit            jsonb,
  rendered_path   text,
  error           text,
  uploaded_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists shoot_requests_status_idx on public.shoot_requests (status, due_at);

drop trigger if exists trg_shoot_requests_updated_at on public.shoot_requests;
create trigger trg_shoot_requests_updated_at before update on public.shoot_requests
  for each row execute function public.set_updated_at();

alter table public.shoot_requests enable row level security;

drop policy if exists "shoot_requests_select_org" on public.shoot_requests;
create policy "shoot_requests_select_org" on public.shoot_requests
  for select to authenticated using (organization_id = public.current_org_id());

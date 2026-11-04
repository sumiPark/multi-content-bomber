-- =====================================================================
-- 0038 — 계정 컨셉
--
-- 인스타 계정마다 AI 자동 업로드 · 직접 촬영 각각의 방향을 글로 적어 둔다.
-- 기획 · 대본 · 컷 리스트 에이전트가 프롬프트로 읽고, 편집 워커가 편집 값으로 읽는다.
--
--   auto_concept       AI 자동 업로드 기획 컨셉
--   auto_video_style   AI 자동 업로드 영상 생성 스타일 (대본의 장면 설명에 쓰고, 영상 생성을 붙이면 거기서도 읽는다)
--   shoot_concept      직접 촬영 기획 컨셉
--   shoot_edit_style   직접 촬영 편집 스타일 (글)
--   shoot_edit_params  위 글을 AI가 편집 값으로 옮긴 것 (lib/shoot/edit-style.ts). 비면 기본 편집
--
-- track_settings에 넣지 않은 이유: 편성에서 계정을 뺐다 다시 넣어도 컨셉이 남아야 한다.
-- 쓰기는 서버 액션이 service_role로 한다. authenticated는 같은 조직 SELECT만. 기존 테이블은 건드리지 않는다.
-- 앱 코드가 조회하므로 배포 전에 먼저 적용할 것. types/database.ts에는 수동으로 추가해 뒀다.
-- =====================================================================

create table if not exists public.account_concepts (
  social_account_id  uuid primary key references public.social_accounts (id),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  auto_concept       text not null default '' check (char_length(auto_concept) <= 1000),
  auto_video_style   text not null default '' check (char_length(auto_video_style) <= 1000),
  shoot_concept      text not null default '' check (char_length(shoot_concept) <= 1000),
  shoot_edit_style   text not null default '' check (char_length(shoot_edit_style) <= 1000),
  shoot_edit_params  jsonb,
  updated_by         uuid references public.profiles (id) on delete set null,
  updated_at         timestamptz not null default now()
);

create index if not exists account_concepts_org_idx on public.account_concepts (organization_id);

drop trigger if exists trg_account_concepts_updated_at on public.account_concepts;
create trigger trg_account_concepts_updated_at before update on public.account_concepts
  for each row execute function public.set_updated_at();

alter table public.account_concepts enable row level security;

drop policy if exists "account_concepts_select_org" on public.account_concepts;
create policy "account_concepts_select_org" on public.account_concepts
  for select to authenticated using (organization_id = public.current_org_id());

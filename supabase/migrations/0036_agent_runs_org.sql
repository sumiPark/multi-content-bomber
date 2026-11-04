-- =====================================================================
-- 0036 — 에이전트 실행 기록(agent_runs)을 조직별로만 보이게
--
-- 0028의 SELECT 정책이 "로그인했고 조직이 있으면"(current_org_id() is not null)이라, 다른 조직 사용자도
-- 실행 기록(계정 이름 · 상품 · 결과)을 볼 수 있었다(2026-11-04 점검). organization_id를 넣고 같은 조직만 보이게 한다.
--
-- 채우기: plan_id가 있으면 그 칸의 조직, 없으면 input.account(계정 이름)로 인스타 계정의 조직,
--         프로필 채점은 input.review_id로 채점 행(profile_reviews)의 조직.
--         둘 다 없으면 비워 둔다(아무에게도 안 보인다 — 쓰는 곳은 에이전트 화면뿐).
-- 쓰기는 워커 · 실행기가 service_role로(organization_id를 함께 넣는다, lib/agents/runner.ts).
-- 적용: `supabase db push`. ⚠️ 앱 배포 전에 먼저. types/database.ts에는 수동으로 추가.
-- =====================================================================

alter table public.agent_runs
  add column if not exists organization_id uuid references public.organizations (id) on delete cascade;

update public.agent_runs r
   set organization_id = p.organization_id
  from public.content_plans p
 where r.organization_id is null
   and r.plan_id = p.id;

update public.agent_runs r
   set organization_id = s.organization_id
  from public.social_accounts s
 where r.organization_id is null
   and s.platform = 'INSTAGRAM'
   and s.display_name = r.input ->> 'account';

-- 프로필 채점 실행(agent='analyze', input.task='profile_review')은 채점 행으로
update public.agent_runs r
   set organization_id = pr.organization_id
  from public.profile_reviews pr
 where r.organization_id is null
   and r.input ->> 'review_id' = pr.id::text;

create index if not exists agent_runs_org_started_idx on public.agent_runs (organization_id, started_at desc);

drop policy if exists "agent_runs_select_auth" on public.agent_runs;
drop policy if exists "agent_runs_select_org" on public.agent_runs;
create policy "agent_runs_select_org" on public.agent_runs
  for select to authenticated using (organization_id = public.current_org_id());

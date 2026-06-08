-- =====================================================================
-- 0011 — 단일 공유 워크스페이스
-- 모든 가입자가 하나의 워크스페이스(조직)를 ADMIN 권한으로 공유한다.
-- 개별 워크스페이스 생성/초대 합류 대신, 가입 즉시 공유 조직에 자동 배정.
-- 적용: Supabase SQL Editor (또는 `supabase db push`).
--       스키마(컬럼/함수 시그니처) 변경이 없으므로 타입 재생성은 불필요.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 공유 조직 보장 + 기존 데이터 통합
--    canonical = 가장 먼저 만들어진 조직(없으면 새로 생성).
--    흩어진 모든 org-scope 행과 프로필을 canonical로 모으고, 나머지 조직은
--    비운 뒤 삭제한다. (현재는 사실상 단일 조직이라 no-op에 가깝다)
-- ---------------------------------------------------------------------
do $$
declare
  v_org uuid;
begin
  select id into v_org from public.organizations order by created_at asc limit 1;
  if v_org is null then
    insert into public.organizations (name) values ('공유 워크스페이스')
    returning id into v_org;
  end if;

  -- org 단위로 묶인 데이터를 canonical 조직으로 이전
  update public.social_accounts set organization_id = v_org where organization_id is distinct from v_org;
  update public.contents        set organization_id = v_org where organization_id is distinct from v_org;
  update public.invitations     set organization_id = v_org where organization_id is distinct from v_org;

  -- 모든 프로필을 공유 조직 + ADMIN으로
  update public.profiles
     set organization_id = v_org, role = 'ADMIN'
   where organization_id is distinct from v_org or role <> 'ADMIN';

  -- 비어버린 다른 조직 정리
  delete from public.organizations where id <> v_org;
end $$;

-- ---------------------------------------------------------------------
-- 2. 신규 가입자 → 공유 조직에 ADMIN으로 자동 배정
--    (기존 트리거는 organization_id를 NULL로 두어 온보딩을 강제했다)
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
begin
  select id into v_org from public.organizations order by created_at asc limit 1;

  insert into public.profiles (id, organization_id, role, email, full_name, avatar_url)
  values (
    new.id,
    v_org,                                  -- 단일 공유 워크스페이스
    'ADMIN',                                -- 전원 풀권한
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. 개별 워크스페이스 생성 차단
--    단일 공유 워크스페이스 정책이므로 새 조직 생성 RPC 호출 권한을 회수한다.
--    (함수 정의는 남겨 두되 authenticated가 실행하지 못하게 한다)
-- ---------------------------------------------------------------------
revoke execute on function public.create_organization(text) from authenticated;

-- 레거시로 organization_id가 NULL인 계정은 앱의 /onboarding 라우트가
-- service_role로 공유 조직에 합류시킨다(자가치유). 별도 RPC는 두지 않는다.

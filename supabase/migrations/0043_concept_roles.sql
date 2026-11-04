-- 0043_concept_roles.sql — 영상 방향(상품 중심 / 사람 중심)을 AI 자동과 직접 촬영에 따로 둔다 (2026-11-04 사용자 결정)
--
-- 사용자 결정: 쓸 상품은 함께 쓰고, 영상을 만들 때 참고할 내용은 전체 자동 영상과 직접 촬영 영상이 섞이면 안 된다.
-- social_accounts.role_focus는 프로필 점수 · 계정 분석의 계정 성격으로만 남긴다. 영상 생성은 여기 값을 읽는다.

alter table public.account_concepts
  add column if not exists auto_role_focus  text check (auto_role_focus in ('PRODUCT', 'PERSON')),
  add column if not exists shoot_role_focus text check (shoot_role_focus in ('PRODUCT', 'PERSON'));

-- 이미 계정 역할을 정해 둔 계정은 양쪽에 같은 값으로 시작한다
insert into public.account_concepts (social_account_id, organization_id, auto_role_focus, shoot_role_focus)
select id, organization_id, role_focus, role_focus
  from public.social_accounts
 where role_focus in ('PRODUCT', 'PERSON')
on conflict (social_account_id) do update
  set auto_role_focus = excluded.auto_role_focus,
      shoot_role_focus = excluded.shoot_role_focus;

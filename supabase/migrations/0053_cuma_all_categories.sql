-- 0053: 오늘과일 전체 카테고리 수집 (2026-11-10 사용자 결정)
--
-- 오늘과일에는 과일 말고도 채소 · 수산 · 축산 · 식품이 있다. 그동안 "오늘과일 과일"만 고를 수 있어
-- 과일 카테고리만 수집됐다. 이제 오늘과일은 몰 전체를 수집하고, 과일 외 카테고리는 새 종류 FOOD(식품)로 분석한다.
--   1) 종류 값에 FOOD를 허용한다 (shop_categories.kind · products.kind · content_rules.scope)
--   2) 아직 사람이 손대지 않은(수집 안 함 · 종류 없음) 오늘과일 카테고리를 수집 대상으로 바꾼다
--      - 식품 > 건강식품은 HEALTH_FOOD(건기식 표기 여부는 분석이 판정), 나머지는 FOOD
--   3) "오늘과일 과일"을 고른 계정의 쓸 상품에 오늘과일 식품 · 건강식품을 더한다
-- 기존 과일 상품 · 분석 · 발행 이력은 바꾸지 않는다.

-- 1) 종류 값에 FOOD 허용 — 0025 · 0026이 이름 없이 만든 CHECK라 이름 대신 정의로 찾아 지운다
do $$
declare r record;
begin
  for r in
    select c.conrelid::regclass as tbl, c.conname
    from pg_constraint c
    where c.contype = 'c'
      and (
        (c.conrelid in ('public.shop_categories'::regclass, 'public.products'::regclass)
          and pg_get_constraintdef(c.oid) ilike '%kind%FRUIT%')
        or (c.conrelid = 'public.content_rules'::regclass
          and pg_get_constraintdef(c.oid) ilike '%scope%FRUIT%')
      )
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end $$;

alter table public.shop_categories drop constraint if exists shop_categories_kind_check;
alter table public.shop_categories
  add constraint shop_categories_kind_check
  check (kind in ('FRUIT', 'FOOD', 'COSMETIC', 'HEALTH_FOOD', 'CLOTHING', 'OTHER'));

alter table public.products drop constraint if exists products_kind_check;
alter table public.products
  add constraint products_kind_check
  check (kind in ('FRUIT', 'FOOD', 'COSMETIC', 'HEALTH_FOOD', 'CLOTHING', 'OTHER'));

alter table public.content_rules drop constraint if exists content_rules_scope_check;
alter table public.content_rules
  add constraint content_rules_scope_check
  check (scope in ('ALL', 'FRUIT', 'FOOD', 'COSMETIC', 'HEALTH_FOOD', 'CLOTHING'));

-- 2) 오늘과일의 과일 외 카테고리를 수집 대상으로 (사람이 바꾼 행은 그대로 둔다)
update public.shop_categories
set collect = true,
    kind = case when name = '건강식품' then 'HEALTH_FOOD' else 'FOOD' end
where shop_code = 'cuma'
  and collect = false
  and kind is null;

-- 3) "오늘과일 과일"을 쓰던 계정 → 오늘과일 전체
update public.track_settings
set product_scopes = product_scopes
  || case when product_scopes @> '[{"shop":"cuma","kind":"FOOD"}]'::jsonb then '[]'::jsonb
          else '[{"shop":"cuma","kind":"FOOD"}]'::jsonb end
  || case when product_scopes @> '[{"shop":"cuma","kind":"HEALTH_FOOD"}]'::jsonb then '[]'::jsonb
          else '[{"shop":"cuma","kind":"HEALTH_FOOD"}]'::jsonb end
where product_scopes @> '[{"shop":"cuma","kind":"FRUIT"}]'::jsonb;

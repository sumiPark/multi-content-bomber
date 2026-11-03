-- =====================================================================
-- 0025 — 세 몰 상품 + 상세페이지(이미지) 분석 (콘텐츠 자동화 2단계)
--
-- 오늘과일(cuma) · 쿠마마켓(cm) · 리유코스메틱(ru)은 같은 백엔드의 공개 상품 API를 쓴다.
-- 상품 수집기(worker/collect-products.ts)가 매일 받아 오고, 바뀐 상품만 상세 이미지
-- 분석기(worker/analyze-products.ts)가 다시 읽는다. 상품 선정 · 기획 에이전트가 읽는 재료.
--
--   shops                   몰 3개 (API 주소 · 상품 페이지 주소)
--   shop_categories         몰 카테고리 트리 + 수집 여부 · 상품 종류(과일/화장품/건기식/의류)
--   products                상품 한 건 = 한 행 (가격 · 판매 상태 · 대표/상세 이미지)
--   product_image_extracts  상세 이미지 한 장의 추출 결과 (원문 텍스트 + 구조화)
--   product_analyses        상품 요약 (종류별 항목 + 원문 인용 근거 + 사람 검수)
--
-- 쓰기는 워커와 서버 액션이 service_role로 한다. authenticated는 SELECT만
-- (몰 상품은 조직 구분 없이 공유 워크스페이스 하나가 쓴다 — 0011).
--
-- 적용: Supabase SQL Editor (또는 `supabase db push`).
--   ⚠️ 앱 코드가 이 테이블들을 조회하므로 배포 전에 먼저 적용할 것.
--   types/database.ts에는 수동으로 추가해 뒀다.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. shops
-- ---------------------------------------------------------------------
create table if not exists public.shops (
  code       text primary key check (code in ('cuma', 'cm', 'ru')),
  name       text not null,
  api_base   text not null,
  site_base  text not null,
  enabled    boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.shops (code, name, api_base, site_base) values
  ('cuma', '오늘과일',     'https://service.cuma.co.kr',          'https://www.cuma.co.kr'),
  ('cm',   '쿠마마켓',     'https://service.cumamarket.co.kr',    'https://www.cumamarket.co.kr'),
  ('ru',   '리유코스메틱', 'https://prod.service.reucosmetic.com', 'https://www.reucosmetic.com')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------
-- 2. shop_categories — 몰 카테고리 트리
--    collect: 이 카테고리 상품을 수집할지. 처음 발견될 때 앱 기본값(lib/products/shops.ts)으로
--             정하고, 이후엔 상품 화면에서 사람이 바꾼 값을 유지한다.
--    kind:    분석 스키마를 고르는 상품 종류. 하위 카테고리는 부모 값을 물려받는다.
-- ---------------------------------------------------------------------
create table if not exists public.shop_categories (
  shop_code   text not null references public.shops (code),
  category_id int not null,
  parent_id   int,
  name        text not null,
  collect     boolean not null default false,
  kind        text check (kind in ('FRUIT', 'COSMETIC', 'HEALTH_FOOD', 'CLOTHING', 'OTHER')),
  seen_at     timestamptz not null default now(),
  primary key (shop_code, category_id)
);

-- ---------------------------------------------------------------------
-- 3. products
-- ---------------------------------------------------------------------
create table if not exists public.products (
  id                  uuid primary key default gen_random_uuid(),
  shop_code           text not null references public.shops (code),
  shop_product_id     bigint not null,
  name                text not null,
  summary_title       text,
  category_id         int,
  category_name       text,
  kind                text check (kind in ('FRUIT', 'COSMETIC', 'HEALTH_FOOD', 'CLOTHING', 'OTHER')),
  price               int,
  -- available(판매 중) / temporarily_out(일시 품절) / discontinued(판매 중지) / unavailable(노출 안 됨 · 사라짐)
  stock_status        text not null default 'unavailable'
    check (stock_status in ('available', 'temporarily_out', 'discontinued', 'unavailable')),
  product_status      text,             -- 몰 원본 값 (stock_in, temp_stock_out, ...)
  url                 text not null,
  represent_image_url text,
  detail_image_urls   text[] not null default '{}',
  source_updated_at   timestamptz,
  -- 이름 · 요약 · 상세 이미지 · 수정일의 해시. 바뀌면 분석을 다시 한다(가격 · 재고만 바뀌면 안 함).
  source_hash         text not null,
  raw                 jsonb not null default '{}'::jsonb,
  -- 사람이 이 상품을 추천 · 수집에서 뺌
  excluded            boolean not null default false,
  -- queued → analyzing → ready(자동 통과) | review(사람 확인 필요) | insufficient(근거 부족)
  --        | failed(3번 실패) | skipped(분석 안 하는 종류)
  analysis_state      text not null default 'queued'
    check (analysis_state in ('queued', 'analyzing', 'ready', 'review', 'insufficient', 'failed', 'skipped')),
  analysis_attempts   int not null default 0,
  analysis_next_at    timestamptz not null default now(),
  analysis_error      text,
  -- 분석기가 잡고 있는 동안의 잠금 (워커가 죽으면 locked_until이 지나 다시 집힌다)
  analysis_locked_until timestamptz,
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (shop_code, shop_product_id)
);

create index if not exists products_shop_kind_idx
  on public.products (shop_code, kind, stock_status);
create index if not exists products_analysis_due_idx
  on public.products (analysis_next_at)
  where analysis_state in ('queued', 'analyzing');

drop trigger if exists trg_products_updated_at on public.products;
create trigger trg_products_updated_at before update on public.products
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 4. product_image_extracts — 상세 이미지 한 장 = 한 행
--    상세 이미지 URL에는 업로드 시각이 들어 있어 내용이 바뀌면 URL도 바뀐다.
--    그래서 같은 URL이면 상품 해시가 바뀌어도 추출 결과를 다시 쓴다(분석 비용 절약).
-- ---------------------------------------------------------------------
create table if not exists public.product_image_extracts (
  product_id    uuid not null references public.products (id) on delete cascade,
  image_url     text not null,
  image_index   int not null,
  -- 이미지에 보이는 글자 그대로 (원문 인용 확인의 기준)
  text          text not null default '',
  data          jsonb not null default '{}'::jsonb,
  uncertainties text[] not null default '{}',
  part_count    int not null default 1,
  width         int,
  height        int,
  model         text,
  analyzed_at   timestamptz not null default now(),
  primary key (product_id, image_url)
);

-- ---------------------------------------------------------------------
-- 5. product_analyses — 상품 요약 (상품당 최신 1행)
--    summary:  종류별 항목 (과일: 산지 · 품종 · 중량/크기 · 맛 · 보관 / 화장품: 성분 · 고민 · 사용법 /
--              건기식: 기능성 · 섭취 방법 · 주의 / 의류: 소재 · 사이즈 · 핏 · 세탁)
--    claims:   콘텐츠에 쓸 수 있는 특징 문장 + 근거 원문 인용 [{claim, imageIndex, quote}].
--              인용이 추출 원문에 실제로 있는 것만 남긴다.
--    health_functional / functional_claims: 건기식 여부와 기능성 문구(원문 그대로) —
--              표현 규칙 화면에서 사람이 확정하면 심의 문구가 된다.
-- ---------------------------------------------------------------------
create table if not exists public.product_analyses (
  product_id        uuid primary key references public.products (id) on delete cascade,
  kind              text not null,
  summary           jsonb not null default '{}'::jsonb,
  claims            jsonb not null default '[]'::jsonb,
  health_functional boolean,
  functional_claims text[] not null default '{}',
  uncertainties     text[] not null default '{}',
  -- AI가 버린 근거(인용이 원문에 없음) — 검수 화면에서 보여 준다
  rejected_claims   jsonb not null default '[]'::jsonb,
  model             text,
  source_hash       text not null,
  analyzed_at       timestamptz not null default now(),
  -- 사람 검수: 고친 내용은 summary/claims에 덮어쓰고 edited=true로 남긴다(다시 분석해도 유지)
  edited            boolean not null default false,
  approved_by       uuid references public.profiles (id) on delete set null,
  approved_at       timestamptz
);

-- ---------------------------------------------------------------------
-- 6. 분석 대기 상품 선점 (FOR UPDATE SKIP LOCKED — 분석기 여러 개가 겹쳐도 중복 없음)
-- ---------------------------------------------------------------------
create or replace function public.claim_products_for_analysis(
  p_limit int,
  p_lock_minutes int
)
returns setof public.products
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  update public.products p
     set analysis_state = 'analyzing',
         analysis_locked_until = now() + make_interval(mins => p_lock_minutes)
   where p.id in (
     select id from public.products
      where not excluded
        and stock_status in ('available', 'temporarily_out')
        and (
          (analysis_state = 'queued' and analysis_next_at <= now())
          or (analysis_state = 'analyzing' and analysis_locked_until < now())
        )
      order by analysis_next_at
      limit p_limit
      for update skip locked
   )
  returning p.*;
end;
$$;

revoke execute on function public.claim_products_for_analysis(int, int) from public, anon, authenticated;
grant execute on function public.claim_products_for_analysis(int, int) to service_role;

-- ---------------------------------------------------------------------
-- 7. RLS — 로그인한 사용자는 SELECT만. 쓰기 정책 없음(service_role 전용).
-- ---------------------------------------------------------------------
alter table public.shops                  enable row level security;
alter table public.shop_categories        enable row level security;
alter table public.products               enable row level security;
alter table public.product_image_extracts enable row level security;
alter table public.product_analyses       enable row level security;

drop policy if exists "shops_select_auth" on public.shops;
create policy "shops_select_auth" on public.shops
  for select to authenticated using (public.current_org_id() is not null);

drop policy if exists "shop_categories_select_auth" on public.shop_categories;
create policy "shop_categories_select_auth" on public.shop_categories
  for select to authenticated using (public.current_org_id() is not null);

drop policy if exists "products_select_auth" on public.products;
create policy "products_select_auth" on public.products
  for select to authenticated using (public.current_org_id() is not null);

drop policy if exists "product_image_extracts_select_auth" on public.product_image_extracts;
create policy "product_image_extracts_select_auth" on public.product_image_extracts
  for select to authenticated using (public.current_org_id() is not null);

drop policy if exists "product_analyses_select_auth" on public.product_analyses;
create policy "product_analyses_select_auth" on public.product_analyses
  for select to authenticated using (public.current_org_id() is not null);

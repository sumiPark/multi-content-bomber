-- 0051_video_knowledge.sql — 설명 영상의 근거 자료 (2026-11-06 사용자 결정)
--
-- AI 자동 영상이 60~85초 설명 영상으로 바뀌며 상품 자료 밖의 상식과 "우리 차이"를 쓰게 됐다.
--   knowledge_cards      성분 뜻 · 품종 유래 · 보관 원리 같은 상식 한 문장과 출처. 승인한 카드만 대본에 쓴다
--   product_differences  상품별 차이와 비교 기준. 담당자가 확정한 것만 대본에 쓴다
-- AI는 DRAFT까지만 만든다. 쓰기는 서버 액션과 워커가 service_role로 하고, authenticated는 같은 조직 SELECT만.
-- 기존 테이블은 바꾸지 않는다. 앱 코드가 조회하므로 배포 전에 먼저 적용할 것.

create table public.knowledge_cards (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  product_kind text not null check (product_kind in ('FRUIT', 'COSMETIC', 'HEALTH_FOOD', 'CLOTHING', 'ALL')),
  topic text not null check (char_length(topic) between 1 and 60),
  -- 상품 자료에서 찾을 낱말. 하나라도 있으면 그 상품 대본에 카드를 넘긴다
  terms text[] not null default '{}',
  statement text not null check (char_length(statement) between 1 and 400),
  source_title text not null check (char_length(source_title) between 1 and 200),
  source_url text not null check (source_url ~ '^https?://'),
  source_quote text not null check (char_length(source_quote) between 1 and 500),
  -- 출처 페이지를 받아 인용문이 실제로 있는지 코드가 확인했는지
  source_checked boolean not null default false,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'APPROVED', 'REJECTED')),
  origin text not null default 'AI' check (origin in ('AI', 'HUMAN')),
  -- 처음 만든 계기가 된 상품(참고용)
  product_id uuid references public.products (id) on delete set null,
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, topic, statement)
);

create index knowledge_cards_org_status_idx on public.knowledge_cards (organization_id, status, product_kind);

alter table public.knowledge_cards enable row level security;

create policy "knowledge_cards_select_org" on public.knowledge_cards
  for select to authenticated using (organization_id = public.current_org_id());

create table public.product_differences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  difference text not null check (char_length(difference) between 1 and 200),
  -- 무엇과 비교한 차이인지. 타사 이름은 쓰지 않는다
  compare_to text not null check (char_length(compare_to) between 1 and 200),
  evidence text not null check (char_length(evidence) between 1 and 400),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'CONFIRMED', 'REJECTED')),
  origin text not null default 'AI' check (origin in ('AI', 'HUMAN')),
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, product_id, difference)
);

create index product_differences_product_idx on public.product_differences (organization_id, product_id, status);

alter table public.product_differences enable row level security;

create policy "product_differences_select_org" on public.product_differences
  for select to authenticated using (organization_id = public.current_org_id());

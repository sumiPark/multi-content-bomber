-- =====================================================================
-- 0026 — 표현 규칙 · 건기식 심의 문구 (콘텐츠 자동화 2단계)
--
--   content_rules         금지 표현 · 꼭 넣을 문구. 종류(화장품 · 건기식 · 과일 · 의류) 또는 전체에 적용.
--                         점검 에이전트(4)가 B 트랙 영상 · 캡션을 이 목록으로 검사한다.
--                         ⚠️ 잠긴 항목 — 에이전트 피드백(자동 승인 포함)으로는 바뀌지 않고 사람만 고친다.
--   product_claim_approvals  건기식 기능성(심의) 문구 확정. 상세페이지 분석이 뽑은 후보
--                         (product_analyses.functional_claims) 중 사람이 확정한 것만 콘텐츠에 쓴다.
--                         확정 문구가 없는 건기식은 B 트랙 추천에서 뺀다(3단계 상품 선정).
--
-- 쓰기는 서버 액션이 service_role로 한다. authenticated는 SELECT만.
-- 적용: `supabase db push`. ⚠️ 앱 배포 전에 먼저 적용할 것. types/database.ts에는 수동으로 추가.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. content_rules
-- ---------------------------------------------------------------------
create table if not exists public.content_rules (
  id          uuid primary key default gen_random_uuid(),
  -- ALL = 모든 상품, 그 밖엔 products.kind 값
  scope       text not null default 'ALL'
    check (scope in ('ALL', 'FRUIT', 'COSMETIC', 'HEALTH_FOOD', 'CLOTHING')),
  -- BANNED = 쓰면 안 되는 표현(걸리면 B 트랙 발행을 멈춤)
  -- REQUIRED = 꼭 들어가야 하는 문구(예: 개인차 고지) — 빠지면 멈춤
  rule_type   text not null default 'BANNED' check (rule_type in ('BANNED', 'REQUIRED')),
  phrase      text not null check (char_length(btrim(phrase)) between 1 and 200),
  -- CONTAINS = 글자 포함(띄어쓰기 무시) / REGEX = 정규식
  match_type  text not null default 'CONTAINS' check (match_type in ('CONTAINS', 'REGEX')),
  reason      text check (char_length(reason) <= 300),
  -- 걸렸을 때 대신 쓸 표현 제안 (선택)
  suggestion  text check (char_length(suggestion) <= 200),
  active      boolean not null default true,
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (scope, rule_type, phrase)
);

drop trigger if exists trg_content_rules_updated_at on public.content_rules;
create trigger trg_content_rules_updated_at before update on public.content_rules
  for each row execute function public.set_updated_at();

-- 기본 규칙 — 화장품 · 건강기능식품 표시 · 광고 기준에서 자주 걸리는 표현.
-- 리유 분석 프로젝트의 MCP 지침(lib/catalog-mcp.ts)과 같은 기준. 화면에서 끄거나 고칠 수 있다.
insert into public.content_rules (scope, rule_type, phrase, match_type, reason, suggestion) values
  ('ALL', 'BANNED', '최고', 'CONTAINS', '최상급 표현 — 객관적 근거 없이 쓸 수 없음', null),
  ('ALL', 'BANNED', '유일', 'CONTAINS', '최상급 · 절대 표현', null),
  ('ALL', 'BANNED', '100%', 'CONTAINS', '절대 표현 — 원료 함량 표기(예: 국산 100%)는 상세페이지 원문 그대로일 때만', null),
  ('ALL', 'BANNED', '부작용 없', 'CONTAINS', '안전성 단정 표현', null),
  ('ALL', 'BANNED', '무조건', 'CONTAINS', '효과 보장 표현', null),
  ('COSMETIC', 'BANNED', '치료', 'CONTAINS', '의약품 오인 표현 (화장품법)', '케어'),
  ('COSMETIC', 'BANNED', '완치', 'CONTAINS', '의약품 오인 표현', null),
  ('COSMETIC', 'BANNED', '염증', 'CONTAINS', '질병 관련 표현 — 염증 개선 등', null),
  ('COSMETIC', 'BANNED', '재생', 'CONTAINS', '의약품 오인 표현 — 피부 재생 등', null),
  ('COSMETIC', 'BANNED', '여드름 치료', 'CONTAINS', '의약품 오인 표현', null),
  ('COSMETIC', 'BANNED', '아토피', 'CONTAINS', '질병명 — 개선 · 완화 주장 금지', null),
  ('COSMETIC', 'BANNED', '(미백|주름\s*개선|자외선\s*차단)', 'REGEX', '기능성 화장품 심사 · 보고 표기가 있는 상품만 — 3단계 점검이 상품 분석의 기능성 표기와 대조', null),
  ('COSMETIC', 'REQUIRED', '개인차', 'CONTAINS', '사용감 · 효과에 개인차가 있음을 밝힘', null),
  ('HEALTH_FOOD', 'BANNED', '치료', 'CONTAINS', '질병 치료 표현 (건강기능식품 표시 · 광고)', null),
  ('HEALTH_FOOD', 'BANNED', '예방', 'CONTAINS', '질병 예방 표현 — 확정된 심의 문구 안의 표현은 점검에서 예외', null),
  ('HEALTH_FOOD', 'BANNED', '완치', 'CONTAINS', '질병 치료 표현', null),
  ('HEALTH_FOOD', 'BANNED', '약효', 'CONTAINS', '의약품 오인 표현', null),
  ('HEALTH_FOOD', 'BANNED', '(당뇨|고혈압|암|비만)\s*(에\s*)?(좋|효과|개선)', 'REGEX', '질병 개선 표현', null),
  ('HEALTH_FOOD', 'REQUIRED', '건강기능식품', 'CONTAINS', '건강기능식품은 그 표시를 넣음 (일반 식품은 넣지 않음 — 3단계 점검이 상품별로 판단)', null),
  ('FRUIT', 'BANNED', '당도 보장', 'CONTAINS', '자연물이라 당도를 보장할 수 없음 — 상세페이지 표기(예: 13brix 이상 선별) 그대로만', null)
on conflict (scope, rule_type, phrase) do nothing;

-- ---------------------------------------------------------------------
-- 2. product_claim_approvals — 건기식 심의 문구 확정
-- ---------------------------------------------------------------------
create table if not exists public.product_claim_approvals (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.products (id) on delete cascade,
  claim       text not null check (char_length(btrim(claim)) between 1 and 500),
  -- ANALYSIS = 분석 후보에서 확정 / MANUAL = 사람이 직접 입력(심의필 문구 등)
  source      text not null default 'ANALYSIS' check (source in ('ANALYSIS', 'MANUAL')),
  approved_by uuid references public.profiles (id) on delete set null,
  approved_at timestamptz not null default now(),
  unique (product_id, claim)
);

create index if not exists product_claim_approvals_product_idx
  on public.product_claim_approvals (product_id);

-- ---------------------------------------------------------------------
-- 3. RLS — 로그인한 사용자는 SELECT만. 쓰기 정책 없음(service_role 전용).
-- ---------------------------------------------------------------------
alter table public.content_rules           enable row level security;
alter table public.product_claim_approvals enable row level security;

drop policy if exists "content_rules_select_auth" on public.content_rules;
create policy "content_rules_select_auth" on public.content_rules
  for select to authenticated using (public.current_org_id() is not null);

drop policy if exists "product_claim_approvals_select_auth" on public.product_claim_approvals;
create policy "product_claim_approvals_select_auth" on public.product_claim_approvals
  for select to authenticated using (public.current_org_id() is not null);

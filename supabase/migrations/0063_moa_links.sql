-- =====================================================================
-- 0063 — 모아링크: 계정별 링크 모음 페이지 (moa.cuma.co.kr/계정, 2026-11-27)
--
-- 인포크링크 유료 결제를 대신하는 자체 페이지. 계정마다 페이지 하나, 그 안에 블록(상품 · 링크 ·
-- 배너 · 제목 · SNS · "최근 소개한 상품" 구역)을 쌓아 꾸민다. 기획: local/docs/moalink-plan.html
--
--   moa_pages              페이지 한 개 = 한 행 (주소 · 프로필 · 디자인 · 공개 상태 · 품절 숨기기)
--   moa_slug_redirects     주소를 바꾸면 옛 주소 → 새 페이지로 연결
--   moa_blocks             블록 (지운 블록도 통계 보존을 위해 deleted_at으로만 표시)
--   moa_product_status     페이지에 올라간 몰 상품의 지금 판매 상태 · 가격 (3분마다 점검)
--   moa_events             방문 · 노출 · 클릭 원본 기록 (90일 보관)
--   moa_daily_page_stats   일별 페이지 합계 (계속 누적)
--   moa_daily_block_stats  일별 블록 합계 (계속 누적)
--
-- 화면 표시 = 관리자가 켰는지(enabled) + 공개 기간(starts_at~ends_at) + 판매 상태(moa_product_status).
-- 세 값을 따로 둬서 재입고 때 "품절 때문에 회색이 된 카드"만 돌아오고 사람이 끈 카드는 그대로 둔다.
--
-- 쓰기는 서버 액션 · API가 service_role로 한다(권한은 앱에서 확인). authenticated는 같은 조직 SELECT만.
-- 공개 페이지도 서버에서 service_role로 읽는다(익명 정책 없음).
--
-- 적용: npx supabase db push. 앱 배포 전에 적용해도 된다 — cron 주소가 배포 전까지 404일 뿐 무해.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. moa_pages
-- ---------------------------------------------------------------------
create table if not exists public.moa_pages (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  -- 연결 계정. 계정 연결을 해제해도 페이지는 남긴다(자동 등록만 멈춤).
  social_account_id uuid references public.social_accounts (id) on delete set null,
  -- moa.cuma.co.kr/<slug>. 소문자 · 숫자 · 점 · 밑줄 · 하이픈, 2~40자. 예약어는 앱에서 막는다.
  slug              text not null unique
    check (slug ~ '^[a-z0-9][a-z0-9._-]{0,38}[a-z0-9]$'),
  title             text not null default '',
  bio               text not null default '',
  avatar_url        text,
  -- 꾸미기 값 (배경 · 대표 색 · 버튼 모양 · 카드 모양 · 글꼴). 형식은 lib/moa/theme.ts
  theme             jsonb not null default '{}'::jsonb,
  -- DRAFT(처음 · 비공개) → PUBLISHED(공개) ↔ PAUSED(일시 중지)
  status            text not null default 'DRAFT' check (status in ('DRAFT', 'PUBLISHED', 'PAUSED')),
  -- 품절 상품 표시: false = 회색 + "품절"(기본, 2026-11-27 사용자 결정), true = 숨김
  hide_sold_out     boolean not null default false,
  -- "최근 소개한 상품" 구역에 자동으로 쌓이는 카드 수 상한. 넘으면 오래된 것부터 내린다(고정 제외).
  auto_limit        int not null default 20 check (auto_limit between 1 and 100),
  published_at      timestamptz,
  created_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists moa_pages_account_uniq
  on public.moa_pages (social_account_id) where social_account_id is not null;
create index if not exists moa_pages_org_idx on public.moa_pages (organization_id);

drop trigger if exists trg_moa_pages_updated_at on public.moa_pages;
create trigger trg_moa_pages_updated_at before update on public.moa_pages
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 2. moa_slug_redirects — 옛 주소 연결
-- ---------------------------------------------------------------------
create table if not exists public.moa_slug_redirects (
  old_slug   text primary key,
  page_id    uuid not null references public.moa_pages (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists moa_slug_redirects_page_idx on public.moa_slug_redirects (page_id);

-- ---------------------------------------------------------------------
-- 3. moa_blocks
-- ---------------------------------------------------------------------
create table if not exists public.moa_blocks (
  id               uuid primary key default gen_random_uuid(),
  page_id          uuid not null references public.moa_pages (id) on delete cascade,
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  -- PRODUCT 상품 카드 · LINK 일반 링크 · BANNER 이미지 배너 · HEADING 제목 · 설명
  -- SOCIAL 문의 · SNS 버튼 줄 · AUTO_SECTION "최근 소개한 상품" 구역(페이지당 하나)
  kind             text not null
    check (kind in ('PRODUCT', 'LINK', 'BANNER', 'HEADING', 'SOCIAL', 'AUTO_SECTION')),
  -- 페이지 안 순서(작을수록 위). 자동 구역 안의 카드는 surfaced_at 최신순.
  position         int not null default 0,
  -- true면 "최근 소개한 상품" 구역 안의 카드(콘텐츠 연동으로 자동 등록되거나 그 구역에 직접 넣은 것)
  in_auto_section  boolean not null default false,
  -- 자동 구역에서 맨 위 고정 · 개수 상한으로 내리지 않음
  pinned           boolean not null default false,
  -- 관리자가 켜고 끈 값. 판매 상태와 따로 둔다.
  enabled          boolean not null default true,
  starts_at        timestamptz,
  ends_at          timestamptz,
  title            text not null default '',
  subtitle         text not null default '',
  url              text,
  image_url        text,
  -- 상품 카드 · 상품과 연결한 배너: 몰 상품. 광고 전용 상품(카탈로그에 없음)도 올릴 수 있게 products FK 대신 몰 번호로 둔다.
  shop_code        text references public.shops (code),
  shop_product_id  bigint,
  -- 블록 종류별 추가 값 (SOCIAL 버튼 목록, 버튼 문구 등). 형식은 lib/moa/types.ts
  data             jsonb not null default '{}'::jsonb,
  -- MANUAL 직접 추가 · CONTENT 콘텐츠 연동으로 자동 등록
  source           text not null default 'MANUAL' check (source in ('MANUAL', 'CONTENT')),
  -- 자동 구역 정렬 기준(같은 상품을 다시 소개하면 갱신돼 맨 위로)
  surfaced_at      timestamptz not null default now(),
  deleted_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (kind <> 'PRODUCT' or (shop_code is not null and shop_product_id is not null)),
  check ((shop_code is null) = (shop_product_id is null)),
  check (starts_at is null or ends_at is null or starts_at < ends_at)
);

create index if not exists moa_blocks_page_idx
  on public.moa_blocks (page_id, position) where deleted_at is null;
create index if not exists moa_blocks_product_idx
  on public.moa_blocks (shop_code, shop_product_id) where deleted_at is null and shop_code is not null;
-- "최근 소개한 상품" 구역은 페이지당 하나
create unique index if not exists moa_blocks_auto_section_uniq
  on public.moa_blocks (page_id) where kind = 'AUTO_SECTION' and deleted_at is null;
-- 자동 구역의 같은 상품 카드는 페이지당 하나
create unique index if not exists moa_blocks_auto_product_uniq
  on public.moa_blocks (page_id, shop_code, shop_product_id)
  where in_auto_section and deleted_at is null and shop_code is not null;

drop trigger if exists trg_moa_blocks_updated_at on public.moa_blocks;
create trigger trg_moa_blocks_updated_at before update on public.moa_blocks
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 4. moa_product_status — 페이지에 올라간 상품의 지금 상태 (몰 공개 API, 광고 랜딩 기준)
--    목록에 안 보이는 광고 전용 상품도 링크로 살 수 있으면 on_sale이다(lib/products/shop-api.ts landingStatusOf).
-- ---------------------------------------------------------------------
create table if not exists public.moa_product_status (
  shop_code       text not null references public.shops (code),
  shop_product_id bigint not null,
  name            text,
  price           int,
  image_url       text,
  -- on_sale · sold_out · suspended · deleted · not_open · sale_ended · restricted · unknown
  -- null = 아직 한 번도 조회 못 함(표시는 판매 중처럼)
  landing_status  text check (landing_status in
    ('on_sale', 'sold_out', 'suspended', 'deleted', 'not_open', 'sale_ended', 'restricted', 'unknown')),
  app_only        boolean not null default false,
  checked_at      timestamptz,          -- 마지막으로 조회를 시도한 시각
  last_ok_at      timestamptz,          -- 마지막으로 조회에 성공한 시각
  fail_count      int not null default 0,  -- 연속 실패 횟수. 실패해도 마지막 상태는 유지한다(품절로 단정하지 않음)
  last_error      text,
  status_changed_at timestamptz,
  updated_at      timestamptz not null default now(),
  primary key (shop_code, shop_product_id)
);
create index if not exists moa_product_status_checked_idx on public.moa_product_status (checked_at nulls first);

drop trigger if exists trg_moa_product_status_updated_at on public.moa_product_status;
create trigger trg_moa_product_status_updated_at before update on public.moa_product_status
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 5. moa_events — 원본 기록 (90일 보관, 2026-11-27 사용자 결정)
--    session_id: 브라우저 탭 하나의 방문 표시(sessionStorage 난수). 쿠키 · 개인정보 없음.
--    visitor_hash: IP · 브라우저 정보를 하루 단위로 바뀌는 값과 함께 해시한 것(원래 값 복원 불가).
-- ---------------------------------------------------------------------
create table if not exists public.moa_events (
  id           bigint generated always as identity primary key,
  page_id      uuid not null references public.moa_pages (id) on delete cascade,
  block_id     uuid references public.moa_blocks (id) on delete cascade,
  kind         text not null check (kind in ('VIEW', 'IMPRESSION', 'CLICK')),
  session_id   text,
  visitor_hash text,
  -- instagram · threads · facebook · kakao · youtube · naver · direct · other
  source       text not null default 'other',
  -- 캠페인 전용 링크(?c=) 값. 없으면 ''
  campaign     text not null default '',
  created_at   timestamptz not null default now()
);
create index if not exists moa_events_page_time_idx on public.moa_events (page_id, created_at);
create index if not exists moa_events_time_idx on public.moa_events (created_at);
-- 같은 방문에서 같은 블록 노출은 한 번만 기록 (페이지를 위아래로 움직여도 중복 안 됨)
create unique index if not exists moa_events_impression_uniq
  on public.moa_events (block_id, session_id) where kind = 'IMPRESSION' and session_id is not null;

-- ---------------------------------------------------------------------
-- 6. 일별 합계 (한국 날짜 기준, 계속 누적)
-- ---------------------------------------------------------------------
create table if not exists public.moa_daily_page_stats (
  day          date not null,
  page_id      uuid not null references public.moa_pages (id) on delete cascade,
  source       text not null,
  views        int not null default 0,  -- 페이지가 열린 횟수
  visits       int not null default 0,  -- 방문(탭 하나) 수
  visitors     int not null default 0,  -- 그날 방문자 수(추정)
  clicks       int not null default 0,  -- 총 클릭
  click_visits int not null default 0,  -- 하나 이상 누른 방문 수
  primary key (day, page_id, source)
);

create table if not exists public.moa_daily_block_stats (
  day               date not null,
  page_id           uuid not null references public.moa_pages (id) on delete cascade,
  block_id          uuid not null references public.moa_blocks (id) on delete cascade,
  impressions       int not null default 0,  -- 화면에 보인 방문 수 (방문당 한 번)
  clicks            int not null default 0,  -- 총 클릭
  click_visits      int not null default 0,  -- 누른 방문 수
  primary key (day, block_id)
);
create index if not exists moa_daily_block_stats_page_idx on public.moa_daily_block_stats (page_id, day);

-- 하루치 원본 → 합계 다시 계산 (같은 날을 몇 번 불러도 결과가 같다)
create or replace function public.moa_rollup_day(p_day date)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_from timestamptz := (p_day::timestamp at time zone 'Asia/Seoul');
  v_to   timestamptz := ((p_day + 1)::timestamp at time zone 'Asia/Seoul');
begin
  delete from public.moa_daily_page_stats where day = p_day;
  insert into public.moa_daily_page_stats (day, page_id, source, views, visits, visitors, clicks, click_visits)
  select p_day, e.page_id, e.source,
         count(*) filter (where e.kind = 'VIEW'),
         count(distinct coalesce(e.session_id, 'v:' || e.visitor_hash)) filter (where e.kind = 'VIEW'),
         count(distinct e.visitor_hash) filter (where e.kind = 'VIEW'),
         count(*) filter (where e.kind = 'CLICK'),
         count(distinct coalesce(e.session_id, 'v:' || e.visitor_hash)) filter (where e.kind = 'CLICK')
    from public.moa_events e
   where e.created_at >= v_from and e.created_at < v_to
   group by e.page_id, e.source;

  delete from public.moa_daily_block_stats where day = p_day;
  insert into public.moa_daily_block_stats (day, page_id, block_id, impressions, clicks, click_visits)
  select p_day, e.page_id, e.block_id,
         count(distinct coalesce(e.session_id, 'v:' || e.visitor_hash)) filter (where e.kind = 'IMPRESSION'),
         count(*) filter (where e.kind = 'CLICK'),
         count(distinct coalesce(e.session_id, 'v:' || e.visitor_hash)) filter (where e.kind = 'CLICK')
    from public.moa_events e
   where e.created_at >= v_from and e.created_at < v_to
     and e.block_id is not null
   group by e.page_id, e.block_id;
end;
$$;

-- 기록 넣기 — 같은 방문의 같은 블록 노출 중복은 조용히 버린다(부분 유니크 인덱스라 PostgREST upsert로는 못 함)
create or replace function public.moa_record_events(p_rows jsonb)
returns int
language plpgsql
set search_path = public
as $$
declare
  v_count int;
begin
  insert into public.moa_events (page_id, block_id, kind, session_id, visitor_hash, source, campaign)
  select (r->>'page_id')::uuid,
         nullif(r->>'block_id', '')::uuid,
         r->>'kind',
         nullif(r->>'session_id', ''),
         nullif(r->>'visitor_hash', ''),
         coalesce(nullif(r->>'source', ''), 'other'),
         coalesce(r->>'campaign', '')
    from jsonb_array_elements(p_rows) r
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.moa_record_events(jsonb) from public, anon, authenticated;
grant execute on function public.moa_record_events(jsonb) to service_role;

revoke all on function public.moa_rollup_day(date) from public, anon, authenticated;
grant execute on function public.moa_rollup_day(date) to service_role;

-- ---------------------------------------------------------------------
-- 7. RLS — 같은 조직 SELECT만. 쓰기 정책 없음(service_role 전용).
-- ---------------------------------------------------------------------
alter table public.moa_pages              enable row level security;
alter table public.moa_slug_redirects     enable row level security;
alter table public.moa_blocks             enable row level security;
alter table public.moa_product_status     enable row level security;
alter table public.moa_events             enable row level security;
alter table public.moa_daily_page_stats   enable row level security;
alter table public.moa_daily_block_stats  enable row level security;

drop policy if exists "moa_pages_select_org" on public.moa_pages;
create policy "moa_pages_select_org" on public.moa_pages
  for select to authenticated using (organization_id = public.current_org_id());

drop policy if exists "moa_slug_redirects_select_org" on public.moa_slug_redirects;
create policy "moa_slug_redirects_select_org" on public.moa_slug_redirects
  for select to authenticated using (
    exists (select 1 from public.moa_pages p where p.id = page_id and p.organization_id = public.current_org_id())
  );

drop policy if exists "moa_blocks_select_org" on public.moa_blocks;
create policy "moa_blocks_select_org" on public.moa_blocks
  for select to authenticated using (organization_id = public.current_org_id());

-- 몰 상품 상태는 상품 카탈로그처럼 조직 구분 없이 공유(0025와 같음)
drop policy if exists "moa_product_status_select" on public.moa_product_status;
create policy "moa_product_status_select" on public.moa_product_status
  for select to authenticated using (true);

drop policy if exists "moa_daily_page_stats_select_org" on public.moa_daily_page_stats;
create policy "moa_daily_page_stats_select_org" on public.moa_daily_page_stats
  for select to authenticated using (
    exists (select 1 from public.moa_pages p where p.id = page_id and p.organization_id = public.current_org_id())
  );

drop policy if exists "moa_daily_block_stats_select_org" on public.moa_daily_block_stats;
create policy "moa_daily_block_stats_select_org" on public.moa_daily_block_stats
  for select to authenticated using (
    exists (select 1 from public.moa_pages p where p.id = page_id and p.organization_id = public.current_org_id())
  );
-- moa_events: 정책 없음 (원본 기록은 화면에서 직접 읽지 않는다)

-- ---------------------------------------------------------------------
-- 8. Storage — 프로필 사진 · 배너 이미지 (공개 버킷, 페이지 방문자가 바로 본다)
--    경로: {organization_id}/{uuid}.{ext}
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('moa', 'moa', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

drop policy if exists "moa_insert_org" on storage.objects;
create policy "moa_insert_org" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'moa'
    and (storage.foldername(name))[1] = public.current_org_id()::text
    and public.current_role() in ('ADMIN', 'MANAGER')
  );

drop policy if exists "moa_delete_org" on storage.objects;
create policy "moa_delete_org" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'moa'
    and (storage.foldername(name))[1] = public.current_org_id()::text
    and public.current_role() in ('ADMIN', 'MANAGER')
  );

-- ---------------------------------------------------------------------
-- 9. pg_cron
--    moa-stock   3분마다: 페이지에 올라간 상품이 있을 때만 앱이 몰에 판매 상태를 조회(0022와 같은 인증)
--    moa-rollup  15분마다: 오늘 · 어제 합계 다시 계산
--    moa-purge   매일 04:20 KST: 90일 지난 원본 기록 삭제
-- ---------------------------------------------------------------------
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname in ('moa-stock', 'moa-rollup', 'moa-purge');
end $$;

select cron.schedule(
  'moa-stock',
  '*/3 * * * *',
  $cron$
  select net.http_post(
    url := 'https://mcb.cuma.co.kr/api/cron/moa-stock',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret
          from vault.decrypted_secrets
         where name = 'episode_replies_cron_secret'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  )
  where exists (
    select 1
      from public.moa_blocks b
     where b.deleted_at is null
       and b.shop_code is not null
  );
  $cron$
);

select cron.schedule(
  'moa-rollup',
  '*/15 * * * *',
  $cron$
  select public.moa_rollup_day((now() at time zone 'Asia/Seoul')::date);
  select public.moa_rollup_day((now() at time zone 'Asia/Seoul')::date - 1);
  $cron$
);

select cron.schedule(
  'moa-purge',
  '20 19 * * *',
  $cron$
  delete from public.moa_events where created_at < now() - interval '90 days';
  $cron$
);

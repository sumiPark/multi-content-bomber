-- =====================================================================
-- 0008 — Internal title on contents (관리자용 식별 라벨).
-- See docs/functional-specification.md §4.2 "내부 타이틀".
-- =====================================================================

alter table public.contents
  add column if not exists internal_title text;

-- 검색 가속용 trigram-style index는 보관함/포스팅 관리에서
-- ilike 검색을 자주 하면 추후 추가. 현재는 기본 b-tree만.
create index if not exists contents_internal_title_idx
  on public.contents (organization_id, internal_title)
  where internal_title is not null;

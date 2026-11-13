-- 0057 상품 분석을 필요할 때만 한다 — "분석 전(pending)" 상태 (사용자 결정, 2026-11-13)
--
-- 예전엔 수집에서 새 상품 · 상세페이지가 바뀐 상품을 모두 queued로 두고 분석기가 바로 읽었다.
-- 2026-11-10 오늘과일 전체 카테고리 수집(0053)으로 새 상품 2천여 개가 한꺼번에 분석돼 비용이 크게 났다.
-- 이제 수집은 pending(분석 전)으로만 두고, 실제로 쓰려고 고를 때 분석한다:
--   · AI 상품 고르기(상품 선정 · 직접 촬영 기획) — 후보로 보고, 고른 상품을 그 자리에서 분석
--   · 사람이 직접 고르기 — 분석을 시작(queued)하고 몇 분 뒤 다시 고르게 한다
-- queued는 "분석해 달라고 요청됨"(다시 분석 · 직접 고르기)만 뜻한다. 분석기 선점 함수는 그대로 queued만 집는다.

alter table public.products drop constraint if exists products_analysis_state_check;
alter table public.products
  add constraint products_analysis_state_check
  check (analysis_state in ('pending', 'queued', 'analyzing', 'ready', 'review', 'insufficient', 'failed', 'skipped'));

alter table public.products alter column analysis_state set default 'pending';

-- 지금 분석 대기인 상품(대부분 일시 품절)은 분석 전으로 돌린다. 이미 분석한 상품은 그대로.
update public.products
   set analysis_state = 'pending',
       analysis_attempts = 0,
       analysis_error = null,
       analysis_locked_until = null
 where analysis_state = 'queued';

-- =====================================================================
-- 0039 — 계정 컨셉: 후킹 문구 · 마지막 문구 · 말투
--
-- 계정 × 방식(auto = AI 자동 업로드, shoot = 직접 촬영 + AI 편집)마다 저장한다.
--   *_hooks / *_endings  문구 목록. {상품}처럼 중괄호 안은 칸마다 AI가 채우고 나머지 글자는 고정이다.
--                        첫 문장 · 마지막 문장의 말과 화면 문구에 똑같이 들어간다(lib/agents/fixed-phrases.ts).
--   *_tone               말투 · 분위기 (글)
-- auto_concept · shoot_concept는 자유 메모로 그대로 쓴다.
--
-- 기존 테이블에 열만 더한다. 비어 있으면 AI가 예전처럼 훅을 쓴다.
-- 앱 코드가 조회하므로 배포 전에 먼저 적용할 것. types/database.ts에는 수동으로 추가해 뒀다.
-- =====================================================================

alter table public.account_concepts
  add column if not exists auto_hooks    text[] not null default '{}',
  add column if not exists auto_endings  text[] not null default '{}',
  add column if not exists auto_tone     text   not null default '' check (char_length(auto_tone) <= 1000),
  add column if not exists shoot_hooks   text[] not null default '{}',
  add column if not exists shoot_endings text[] not null default '{}',
  add column if not exists shoot_tone    text   not null default '' check (char_length(shoot_tone) <= 1000);

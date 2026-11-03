-- =====================================================================
-- 0031 — 편성표: 칸마다 주제 (콘텐츠 자동화 5단계)
--
-- slot_rules.topic  사람이 편성표에서 정하는 칸 주제(예: "성분 비교", "제철 정보"). 비어 있으면 주제 없음.
--                   상품 선정(AI 자동 업로드)과 촬영 기획안 후보 에이전트가 이 칸을 기획할 때 참고한다.
--
-- 쓰기는 서버 액션이 service_role로(ADMIN · MANAGER 확인 뒤). authenticated는 같은 조직 SELECT만(0028 그대로).
-- 적용: `supabase db push`. ⚠️ 앱 배포 전에 먼저. types/database.ts에는 수동으로 추가.
-- =====================================================================

alter table public.slot_rules
  add column if not exists topic text check (topic is null or char_length(topic) between 1 and 60);

alter table public.slot_rules
  add column if not exists updated_at timestamptz not null default now();

drop trigger if exists trg_slot_rules_updated_at on public.slot_rules;
create trigger trg_slot_rules_updated_at before update on public.slot_rules
  for each row execute function public.set_updated_at();

comment on column public.slot_rules.topic is
  '편성표 칸 주제 — 사람이 정한다. AI가 이 칸의 상품 · 기획을 고를 때 참고(없으면 계정 역할만 본다).';

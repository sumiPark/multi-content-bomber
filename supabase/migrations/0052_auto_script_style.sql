-- 0052_auto_script_style.sql — AI 자동 콘텐츠 설정을 "대본 방식 + 바꾸고 싶은 점"으로 줄인다 (2026-11-09 사용자 결정)
--
-- 사용자 결정:
--   1. 후킹 문구 · 마지막 문구는 글자가 그대로 나가야 해서 따로 둔다(auto_hooks · auto_endings 그대로).
--   2. 대본 방식을 계정마다 고른다. 기본은 상식 · 상품 연결형(KNOWLEDGE)이라 바꾼 직후에도 결과물은 같다.
--      이야기형(STORY)은 "저희" 화자가 문제 → 시도 → 그래서 저희는 → 그렇게 나온 게 ○○ 순서로 말한다.
--   3. 말투 · 분위기, 영상 생성 스타일, 컨셉 · 자유 메모는 "바꾸고 싶은 점" 한 칸으로 합친다. 지금 적힌 글은 이 칸으로 옮긴다.
--   범위는 AI 자동 콘텐츠 설정만. 직접 촬영 설정(shoot_*)은 그대로다.
--
-- 옛 칸(auto_concept · auto_tone · auto_video_style)은 지우지 않는다. 아직 main에서 돌아가는 코드가 읽는다.
-- 새 코드가 main에 합쳐지면 옛 칸은 읽지 않으니, 그 뒤에 따로 지운다.

alter table public.account_concepts
  add column if not exists auto_script_style text not null default 'KNOWLEDGE'
    check (auto_script_style in ('KNOWLEDGE', 'STORY')),
  add column if not exists auto_notes text not null default '';

-- 지금 적힌 글을 한 칸으로 옮긴다. 어느 칸에서 왔는지 앞에 붙여 둔다
update public.account_concepts
   set auto_notes = concat_ws(
         E'\n',
         nullif(btrim(auto_concept), ''),
         case when btrim(auto_tone) <> '' then '말투 · 분위기: ' || btrim(auto_tone) end,
         case when btrim(auto_video_style) <> '' then '영상 스타일: ' || btrim(auto_video_style) end
       )
 where auto_notes = '';

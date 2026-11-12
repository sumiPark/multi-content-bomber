import { z } from "zod";

// 편집 계획의 그래픽 틀 · 효과음 이름. 편집 계획(edit-plan) · 완성본 고치기(edit-revise) · 장면표(storyboard)가 같은 값을 쓴다.
// 완성본 받기의 서버 액션(앱)에서도 불러 쓰므로, 이 파일은 스킬 폴더를 읽거나 스크립트를 실행하는 모듈(ko-skills)을 불러오지 않는다.

const graphicTypes = ["badge", "title", "chip", "notice", "stat", "split", "steps", "ring", "arrow", "end_card"] as const;
export const sfxNames = ["pop", "click", "rustle", "whoosh", "plug", "tick", "ding"] as const;

export const graphicSchema = z.object({
  type: z.enum(graphicTypes),
  at_word: z.string().describe("이 낱말을 말할 때 나온다. 없으면 빈 문자열"),
  at: z.number().describe("at_word가 없을 때 비트 안의 위치 0~1"),
  text: z.string(),
  small: z.string(),
  sub: z.string(),
  note: z.string(),
  chip: z.string(),
  tone: z.string(),
  side: z.string(),
  number: z.string(),
  unit: z.string(),
  left: z.string(),
  right: z.string(),
  left_value: z.number(),
  right_value: z.number(),
  items: z.array(z.string()),
  x: z.number(),
  y: z.number(),
  r: z.number(),
  from: z.string(),
});

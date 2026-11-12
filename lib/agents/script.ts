import { z } from "zod";
import { conceptBlock } from "@/lib/agents/concept";
import { checkCaption, checkTone, hookFormulas, scoreHooks, timeScript } from "@/lib/agents/ko-skills";
import type { ProductFacts } from "@/lib/agents/product-facts";
import { runAgent, type AgentResult, type AgentSkill } from "@/lib/agents/runner";
import { breakCaptionLines, CAPTION_LINE_RULE } from "@/lib/ai/caption-layout";
import { checkText, type ContentRule } from "@/lib/rules/check";
import type { createServiceClient } from "@/lib/supabase/service";

// 기획 · 글 에이전트(2) — AI 자동 업로드 칸의 릴스 대본 · 화면 문구 · 캡션을 쓴다.
// 규칙의 출처: 한국어 인스타 스킬 ig-reel-ko · ig-caption-ko · ig-human-ko(.claude/skills) + 광고 문구 규칙(0026).
// 에이전트는 훅 3개를 쓰고 hookscore_ko로 채점해 고른 뒤, 대본을 beats_ko로 재고, 말투 · 캡션 · 규칙을
// 스스로 점검하고 답한다. 최종 판정은 점검 에이전트(4)가 따로 한다(같은 에이전트가 자기 글을 통과시키지 않게).

type Service = ReturnType<typeof createServiceClient>;

export const scriptSchema = z.object({
  hooks: z
    .array(
      z.object({
        formula_id: z.number().int().describe("hooks_ko 공식 id"),
        spoken: z.string().describe("말하는 첫 문장(내레이션)"),
        on_screen: z.string().describe("첫 화면 문구, 12자 안팎"),
      }),
    )
    .describe("서로 다른 공식으로 정확히 3개"),
  chosen_hook: z.number().int().describe("고른 훅 번호 (0~2)"),
  beats: z
    .array(
      z.object({
        spoken: z.string().describe("이 비트의 내레이션 한 문장 (첫 비트 = 고른 훅)"),
        on_screen: z.string().describe("이 비트 화면 문구, 12자 안팎. 없으면 빈 문자열"),
        visual: z.string().describe("이 비트에 보일 장면 — 상품의 어떤 모습/부분을 보여 줄지"),
      }),
    )
    .describe("비트 5~9개, 한 비트 4초 이내"),
  loop_word: z.string().describe("마지막 비트가 되받는 훅의 낱말"),
  caption: z.object({
    text: z.string().describe("캡션 전체 — 첫 줄(40자 이내) · 본문 · 요청 하나 · 해시태그 3개. 한 줄에 한 문장, 문단 사이 빈 줄"),
    keywords: z.array(z.string()).describe("찾히고 싶은 검색어 2~4개"),
  }),
});
export type ScriptOutput = z.infer<typeof scriptSchema>;

export interface ScriptContext {
  service: Service;
  planId: string;
  accountName: string;
  slotTime: string;
  facts: ProductFacts;
  rules: ContentRule[];
  // 계정 설정의 "바꾸고 싶은 점"(0052) — 예전의 컨셉 · 말투 · 영상 스타일을 합친 한 칸
  notes?: string | null;
  // 사람이 고정한 첫 · 마지막 문구 안내 (fixed-phrases.ts)
  phraseBlock?: string;
  // 점검에서 걸려 다시 쓰는 경우의 지적 사항
  fixRequests?: string[];
}

// 촬영 컷 리스트(shotlist.ts)도 같은 스킬을 쓴다.
export function writerSkills(ctx: Pick<ScriptContext, "facts" | "rules" | "accountName">): AgentSkill[] {
  return [
    {
      name: "get_product_facts",
      description: "상품 사실 — 원문 근거가 확인된 특징, 사용법 · 주의, 세부 항목, 확정 심의 문구, 불확실한 점. 대본의 사실은 여기 있는 것만.",
      input: z.object({}),
      async run() {
        const { sourceText: _src, rawName: _listing, ...rest } = ctx.facts;
        void _src;
        void _listing;
        return rest;
      },
    },
    {
      name: "list_hook_formulas",
      description: "한국어 릴스 훅 공식 26개(템플릿 · 예시 · 화면 문구 · 쓰는 상황 · 망치는 방식)와 훅 규칙",
      input: z.object({}),
      async run() {
        return hookFormulas();
      },
    },
    {
      name: "score_hooks",
      description: "훅 문장들을 한국어 기준으로 채점(길이 · 구체성 · 긴장 · 앞쪽 배치 · 호명). 50점 미만이면 훅이 아니다.",
      input: z.object({ hooks: z.array(z.string()).min(1).max(6) }),
      async run(args) {
        return scoreHooks((args as { hooks: string[] }).hooks);
      },
    },
    {
      name: "time_script",
      description: "대본 비트(한 줄 = 한 비트)의 말하는 시간을 재고 경고(훅 3초 초과, 비트 4초 초과, 구체성 없는 비트 연속, 루프 없음)를 준다",
      input: z.object({ lines: z.array(z.string()).min(2).max(40), target_seconds: z.number().min(10).max(90) }),
      async run(args) {
        const a = args as { lines: string[]; target_seconds: number };
        return timeScript(a.lines, a.target_seconds);
      },
    },
    {
      name: "check_ai_tone",
      description: "한국어 AI 말투 점검(번역투 · 상투어 · 같은 어미 반복 · em dash 등). human_score가 높을수록 사람 같다.",
      input: z.object({ text: z.string() }),
      async run(args) {
        return checkTone((args as { text: string }).text);
      },
    },
    {
      name: "check_caption",
      description: "캡션 점검 — 더 보기 전 첫 줄, 요청 개수, 해시태그 개수, 링크 · 금지어",
      input: z.object({ caption: z.string(), keywords: z.array(z.string()) }),
      async run(args) {
        const a = args as { caption: string; keywords: string[] };
        return checkCaption(a.caption, a.keywords, ctx.accountName);
      },
    },
    {
      name: "check_rules",
      description: "광고 문구 규칙(금지 표현 · 꼭 넣을 문구) 검사. 걸린 게 있으면 고쳐서 다시 검사한다.",
      input: z.object({ text: z.string() }),
      async run(args) {
        return checkText((args as { text: string }).text, ctx.facts.kind, ctx.rules, ctx.facts.approvedClaims, { healthFunctional: ctx.facts.healthFunctional, certifiedFunctions: ctx.facts.certifiedFunctions }).map((h) => ({
          type: h.rule.ruleType === "BANNED" ? "금지 표현" : "빠진 필수 문구",
          phrase: h.matched ?? h.rule.phrase,
          reason: h.rule.reason,
          suggestion: h.rule.suggestion,
        }));
      },
    },
  ];
}

function systemPrompt(ctx: ScriptContext): string {
  const f = ctx.facts;
  // AI 자동은 계정 역할(장면 방향)을 읽지 않는다(2026-11-10). 방향은 바꾸고 싶은 점 · 고정 문구로만 받는다
  // 계정마다 올리는 시각이 달라 시간대를 시각에서 구한다
  const t = ctx.slotTime;
  const slot = t < "05:00" ? "새벽" : t < "11:00" ? "아침" : t < "14:00" ? "점심" : t < "18:00" ? "오후" : t < "22:00" ? "저녁" : "밤";
  return `너는 인스타그램 @${ctx.accountName}의 릴스 대본 작가다. 이 영상은 AI가 상품 이미지로 만들어 사람 확인 없이 ${ctx.slotTime}(${slot})에 자동으로 올라간다.
상품: ${f.shop} ${f.kindLabel} "${f.name}"

순서 (스킬을 실제로 써라):
1. get_product_facts, list_hook_formulas를 읽는다.
2. 서로 다른 공식으로 훅 3개(말 + 화면 문구)를 쓰고 score_hooks로 채점한다. 1등이 50점 미만이면 다시 쓴다.
3. 1등 훅으로 대본을 쓴다: 훅(0~2초) → 왜 중요한지 한 줄 → 본문(비트마다 한 가지, 장면이 바뀜) → 약속 갚기 + 요청 하나 → 마지막 줄은 훅의 낱말을 되받아 다시 보게.
   목표 15~25초. time_script로 재고 경고를 다 없앤다.
4. 캡션을 쓰고 check_caption으로 점검한다. 첫 줄 40자 이내, 요청은 하나, 해시태그 정확히 3개.
   ${CAPTION_LINE_RULE}
5. 내레이션 전체와 캡션을 check_ai_tone, check_rules로 점검한다. check_rules에 걸린 것은 고친다. check_ai_tone은 한 번만 쓰고, 번역투 · 상투어 · 같은 어미 반복만 고친 뒤 점수가 낮아도 넘어간다.

절대 규칙:
- 이 상품에 대한 사실(숫자 · 산지 · 성분 · 효과 · 구성)은 get_product_facts에 있는 것만. 없는 숫자를 만들지 않는다. uncertainties에 있는 건 말하지 않는다.
- 원리 · 원료 일반 · 생활 상식처럼 널리 알려진 내용은 상품 자료에 없어도 쓴다. 학계에서 논란이 있거나 확실하지 않은 내용은 쓰지 않는다.
- 숫자 · 통계 · 의학적 효과는 지어내지 않고 일반 상식으로도 쓰지 않는다. 원료(성분)의 숫자 · 의학적 효과가 get_product_facts에 있으면 내레이션으로 읽지 않고, 화면 문구에만 원료의 특성이라는 뜻이 드러나게 쓴다. 상식 · 원료 설명을 이 제품의 효과처럼 잇지 않는다.
- 사람이 실제로 써 본 적이 없으니 1인칭 체험담 금지: "써 봤는데", "제 피부가", "먹어 보니", "우리 엄마가" 같은 말을 쓰지 않는다. 사람 후기 · 고객 후기를 지어내지 않는다.
- 상품 사실은 직접 설명하는 말투(~예요)로 쓴다. "제품 안내에서는", "상세페이지에 따르면", "~래요"처럼 출처를 밝히며 전하는 말투를 쓰지 않는다. 시청자에게 말 거는 2인칭도 된다.
- 건강기능식품 기능성 표현은 approvedClaims 문장 그대로만. 비어 있으면 기능성 · 건강 효과를 말하지 않는다.${f.kind === "COSMETIC" ? "\n- 화장품: 캡션에 '개인차'가 있음을 밝힌다. 치료 · 재생 · 염증 같은 표현을 쓰지 않는다. 미백 · 주름 개선 · 자외선 차단은 certifiedFunctions에 있는 것만 쓴다." : ""}
- 재고 · 품절 · 할인 · 배송 같은 판매 상태는 말하지 않는다(올라갈 때 바뀔 수 있다). 가격은 상품 사실의 price만.
- 인사 · 자기소개 · "오늘은 ~ 소개해 드릴게요"로 시작하지 않는다. 최고 · 유일 · 100% 같은 단정을 쓰지 않는다.
- 화면 문구는 한 카드 12자 안팎. visual에는 실제 상품 이미지로 보여 줄 수 있는 장면만(병 · 제형 · 포장 · 단면 · 사용 장면).
- 말투는 짧고 자연스러운 구어체. 번역투 · 상투어 · 같은 어미 반복을 피한다.${conceptBlock("이 계정에서 바꾸고 싶은 점", ctx.notes, "훅 · 내용 · 내레이션과 캡션의 말투 · 비트의 visual에 반영한다.")}${ctx.phraseBlock ?? ""}`;
}

export async function writeScript(ctx: ScriptContext, opts: { log: boolean }): Promise<AgentResult<ScriptOutput>> {
  const fix = ctx.fixRequests?.length
    ? `\n\n이전 대본이 점검에서 걸렸다. 이것을 반드시 고쳐서 다시 써라:\n${ctx.fixRequests.map((r) => `- ${r}`).join("\n")}`
    : "";
  const result = await runAgent({
    agent: "plan",
    system: systemPrompt(ctx),
    user: `${ctx.facts.name}로 ${ctx.slotTime} 릴스 대본 · 화면 문구 · 캡션을 써 줘.${fix}`,
    skills: writerSkills(ctx),
    outputSchema: scriptSchema,
    outputName: "reel_script",
    maxSteps: 14,
    service: opts.log ? ctx.service : null,
    readService: ctx.service,
    planId: ctx.planId,
    input: { product: ctx.facts.name, slotTime: ctx.slotTime, fixRequests: ctx.fixRequests ?? [], notes: ctx.notes ?? null },
  });
  result.output.caption.text = breakCaptionLines(result.output.caption.text);
  return result;
}

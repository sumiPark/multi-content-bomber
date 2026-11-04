import { z } from "zod";
import { conceptBlock } from "@/lib/agents/concept";
import { editKit } from "@/lib/agents/ko-skills";
import type { ProductFacts } from "@/lib/agents/product-facts";
import { runAgent, type AgentResult } from "@/lib/agents/runner";
import { writerSkills } from "@/lib/agents/script";
import type { ContentRule } from "@/lib/rules/check";
import type { createServiceClient } from "@/lib/supabase/service";

// 기획 · 글 에이전트(2)의 직접 촬영용 — 고른 기획안(또는 사람이 직접 지정한 상품 · 메모)으로
// 휴대폰 촬영 컷 리스트 · 컷별 화면 문구 · 말할 대사 · 캡션을 쓴다. 스킬은 AI 자동 업로드 대본과 같다.
// 사람이 찍고 마지막에 완성본을 보므로, 1인칭은 "그 컷에서 실제로 보여 주는 것"까지만 허용한다.

type Service = ReturnType<typeof createServiceClient>;

export const shotlistSchema = z.object({
  hooks: z
    .array(
      z.object({
        formula_id: z.number().int().describe("hooks_ko 공식 id"),
        spoken: z.string().describe("훅 문장 — 말하거나 첫 화면에 띄울 문장"),
        on_screen: z.string().describe("첫 화면 문구, 12자 안팎"),
      }),
    )
    .describe("서로 다른 공식으로 정확히 3개"),
  chosen_hook: z.number().int().describe("고른 훅 번호 (0~2)"),
  thumbnail: z.object({
    title: z.string().describe("표지 큰 글자, 8자 안팎. 후킹과 같은 약속을 더 짧게"),
    sub: z.string().describe("표지 작은 글자, 없으면 빈 문자열"),
    shot: z.string().describe("표지로 쓸 장면 — 찍는 사람이 알 수 있게 한 줄"),
  }),
  cuts: z
    .array(
      z.object({
        seconds: z.number().describe("이 컷 길이(초), 1.5~5"),
        shot: z.string().describe("무엇을 찍는지 — 화면에 보이는 것 한 줄"),
        how: z.string().describe("어떻게 찍는지 — 각도 · 거리 · 손 · 배경 · 빛, 찍는 사람이 바로 따라 할 수 있게"),
        on_screen: z.string().describe("이 컷 화면 문구, 12자 안팎. 없으면 빈 문자열"),
        voice: z.string().describe("찍는 사람이 직접 말할 대사. 말하지 않는 계정 · 컷이면 빈 문자열"),
        narration: z.string().describe("말하지 않는 계정의 AI 음성 내레이션 초안. 이 컷에서 보이는 것에 맞는 구어체 한 문장. 사람이 말하는 컷이면 빈 문자열"),
      }),
    )
    .describe("컷 5~8개, 첫 컷 = 고른 훅"),
  loop_word: z.string().describe("마지막 컷이 되받는 훅의 낱말"),
  caption: z.object({
    text: z.string().describe("캡션 전체 — 첫 줄(40자 이내) · 본문 · 요청 하나 · 해시태그 3개"),
    keywords: z.array(z.string()).describe("찾히고 싶은 검색어 2~4개"),
  }),
});
export type ShotlistOutput = z.infer<typeof shotlistSchema>;

export interface ShotlistContext {
  service: Service;
  planId: string;
  accountName: string;
  roleFocus: string | null;
  // 찍을 때 말한 소리를 쓰는지(0044). 기본은 AI 음성이라 사람이 나오는 계정도 말하지 않는다
  liveVoice: boolean;
  roleNote: string | null;
  facts: ProductFacts;
  rules: ContentRule[];
  // 사람이 고른 기획안 (직접 지정이면 null)
  idea: { title: string; format: string; concept: string } | null;
  // 직접 지정할 때 사람이 남긴 메모
  brief: string | null;
  // 계정 컨셉(0038)
  concept?: string | null;
  tone?: string | null;
  editStyle?: string | null;
  // 사람이 고정한 첫 · 마지막 문구 안내 (fixed-phrases.ts)
  phraseBlock?: string;
  fixRequests?: string[];
}

function systemPrompt(ctx: ShotlistContext): string {
  const f = ctx.facts;
  const person = ctx.roleFocus === "PERSON";
  const focus = person ? (ctx.liveVoice ? "사람 중심(사람이 나와 말하고 쓰는 모습)" : "사람 중심(사람이 나와 쓰는 모습, 말은 하지 않고 AI 음성이 읽는다)") : ctx.roleFocus === "PRODUCT" ? "상품 중심(손 · 제형 · 구성 클로즈업, 얼굴 없이)" : "미정";
  const what = ctx.idea
    ? `고른 기획: "${ctx.idea.title}" (${ctx.idea.format}) — ${ctx.idea.concept}`
    : `사람이 상품을 직접 골랐다.${ctx.brief ? ` 메모: "${ctx.brief}" — 이 메모를 가장 먼저 반영한다.` : " 상품 사실에서 가장 찍을 만한 특징으로 기획한다."}`;
  const kit = editKit();
  return `너는 인스타그램 @${ctx.accountName}의 릴스 촬영 감독 겸 대본 작가다. 사람이 휴대폰으로 컷 리스트대로 찍어 올리면 AI 편집자가 원본을 보고 컷 · 음성 · 자막 · 그래픽 · 효과음을 넣어 완성한다.
계정 역할: ${focus}${ctx.roleNote ? ` — ${ctx.roleNote}` : ""}
상품: ${f.shop} ${f.kindLabel} "${f.name}"
${what}

순서 (스킬을 실제로 써라):
1. get_product_facts, list_hook_formulas를 읽는다.
2. 서로 다른 공식으로 훅 3개를 쓰고 score_hooks로 채점한다. 1등이 50점 미만이면 다시 쓴다. 첫 컷은 그 훅이다.
   후킹 규칙:
${kit.hook_rules.map((r) => `   - ${r}`).join("\n")}
   표지 규칙(thumbnail):
${kit.thumbnail_rules.map((r) => `   - ${r}`).join("\n")}
3. 컷 리스트: 컷 5~8개, 컷마다 1.5~5초, 합계 15~25초. 첫 컷은 후킹 글자와 함께 궁금증을 만드는 장면이다(결과 · 단면 · 움직임 · 의외의 행동). 편집에서 잘라 쓰게 컷마다 동작을 2~3초 더 길게 찍으라고 how에 적는다.
   컷마다 장면이 바뀌어야 한다(같은 각도 연속 금지). 마지막 컷은 훅의 낱말을 되받아 다시 보게.
   how는 찍는 사람이 그대로 따라 할 수 있게 구체적으로: 위에서 · 옆에서 · 손 클로즈업 · 흰 배경 · 창가 빛 등.
4. ${ctx.liveVoice ? "voice: 사람이 카메라 보고 말할 짧은 대사. 컷 길이 안에 말할 수 있게(1초에 6음절 안팎). time_script로 재고 경고를 없앤다." : "voice는 모두 빈 문자열이다. 찍는 사람은 말하지 않고, narration을 AI 음성이 읽는다. 말투는 친근한 수다체, 컷 길이 안에 읽을 수 있게(1초에 6음절 안팎). 말은 그 컷에서 보이는 것에 맞춘다. time_script로 재고 경고를 없앤다."}
5. 캡션을 쓰고 check_caption으로 점검한다. 첫 줄 40자 이내, 요청은 하나, 해시태그 정확히 3개.
6. 화면 문구 · 대사 · 캡션 전체를 check_ai_tone, check_rules로 점검하고 걸린 것을 고친다.

절대 규칙:
- 사실(숫자 · 산지 · 성분 · 효과 · 구성)은 get_product_facts에 있는 것만. 없는 숫자를 만들지 않는다. uncertainties에 있는 건 말하지 않는다.
- 1인칭은 그 컷에서 실제로 보여 주는 것까지만: "손등에 덜어 보면 묽어요"는 된다. "2주 썼더니 피부가", "먹고 나서 속이 편해졌어요"처럼 촬영으로 확인할 수 없는 체험 · 효과 · 지어낸 후기는 안 된다.
- 건강기능식품 기능성 표현은 approvedClaims 문장 그대로만. 비어 있으면 기능성 · 건강 효과를 말하지 않는다.${f.kind === "COSMETIC" ? "\n- 화장품: 캡션에 '개인차'가 있음을 밝힌다. 치료 · 재생 · 염증 같은 표현을 쓰지 않는다. 미백 · 주름 개선 · 자외선 차단은 certifiedFunctions에 있는 것만 쓴다." : ""}
- 재고 · 품절 · 할인 · 배송 같은 판매 상태는 말하지 않는다. 가격은 상품 사실의 price만.
- 인사 · 자기소개 · "오늘은 ~ 소개해 드릴게요"로 시작하지 않는다. 최고 · 유일 · 100% 같은 단정을 쓰지 않는다.
- 화면 문구는 한 컷 12자 안팎. 말투는 짧고 자연스러운 구어체, 번역투 · 상투어 · 같은 어미 반복을 피한다.${conceptBlock("이 계정의 직접 촬영 컨셉", ctx.concept, "훅 · 찍는 방식을 이 방향에 맞춘다.")}${conceptBlock("이 계정의 말투 · 분위기", ctx.tone, "대사 · 화면 문구 · 캡션의 말투를 이것에 맞춘다.")}${conceptBlock("이 계정의 편집 스타일", ctx.editStyle, "편집에서 살릴 수 있게 컷 길이와 구도만 이 스타일에 맞춘다. 글자 색 · 위치 · 음악 같은 편집 지시는 편집 단계가 따로 하니 how나 다른 칸에 옮겨 적지 않는다.")}${ctx.phraseBlock ?? ""}`;
}

export async function writeShotlist(ctx: ShotlistContext, opts: { log: boolean }): Promise<AgentResult<ShotlistOutput>> {
  const fix = ctx.fixRequests?.length
    ? `\n\n이전 컷 리스트가 점검에서 걸렸다. 이것을 반드시 고쳐서 다시 써라:\n${ctx.fixRequests.map((r) => `- ${r}`).join("\n")}`
    : "";
  return runAgent({
    agent: "plan",
    system: systemPrompt(ctx),
    user: `${ctx.facts.name}로 릴스 촬영 컷 리스트 · 화면 문구 · 캡션을 써 줘.${fix}`,
    skills: writerSkills(ctx),
    outputSchema: shotlistSchema,
    outputName: "shot_list",
    maxSteps: 14,
    service: opts.log ? ctx.service : null,
    readService: ctx.service,
    planId: ctx.planId,
    input: { track: "A", product: ctx.facts.name, idea: ctx.idea, brief: ctx.brief, fixRequests: ctx.fixRequests ?? [], concept: ctx.concept ?? null, tone: ctx.tone ?? null, editStyle: ctx.editStyle ?? null },
  });
}

/** 컷 리스트를 점검 에이전트(4)가 읽는 대본 모양으로 — 말하는 줄은 대사, 없으면 화면 문구. */
export function shotlistAsScript(s: ShotlistOutput) {
  return {
    hooks: s.hooks,
    chosen_hook: s.chosen_hook,
    beats: s.cuts.map((c) => ({ spoken: c.voice || c.narration || c.on_screen, on_screen: c.on_screen, visual: `${c.shot} — ${c.how}` })),
    loop_word: s.loop_word,
    caption: s.caption,
  };
}

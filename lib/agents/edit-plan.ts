import { z } from "zod";
import { conceptBlock } from "@/lib/agents/concept";
import { editKit, ttsReading } from "@/lib/agents/ko-skills";
import type { ProductFacts } from "@/lib/agents/product-facts";
import type { ProductKind } from "@/lib/products/shops";
import { runAgent, type AgentResult, type AgentSkill } from "@/lib/agents/runner";
import { writerSkills } from "@/lib/agents/script";
import type { ContentRule } from "@/lib/rules/check";
import { lookSchema } from "@/lib/shoot/video-kit/caption-style";
import type { createServiceClient } from "@/lib/supabase/service";

// 편집 에이전트(3) — 올라온 촬영본의 프레임을 보고 편집 계획을 정한다(.claude/skills/ig-edit-ko).
// AI는 계획만 낸다. 자르기 · 음성 · 자막 · 그래픽 · 소리 · 렌더링은 코드(lib/shoot/video-kit)가 계획대로 한다.
// 사람이 넣은 후킹 · 표지 문구는 여기서 쓰게 하고, 답을 받은 뒤 코드가 한 번 더 덮어쓴다.

type Service = ReturnType<typeof createServiceClient>;

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

// AI 이미지는 원료를 그림으로 설명할 수 있는 상품에만 쓴다. 과일 · 의류는 그림이 실물처럼 보여 쓰지 않는다
export const VISUAL_KINDS: ProductKind[] = ["COSMETIC", "HEALTH_FOOD"];
export const MAX_VISUALS = 2;
// 설명 영상의 상식 구간(2026-11-06 사용자 결정). 과일 품종 · 원리 설명에도 쓴다
// 첫 장면은 상황 장면이라 사람 없는 생활 장면 그림을 쓸 수 있다(2026-11-09 사용자 결정)
export const LONG_VISUALS: VisualPolicy = { max: 10, minGap: 1, allKinds: true, firstBeat: true };

export interface VisualPolicy {
  max: number;
  // 그림 사이 최소 비트 간격. 1이면 연달아 넣을 수 있다
  minGap: number;
  allKinds: boolean;
  // 첫 비트에도 그림을 넣을 수 있다. 마지막 비트는 늘 상품으로 끝낸다
  firstBeat?: boolean;
  // 근거 문구를 찾을 추가 글(상식 카드 등)
  evidence?: string;
}

export const visualSchema = z.object({
  beat: z.number().int().describe("이 그림으로 화면을 채울 비트 번호(0부터)"),
  key: z.string().describe("그림 이름. 영어 소문자와 - 만. 목록에 같은 그림이 있으면 그 key를 그대로"),
  subject: z.string().describe("무엇을 보여 주는 그림인지 한국어 한 줄"),
  evidence: z.string().describe("이 그림의 근거. 상품 자료에 있는 문구를 글자 그대로 옮긴다"),
  prompt: z.string().describe("그림 설명 영어. 보이는 장면만 쓴다"),
  motion: z.enum(["liquid", "solid"]).describe("liquid 액체 · 물방울이라 일렁임, solid 결정 · 고체라 빛만"),
});
export type EditVisual = z.infer<typeof visualSchema>;

/** 편집 계획과 장면표가 함께 쓰는 AI 이미지 규칙. */
export function visualRules(kind: ProductKind, library: { key: string; subject: string }[], policy?: VisualPolicy): string {
  if (policy) {
    return `

AI 이미지(visuals) — 상식 구간에서 말로 설명하는 원료 · 품종 · 원리를 보여 준다. source가 visual인 장면마다 하나씩, 영상당 ${policy.max}개까지:
- 그림이 나오는 동안의 말은 그 그림이 설명하는 내용이어야 한다. 같은 그림만 이어지지 않게 장면마다 다른 구도로 만든다.
- 상품처럼 보이는 그림은 만들지 않는다. 제품 · 용기 · 포장 · 피부 · 사람 · 손 · 사용 전후 · 몸속 작용 · 글자 · 로고를 넣지 않는다.
- 효과가 나타나는 모습을 그리지 않는다. 원료의 생김새, 유래, 개념만 보여 준다.${kind === "FRUIT" ? "\n- 과일은 품종이나 원리를 설명하는 그림으로만 쓴다. 판매 상품의 크기 · 신선도 · 과즙을 과장하지 않고, 상자 · 스티커를 넣지 않는다." : ""}
- evidence에는 그 그림의 근거가 되는 상품 자료 문구나 상식 카드 문장을 글자 그대로 옮긴다.${library.length ? `\n이미 만든 그림(같은 내용이면 이 key를 쓴다):\n${library.map((l) => `${l.key}: ${l.subject}`).join("\n")}` : ""}`;
  }
  if (!VISUAL_KINDS.includes(kind)) return "\n\nAI 이미지(visuals): 이 상품에는 쓰지 않는다. 빈 배열로 낸다.";
  return `

AI 이미지(visuals) — 말로 성분 · 원료 · 원리를 설명하는데 보여 줄 실제 화면이 없는 비트에 AI가 만든 그림을 넣는다:
- 꼭 필요할 때만, 영상당 0~${MAX_VISUALS}개. 실제 화면으로 말이 되면 빈 배열로 낸다.
- 첫 비트 · 마지막 비트 · 사람이 말하는 비트에는 넣지 않고, 연달아 넣지 않는다.
- 그 비트의 실제 컷은 그대로 둔다. 그림을 못 만들면 실제 컷이 나간다.
- 그림이 나오는 동안의 말은 그 그림이 설명하는 내용이어야 한다.
- 상품처럼 보이는 그림은 만들지 않는다. 제품 · 용기 · 크림과 세럼 같은 제형 질감 · 피부 · 사람 · 손 · 사용 전후 · 몸속 작용 · 글자 · 로고를 넣지 않는다. 유리 · 결정 · 물방울 · 분자 구조 같은 추상으로 그린다.
- 원료의 출처(연어, 과일 등)는 상품 자료에 있을 때만 그린다.
- 효과가 나타나는 모습을 그리지 않는다. 무엇이 들어 있는지만 보여 준다.${library.length ? `\n이미 만든 그림(같은 내용이면 이 key를 쓴다):\n${library.map((l) => `${l.key}: ${l.subject}`).join("\n")}` : ""}`;
}

export const editPlanSchema = z.object({
  look: lookSchema.describe("이 영상의 자막 · 큰 글자 디자인과 음악. 계정 설정을 읽고 영상마다 만든다"),
  caption_style: z
    .enum(["sentence", "keyword"])
    .describe("자막 방식. sentence = 과정 · 방법 · 순서를 설명하는 영상이라 말한 문장을 그대로 같은 자리 · 같은 크기로 보여 준다. keyword = 분위기 위주 영상이라 핵심어를 크게 보여 준다"),
  analysis: z
    .array(z.object({ clip: z.number().int(), good: z.string().describe("쓸 만한 구간과 내용"), avoid: z.string().describe("뺄 구간 · 이유") }))
    .describe("촬영본마다 한 줄"),
  components: z
    .array(
      z.object({
        name: z.string().describe("구성품 이름(get_product_facts 기준)"),
        seen: z.boolean().describe("촬영본에서 이 구성품을 알아볼 수 있는 구간을 찾았는지"),
        clip: z.number().int().describe("보이는 촬영본 번호. 못 찾았으면 0"),
        from: z.number().describe("보이기 시작하는 시각(초). 못 찾았으면 0"),
        to: z.number().describe("보이는 구간의 끝(초). 못 찾았으면 0"),
        where: z.string().describe("화면의 어디에 어떻게 보이는지(예: 접시 왼쪽 위에 크게). 못 찾았으면 빈 문자열"),
      }),
    )
    .describe("구성품이 여럿인 상품을 사람이 찍은 촬영본에서, 구성품마다 프레임에서 찾은 구간. 따로 찍은 컷이 아니어도 된다. 구성품이 하나이거나 사람이 찍은 촬영본이 아니면 빈 배열"),
  hook: z.object({
    on_screen: z.string().describe("첫 프레임부터 보이는 큰 글자, 12자 안팎. 두 줄로 나누려면 줄바꿈"),
    highlight: z.string().describe("on_screen에서 강조할 낱말, 없으면 빈 문자열"),
    position: z.enum(["top", "lower"]).describe("글자 위치. 상품 · 표시창 · 얼굴이 위쪽에 있으면 lower"),
    spoken: z.string().describe("첫 비트에서 하는 말"),
  }),
  thumbnail: z.object({
    title: z.string().describe("표지 글자, 8자 안팎. 두 줄로 나누려면 줄바꿈"),
    highlight: z.string().describe("title에서 강조할 낱말, 없으면 빈 문자열"),
    position: z.enum(["top", "lower"]).describe("글자 위치. 상품 · 표시창 · 얼굴을 가리지 않는 쪽"),
    sub: z.string().describe("작은 글자, 없으면 빈 문자열"),
    clip: z.number().int().describe("표지로 쓸 촬영본 번호"),
    at: z.number().describe("그 촬영본에서 쓸 시각(초)"),
  }),
  beats: z
    .array(
      z.object({
        mode: z.enum(["tts", "live"]).describe("tts = AI 음성으로 읽기, live = 촬영본의 사람 말을 그대로"),
        tts: z.string().describe("TTS 읽기용 원고, 말하는 대로. live면 빈 문자열"),
        captions: z.array(z.string()).describe("화면 자막. sentence면 말한 문장 그대로 두 줄(28자 안팎)까지, keyword면 의미 단위 16자 이내. 첫 비트가 후킹 글자와 같으면 빈 배열, live면 빈 배열"),
        big: z.boolean().describe("이 비트의 자막을 큰 강조 글자로 보여 줄지. sentence 영상에서 두 번째 약속 · 완성 · 반전처럼 2~3개 비트만 true. keyword 영상은 false"),
        emphasis: z.array(z.string()).describe("자막에서 강조할 핵심어"),
        cuts: z
          .array(z.object({ clip: z.number().int(), in: z.number(), out: z.number(), what: z.string().describe("이 구간에 보이는 것") }))
          .describe("이 비트에 쓸 원본 구간, 차례대로. live면 정확히 1개"),
        graphics: z.array(graphicSchema),
        sfx: z.array(z.object({ name: z.enum(sfxNames), at_word: z.string(), at: z.number() })),
      }),
    )
    .describe("비트 5~14개. 첫 비트 = 후킹"),
  visuals: z.array(visualSchema).describe("AI 이미지. 없으면 빈 배열"),
  warnings: z
    .array(z.string())
    .describe("사람이 확인할 문제만 시각과 함께: 구성품이 아닌 소품, 주의사항과 부딪히는 장면, 근거가 약한 말, 관리자가 쓴 말을 고친 이유. 편집 과정이나 지시 사항은 쓰지 않는다. 없으면 빈 배열"),
});
type ParsedEditPlan = z.infer<typeof editPlanSchema>;
// caption_style · big · components는 나중에 생긴 값이라 그 전에 저장된 계획(다시 편집)과 코드가 만든 계획(lemo)에는 없다. 없으면 예전 방식(keyword)이다
export type EditPlan = Omit<ParsedEditPlan, "caption_style" | "beats" | "components"> & {
  caption_style?: ParsedEditPlan["caption_style"];
  components?: ParsedEditPlan["components"];
  beats: (Omit<ParsedEditPlan["beats"][number], "big"> & { big?: boolean })[];
};
export type EditBeat = EditPlan["beats"][number];

// 사람이 말하지 않는 직접 촬영 영상(보여 주는 영상)의 길이 기준. 촬영 기획(plan-a · shotlist) · 편집 지시문 · 편집 점검(planProblems)이 같은 값을 쓴다
export const SHOW_SECONDS = { min: 25, max: 40 };
// 읽는 글자 수(띄어쓰기 · 문장부호 제외)로 영상 길이를 어림하는 빠르기. 줄 사이 쉼까지 넣은 값이다(2026-11-12 실측: 149자 → 21.1초)
export const SHOW_SYLLABLES_PER_SECOND = 7;
export type EditGraphic = z.infer<typeof graphicSchema>;

export interface EditClipInfo {
  no: number;
  duration: number;
  shot?: string;
  how?: string;
  onScreen?: string;
  voice?: string;
  narration?: string;
  // 말하는 계정의 받아쓰기
  transcript?: { text: string; start: number; end: number }[];
}

export interface EditPlanContext {
  service: Service | null;
  readService?: Service;
  planId?: string;
  accountName: string;
  // 찍을 때 말한 소리를 쓰는지(0044). 영상 방향과 별개다
  liveVoice: boolean;
  facts: ProductFacts;
  rules: ContentRule[];
  clips: EditClipInfo[];
  sheets: string[];
  // 사람이 넣은 문구(영상별) → 계정에 저장한 문구 → 컷 리스트의 훅 차례로 쓴다
  humanHook?: string | null;
  humanThumbnail?: string | null;
  // 직접 촬영: 관리자가 이 상품으로 하고 싶은 말(human_brief). 대본 내용의 첫 기준이다
  brief?: string | null;
  // 직접 촬영: 컷 리스트가 쓴 추천 대본. 촬영본이 이대로 찍혔다는 보장은 없어 참고로만 쓴다
  recommendedScript?: { shot: string; onScreen: string; narration: string }[];
  shotlistHook?: { spoken: string; on_screen: string } | null;
  shotlistThumbnail?: { title: string; sub?: string } | null;
  fixedHook?: string | null;
  fixedEnding?: string | null;
  tone?: string | null;
  editStyle?: string | null;
  lookCloser: (clip: number, from: number, to: number) => Promise<string>;
  // 소재가 사람이 찍은 촬영본인지, AI 자동 콘텐츠용으로 만든 것인지
  source?: "shoot" | "auto";
  // AI 자동 콘텐츠: 점검을 통과한 대본. 뜻을 바꾸지 않고 쓴다
  scriptLines?: string[];
  // 저장해 둔 AI 이미지 목록
  visualLibrary?: { key: string; subject: string }[];
  // 먼저 낸 계획과 코드 점검에서 걸린 것 — 고쳐서 다시 낸다
  retry?: { plan: EditPlan; problems: string[] } | null;
}

function bullets(lines: string[]): string {
  return lines.map((l) => `- ${l}`).join("\n");
}

/**
 * 직접 촬영의 대본 기준(2026-11-10 사용자 결정): 관리자가 하고 싶은 말 → 추천 대본 → 상품 정보 차례.
 * 촬영본은 컷 리스트와 상관없이 올라오니 추천 대본은 보이는 장면에 맞는 말만 가져다 쓴다.
 */
function shootScriptBlock(ctx: EditPlanContext): string {
  const brief = ctx.brief?.trim();
  const script = (ctx.recommendedScript ?? []).filter((c) => c.narration || c.onScreen || c.shot);
  const order: string[] = [];
  if (brief)
    order.push(
      `관리자가 이 상품으로 하고 싶은 말: "${brief}"\n   뜻은 그대로 두고 영상 길이와 계정 말투에 맞게 다듬어 대본의 중심으로 쓴다. 광고 문구 규칙(check_rules)에 어긋나는 표현이나 get_product_facts에 근거가 없는 효능 · 사실은 맞는 말로 고쳐 쓰고, 무엇을 왜 고쳤는지 warnings에 "하고 싶은 말: "으로 시작해 남긴다.`,
    );
  if (script.length)
    order.push(
      `찍기 전에 쓴 추천 대본(참고용). 촬영본이 이 순서 · 장면대로 찍혔다는 보장이 없다. 프레임에서 실제로 보이는 장면에 맞는 말만 가져다 쓰고, 보이지 않는 장면의 말은 버린다.\n${script.map((c, i) => `   ${i + 1}) ${JSON.stringify({ shot: c.shot, on_screen: c.onScreen, narration: c.narration })}`).join("\n")}`,
    );
  order.push("get_product_facts의 상품 정보.");
  // 하고 싶은 말과 추천 대본의 흐름이 다르면 하고 싶은 말을 따른다(2026-11-10 사용자 결정)
  const conflict =
    brief && script.length
      ? `\n하고 싶은 말과 추천 대본의 흐름(주제 · 말하는 순서 · 강조점 · 마지막 말)이 다르면 하고 싶은 말의 흐름으로 대본을 짠다. 추천 대본은 그 흐름에 맞는 말만 빌려 쓰고, 어긋나는 줄은 장면이 보여도 버린다. 컷 리스트의 훅 · 표지 문구도 하고 싶은 말과 방향이 다르면 쓰지 않는다.`
      : "";
  return `

대본 내용 기준 (앞의 것을 먼저 따른다):
${order.map((o, i) => `${i + 1}. ${o}`).join("\n")}${conflict}
촬영본 개수와 순서는 사람이 정했다. 흐름은 촬영본 순서를 기본으로 하되, 첫 컷은 가장 궁금한 장면으로 당겨도 된다. 쓸 장면이 없는 촬영본은 빼도 된다.`;
}

// 가격 · 할인 표현. 관리자가 영상을 만들 때 넣은 문구에 있을 때만 쓸 수 있다(2026-11-12 사용자 결정)
const PRICE_WORDS = /특가|할인|세일|쿠폰|반값|최저가|[0-9][0-9,]*\s*(?:원|만\s*원|천\s*원|%|퍼센트)/;

/** 관리자가 넣은 문구(하고 싶은 말 · 후킹 · 마지막 말 · 표지) 중 가격 · 할인 표현이 있는 것. */
export function humanPriceLines(ctx: Pick<EditPlanContext, "brief" | "humanHook" | "fixedHook" | "fixedEnding" | "humanThumbnail">): string[] {
  return [ctx.brief, ctx.humanHook, ctx.fixedHook, ctx.fixedEnding, ctx.humanThumbnail]
    .map((t) => t?.trim() ?? "")
    .filter((t) => t && PRICE_WORDS.test(t));
}

function systemPrompt(ctx: EditPlanContext): string {
  const kit = editKit();
  const f = ctx.facts;
  const human = ctx.humanHook?.trim() || ctx.fixedHook?.trim();
  const hookAsk = human
    ? `사람이 정한 후킹이 있다: "${human}". 글자를 바꾸지 말고 hook.on_screen과 hook.spoken, 첫 비트의 말에 그대로 쓴다. 이 문장이 궁금해지는 첫 컷과 그 답이 나오는 흐름을 만든다.`
    : `후킹은 네가 만든다. list_hook_formulas를 읽고 후보 3개를 score_hooks로 채점한 뒤, 아래 후킹 규칙을 가장 잘 지키는 것을 고른다.${ctx.shotlistHook ? ` 컷 리스트의 훅 "${ctx.shotlistHook.spoken}"이 궁금증을 만들면 그대로 쓰고, 약하면 더 강하게 고친다.` : ""}`;
  const thumbAsk = ctx.humanThumbnail?.trim()
    ? `사람이 정한 표지 글자가 있다: "${ctx.humanThumbnail.trim()}". 글자를 바꾸지 말고 thumbnail.title에 쓰고, 어울리는 프레임만 고른다.`
    : `표지도 네가 만든다.${ctx.shotlistThumbnail?.title ? ` 컷 리스트의 표지 문구 "${ctx.shotlistThumbnail.title}"를 참고한다.` : ""}`;
  const auto = ctx.source === "auto";
  const priceLines = humanPriceLines(ctx);
  const priceRule = priceLines.length
    ? `재고 · 품절 · 배송은 말하지 않는다. 특가 · 할인 · 금액은 관리자가 넣은 아래 문구에 있는 표현과 숫자 그대로만 쓸 수 있다(끝맺음의 이유로 쓰기 좋다). 문구에 없는 할인율 · 금액 · 기간 · "오늘만" 같은 조건은 만들지 않는다.\n${priceLines.map((l) => `  · "${l}"`).join("\n")}`
    : "재고 · 품절 · 할인 · 특가 · 배송 · 가격은 말하지 않는다.";
  // 구성품은 하나씩 따로 찍게 하지 않고, 편집 에이전트가 촬영본에서 찾아 쓴다(2026-11-12 사용자 결정). AI 자동 영상은 예전 지시 그대로다
  const findComponents = auto
    ? ""
    : " 구성품이 여럿인 상품은 구성품 하나하나가 촬영본의 어느 구간에 보이는지도 프레임에서 찾아 components에 적는다. 하나씩 따로 찍은 컷이 없어도 된다. 팩을 연 장면, 그릇에 담은 장면, 재료를 올리는 장면처럼 여러 구성품이 함께 보이는 구간에서 찾고, 작게 보이면 look_closer로 확인한다. 알아볼 수 없으면 seen을 false로 둔다.";
  const componentCuts = auto
    ? "이름을 부를 때 그 구성품이 크게 보이는 컷을 쓴다(그런 장면이 촬영본에 있을 때만)"
    : "components에서 찾은 구간을 쓴다. 구성품이 크게 보이는 컷이 따로 있으면 이름을 부르는 차례대로 하나씩 쓰고, 없으면 여러 구성품이 함께 보이는 구간을 쓰면서 이름을 부를 때 그 구성품을 ring이나 arrow로 짚는다(그 구간에서 멈춰 있을 때만). 촬영본에서 찾지 못한 구성품은 이름을 하나씩 짚어 부르지 않고, 찾지 못한 구성품 이름을 warnings에 남긴다. 찾은 구성품이 없으면 이 구간을 뺀다";
  const showLength =
    auto || ctx.liveVoice
      ? ""
      : ` 보여 주는 영상의 길이는 tts 전체의 읽는 글자 수(띄어쓰기 · 문장부호 제외)로 맞춘다: ${SHOW_SECONDS.min * SHOW_SYLLABLES_PER_SECOND}~${SHOW_SECONDS.max * SHOW_SYLLABLES_PER_SECOND}자가 ${SHOW_SECONDS.min}~${SHOW_SECONDS.max}초다. 촬영본 합계가 ${SHOW_SECONDS.min}초보다 짧으면 촬영본 합계만큼이면 된다. 짧다고 같은 말을 늘이지 않고, 상품 구성 · 약속 · 결과를 떠올리게 하는 말처럼 빠진 내용을 채운다.`;
  return `너는 인스타그램 @${ctx.accountName}의 릴스 편집자다. ${auto ? "제품 사진을 움직인 컷, 설명 모션, 스톡 분위기 영상으로 된 소재를 보고" : "사람이 찍은 원본을 보고"}, 직접 만든 것처럼 보이는 편집 계획을 세운다. 계획은 코드가 그대로 만든다.
상품: ${f.shop} ${f.kindLabel} "${f.name}"
${ctx.liveVoice ? "이 계정은 사람이 나와 말한다. 촬영본에 말이 있는 구간은 mode live로 그대로 쓰고, 말이 없는 구간에만 tts를 쓴다." : `이 계정의 소재에는 쓸 말이 없다. 모든 비트를 mode tts로 쓴다.${ctx.tone?.trim() ? " 말투는 아래 계정 설정을 따른다." : " 계정 말투 설정이 없으니 친근한 수다체로 쓴다."}`}

순서 (스킬을 실제로 써라):
1. get_product_facts를 읽고, 프레임 묶음에서 촬영본마다 쓸 구간과 뺄 구간을 판단한다(analysis). 시각이 애매하면 look_closer로 확인한다.${findComponents}
2. ${hookAsk}
3. ${thumbAsk}
4. 대본과 컷: 첫 비트는 후킹이고 첫 컷은 가장 궁금한 장면이다. 그 뒤로 비트마다 한 가지만 말하고 장면과 말이 맞게 한다. 합계는 촬영본과 기획에 맞춘다. 보여 주는 영상은 ${SHOW_SECONDS.min}~${SHOW_SECONDS.max}초, 사람이 설명하는 영상은 내용에 맞게 30~85초.${showLength}
   만드는 과정 · 방법을 보여 주는 영상은 후킹 → 상품 구성 → 약속 → 과정 → 완성 → 제안 순서로 짠다. 상품 구성은 과정에 들어가기 전에 이 상품에 무엇이 들어 있는지 구성품 이름을 하나씩 부르는 구간이고, ${componentCuts}. 약속은 이 영상에서 무엇을 알려 주는지 한 번 더 말하는 줄이다. 과정 설명 사이에는 맛 · 식감 · 쓰는 느낌처럼 결과를 떠올리게 하는 말을 넣는다.
5. 자막 · 그래픽 · 효과음을 정한다. 쓰는 말 전체를 check_ai_tone, check_rules로 점검하고 read_tts로 읽기용 원고를 확인한다.
6. look을 정한다. 아래 계정 설정과 상품 · 장면을 읽고 이 영상에 맞는 글자 디자인과 음악을 직접 만든다.${auto && ctx.scriptLines?.length ? `

점검을 통과한 대본이다. 문장을 고쳐 쓰지 말고 비트로 그대로 쓴다. 숫자와 기호만 읽는 대로 바꾼다:
${bullets(ctx.scriptLines)}` : ""}${auto ? `

소재 규칙:
- [제품컷]은 실제 제품 사진을 움직인 것이다. 사진 속 장면을 실제 사용 과정처럼 설명하지 않는다.
- [자사 촬영]은 이 상품을 직접 찍은 짧은 실제 영상이다. 소리는 없다. 손이 나와도 누군가 써 본 후기처럼 말하지 않고, 보이는 장면을 효과의 증거처럼 말하지 않는다.
- [코드 모션]은 설명 도식이다. 도식의 숫자가 나오는 시각에 맞춰 그 말을 하게 구간을 고른다.
- [스톡]은 상품과 무관한 분위기 영상이다. 공감이나 상황을 말하는 문장에만 쓰고, 스톡 장면에서 상품 기능을 말하지 않는다. 어울리는 문장이 있으면 한 번은 쓴다.` : ""}${auto ? "" : shootScriptBlock(ctx)}

글자 디자인 규칙:
${bullets(kit.look_rules)}
음악은 영상마다 찾는다. 상품 · 말투 · 장면에 맞는 music_query와 music_intent를 쓴다. 비슷한 상품이어도 그 영상의 분위기로 쓴다.
검색이 안 될 때 쓸 곡(music):
${JSON.stringify(kit.music_library.map((m) => ({ file: m.file, mood: m.mood })))}

후킹 규칙:
${bullets(kit.hook_rules)}

표지 규칙:
${bullets(kit.thumbnail_rules)}

컷 규칙:
${bullets(kit.cut_rules)}

자막 규칙:
${bullets(kit.caption_rules)}

음성 규칙:
${bullets(kit.tts_rules)}

그래픽 틀 (이것만 쓴다. 쓰지 않는 칸은 빈 문자열, 숫자는 0):
${JSON.stringify(kit.graphics)}
${bullets(kit.graphics_rules)}

효과음 (이것만 쓴다):
${JSON.stringify(Object.fromEntries(Object.entries(kit.sfx).map(([k, v]) => [k, v.use])))}
${bullets(kit.sfx_rules)}${visualRules(f.kind, ctx.visualLibrary ?? [])}

절대 규칙:
- 사실(숫자 · 성분 · 효과 · 구성 · 사용법)은 get_product_facts와 화면에서 읽히는 제품 표기에만 근거한다. 없는 내용은 말하지 않는다. uncertainties에 있는 건 말하지 않는다.
- 체험담처럼 들리는 말("써 봤는데", "제가 해 보니")을 지어내지 않는다. 화면에서 실제로 보여 주는 것만 말한다.
- 건강기능식품 기능성 표현은 approvedClaims 문장 그대로만. ${priceRule}${f.kind === "COSMETIC" ? "\n- 화장품: 치료 · 재생 · 염증 같은 표현을 쓰지 않고, 효과를 단정하지 않는다." : ""}
- 제품 설명에 안전 주의가 있으면 그에 어긋나는 사용을 권하지 않고, 영상에 꼭 필요한 주의를 넣는다.
- 인사 · 자기소개 · "오늘은 ~ 소개해 드릴게요"로 시작하지 않는다. 최고 · 유일 · 100% 같은 단정을 쓰지 않는다.
- 끝맺음은 강매 없이 짧게 하고, 마지막 말이 끝나면 영상도 끝난다. end_card는 선택이다. 넣으면 그 비트의 자막은 화면에 나오지 않으니 제안을 end_card에 담고, 넣지 않으면 상품이 보이는 컷 위에 자막으로 끝낸다.${ctx.fixedEnding?.trim() ? `\n- 마지막 말은 사람이 정한 "${ctx.fixedEnding.trim()}"을 그대로 쓴다.` : ""}
- 구간은 촬영본 길이 안에서만 고른다.${conceptBlock("이 계정의 말투 · 분위기", ctx.tone, "말과 글의 말투를 이것에 맞춘다.")}${conceptBlock("이 계정의 편집 스타일", ctx.editStyle, "컷 속도 · 그래픽 양을 이 방향에 맞춘다.")}`;
}

export async function writeEditPlan(ctx: EditPlanContext, opts: { maxSteps?: number } = {}): Promise<AgentResult<EditPlan>> {
  const facts = ctx.facts;
  const shared = writerSkills({ facts, rules: ctx.rules, accountName: ctx.accountName });
  const skills: AgentSkill[] = [
    ...shared.filter((s) => s.name !== "check_caption"),
    {
      name: "look_closer",
      description: "촬영본 한 구간의 프레임을 촘촘히 본다. 컷 시작 · 끝, 표시창 숫자, 움직임을 확인할 때 쓴다.",
      input: z.object({ clip: z.number().int(), from: z.number(), to: z.number() }),
      async run(args) {
        const a = args as { clip: number; from: number; to: number };
        return { ok: true, __images: [await ctx.lookCloser(a.clip, a.from, a.to)] };
      },
    },
    {
      name: "read_tts",
      description: "TTS 읽기용 원고를 넣으면 숫자 · 기호를 말하는 대로 바꾼 결과와 남은 문제를 돌려준다.",
      input: z.object({ lines: z.array(z.string()).min(1).max(14) }),
      async run(args) {
        return ttsReading((args as { lines: string[] }).lines);
      },
    },
  ];
  const clipLines = ctx.clips.map((c) =>
    JSON.stringify({ clip: c.no, seconds: Number(c.duration.toFixed(1)), shot: c.shot ?? "", on_screen: c.onScreen ?? "", voice: c.voice ?? "", narration: c.narration ?? "", ...(c.transcript?.length ? { transcript: c.transcript } : {}) }),
  );
  return runAgent({
    agent: "edit",
    system: systemPrompt(ctx),
    user: `${facts.name} 촬영본 ${ctx.clips.length}개의 편집 계획을 세워 줘. 프레임 묶음은 촬영본 순서대로이고, 왼쪽 위 글자가 그 촬영본의 시각이다.\n\n${clipLines.join("\n")}${ctx.retry ? `\n\n먼저 낸 계획이 점검에서 걸렸다. 이것을 고쳐서 계획 전체를 다시 내라:\n${ctx.retry.problems.map((p) => `- ${p}`).join("\n")}\n\n먼저 낸 계획:\n${JSON.stringify(ctx.retry.plan.beats.map((b) => ({ tts: b.tts, cuts: b.cuts })))}` : ""}`,
    userImages: ctx.sheets,
    skills,
    outputSchema: editPlanSchema,
    outputName: "edit_plan",
    maxSteps: opts.maxSteps ?? 16,
    service: ctx.service,
    readService: ctx.readService,
    planId: ctx.planId ?? null,
    input: { product: facts.name, clips: ctx.clips.length, humanHook: ctx.humanHook ?? null, humanThumbnail: ctx.humanThumbnail ?? null, brief: ctx.brief ?? null },
  });
}

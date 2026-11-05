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
const sfxNames = ["pop", "click", "rustle", "whoosh", "plug", "tick", "ding"] as const;

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
export function visualRules(kind: ProductKind, library: { key: string; subject: string }[]): string {
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
  analysis: z
    .array(z.object({ clip: z.number().int(), good: z.string().describe("쓸 만한 구간과 내용"), avoid: z.string().describe("뺄 구간 · 이유") }))
    .describe("촬영본마다 한 줄"),
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
        captions: z.array(z.string()).describe("화면 자막. 의미 단위 16자 이내. 첫 비트가 후킹 글자와 같으면 빈 배열, live면 빈 배열"),
        emphasis: z.array(z.string()).describe("자막에서 강조할 핵심어"),
        cuts: z
          .array(z.object({ clip: z.number().int(), in: z.number(), out: z.number(), what: z.string().describe("이 구간에 보이는 것") }))
          .describe("이 비트에 쓸 원본 구간, 차례대로. live면 정확히 1개"),
        graphics: z.array(graphicSchema),
        sfx: z.array(z.object({ name: z.enum(sfxNames), at_word: z.string(), at: z.number() })),
      }),
    )
    .describe("비트 5~12개. 첫 비트 = 후킹"),
  visuals: z.array(visualSchema).describe("AI 이미지. 없으면 빈 배열"),
  warnings: z
    .array(z.string())
    .describe("사람이 확인할 문제만 시각과 함께: 구성품이 아닌 소품, 주의사항과 부딪히는 장면, 얼굴이 나오는 구간, 근거가 약한 말. 편집 과정이나 지시 사항은 쓰지 않는다. 없으면 빈 배열"),
});
export type EditPlan = z.infer<typeof editPlanSchema>;
export type EditBeat = EditPlan["beats"][number];
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
  return `너는 인스타그램 @${ctx.accountName}의 릴스 편집자다. ${auto ? "제품 사진을 움직인 컷, 설명 모션, 스톡 분위기 영상으로 된 소재를 보고" : "사람이 찍은 원본을 보고"}, 직접 만든 것처럼 보이는 편집 계획을 세운다. 계획은 코드가 그대로 만든다.
상품: ${f.shop} ${f.kindLabel} "${f.name}"
${ctx.liveVoice ? "이 계정은 사람이 나와 말한다. 촬영본에 말이 있는 구간은 mode live로 그대로 쓰고, 말이 없는 구간에만 tts를 쓴다." : `이 계정의 소재에는 쓸 말이 없다. 모든 비트를 mode tts로 쓴다.${ctx.tone?.trim() ? " 말투는 아래 계정 설정을 따른다." : " 계정 말투 설정이 없으니 친근한 수다체로 쓴다."}`}

순서 (스킬을 실제로 써라):
1. get_product_facts를 읽고, 프레임 묶음에서 촬영본마다 쓸 구간과 뺄 구간을 판단한다(analysis). 시각이 애매하면 look_closer로 확인한다.
2. ${hookAsk}
3. ${thumbAsk}
4. 대본과 컷: 첫 비트는 후킹이고 첫 컷은 가장 궁금한 장면이다. 그 뒤로 비트마다 한 가지만 말하고 장면과 말이 맞게 한다. 합계 15~30초.
5. 자막 · 그래픽 · 효과음을 정한다. 쓰는 말 전체를 check_ai_tone, check_rules로 점검하고 read_tts로 읽기용 원고를 확인한다.
6. look을 정한다. 아래 계정 설정과 상품 · 장면을 읽고 이 영상에 맞는 글자 디자인과 음악을 직접 만든다.${auto && ctx.scriptLines?.length ? `

점검을 통과한 대본이다. 문장을 고쳐 쓰지 말고 비트로 그대로 쓴다. 숫자와 기호만 읽는 대로 바꾼다:
${bullets(ctx.scriptLines)}` : ""}${auto ? `

소재 규칙:
- [제품컷]은 실제 제품 사진을 움직인 것이다. 사진 속 장면을 실제 사용 과정처럼 설명하지 않는다.
- [자사 촬영]은 이 상품을 직접 찍은 짧은 실제 영상이다. 소리는 없다. 손이 나와도 누군가 써 본 후기처럼 말하지 않고, 보이는 장면을 효과의 증거처럼 말하지 않는다.
- [코드 모션]은 설명 도식이다. 도식의 숫자가 나오는 시각에 맞춰 그 말을 하게 구간을 고른다.
- [스톡]은 상품과 무관한 분위기 영상이다. 공감이나 상황을 말하는 문장에만 쓰고, 스톡 장면에서 상품 기능을 말하지 않는다. 어울리는 문장이 있으면 한 번은 쓴다.` : ""}

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
- 건강기능식품 기능성 표현은 approvedClaims 문장 그대로만. 재고 · 품절 · 할인 · 배송 · 가격은 말하지 않는다.${f.kind === "COSMETIC" ? "\n- 화장품: 치료 · 재생 · 염증 같은 표현을 쓰지 않고, 효과를 단정하지 않는다." : ""}
- 제품 설명에 안전 주의가 있으면 그에 어긋나는 사용을 권하지 않고, 영상에 꼭 필요한 주의를 넣는다.
- 인사 · 자기소개 · "오늘은 ~ 소개해 드릴게요"로 시작하지 않는다. 최고 · 유일 · 100% 같은 단정을 쓰지 않는다.
- 마지막 비트에는 end_card를 넣는다. 끝맺음은 강매 없이 짧게 한다.${ctx.fixedEnding?.trim() ? `\n- 마지막 말은 사람이 정한 "${ctx.fixedEnding.trim()}"을 그대로 쓴다.` : ""}
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
    input: { product: facts.name, clips: ctx.clips.length, humanHook: ctx.humanHook ?? null, humanThumbnail: ctx.humanThumbnail ?? null },
  });
}

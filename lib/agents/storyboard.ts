import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { conceptBlock } from "@/lib/agents/concept";
import { LONG_VISUALS, graphicSchema, visualRules, visualSchema } from "@/lib/agents/edit-plan";
import { knowledgeBlock, type VideoKnowledge } from "@/lib/agents/knowledge";
import { editKit } from "@/lib/agents/ko-skills";
import type { ProductFacts } from "@/lib/agents/product-facts";
import { agentModel, runAgent, type AgentResult } from "@/lib/agents/runner";
import { writerSkills } from "@/lib/agents/script";
import { motionSchema, type MotionSpec } from "@/lib/agents/source-plan";
import { getOpenAI } from "@/lib/openai";
import { callOptions } from "@/lib/products/analysis/analyze";
import type { ContentRule } from "@/lib/rules/check";
import { lookSchema } from "@/lib/shoot/video-kit/caption-style";
import type { SkillFont } from "@/lib/shoot/video-kit/skill-fonts";
import type { createServiceClient } from "@/lib/supabase/service";
import type { VideoIssue } from "@/lib/shoot/video-kit/quality";

// 장면표 에이전트 — AI 자동 영상의 말 · 이미지 · 화면 글자를 한 번에 정한다.
// 대본을 먼저 쓰고 소재를 나중에 붙이면 말과 화면이 어긋나서, 재료를 본 뒤 장면 단위로 함께 쓴다.
// 길이는 60~85초 설명 영상이다(2026-11-06 사용자 결정): 궁금증 → 상식 → 우리 상품 → 우리 차이 → 기억할 기준.

export const AUTO_SECONDS: [number, number] = [60, 85];
// 실제 음성으로 잰 말 속도(초당 글자). 목소리마다 달라 워커가 영상마다 다시 잰다
export const DEFAULT_SPEECH_RATE = 7.4;
const MIN_SCENES = 16;
const MAX_SCENES = 30;

export function charRange(rate: number): [number, number] {
  return [Math.ceil(AUTO_SECONDS[0] * rate), Math.floor(AUTO_SECONDS[1] * rate)];
}

type Service = ReturnType<typeof createServiceClient>;

export const storyboardSchema = z.object({
  selling_point: z.string().describe("이 상품에서 시청자가 가장 끌릴 점 한 줄과 그 근거 사실"),
  story: z.string().describe("처음 보는 사람이 어떤 흐름으로 따라오게 할지 한 줄. 이 상품과 계정 설정에 맞게 정한다"),
  question_reason: z.string().describe("첫 질문의 답이 왜 이 상품의 특징이나 우리 차이로 이어지는지 한 줄"),
  photos: z
    .array(
      z.object({
        id: z.string(),
        usable: z.boolean().describe("이 상품의 실물 · 제형이 또렷하고, 사람 얼굴 · 다른 브랜드 · 잘린 글자가 없으면 true"),
        kind: z.enum(["product", "use", "texture", "scene"]).describe("product 제품 전체, use 쓰는 장면, texture 제형 질감만, scene 분위기"),
        what: z.string().describe("보이는 것 한 줄"),
        trim_top: z.number().describe("위에서 잘라 낼 비율 0~0.6"),
        trim_bottom: z.number().describe("아래에서 잘라 낼 비율 0~0.6"),
      }),
    )
    .describe("받은 후보를 모두 판단한다"),
  gifs: z
    .array(
      z.object({
        id: z.string(),
        usable: z.boolean().describe("이 상품의 실물 · 제형 · 원료 설명이 움직이고, 얼굴 · 다른 상품이 없으면 true"),
        what: z.string().describe("보이는 움직임 한 줄. 실제 촬영인지 CG인지도 쓴다"),
        crop_x: z.number().describe("쓸 구역의 왼쪽 시작 비율 0~1. 글자 · 다른 상품을 피해 잡는다"),
        crop_y: z.number().describe("쓸 구역의 위쪽 시작 비율 0~1"),
        crop_w: z.number().describe("쓸 구역의 가로 비율 0~1"),
        crop_h: z.number().describe("쓸 구역의 세로 비율 0~1"),
      }),
    )
    .describe("받은 움직이는 이미지를 모두 판단한다. 없으면 빈 배열"),
  product_first_scene: z.number().int().describe("상품 이름을 처음 말하는 장면 번호(0부터). 전체 말의 40% 안쪽이어야 한다"),
  hook: z.object({
    purpose: z.enum(["curiosity", "information"]).describe("시청자가 더 볼 이유: 궁금증 해소 또는 구체적인 정보"),
    answer: z.string().describe("후킹의 질문/약속에 본문이 제공하는 구체적인 답. 상품 근거에 있는 내용만"),
    evidence_scenes: z.array(z.number().int()).describe("실제로 그 답을 보여 주거나 설명하는 본문 장면 번호(0부터, 첫 장면 제외)"),
    spoken: z.string().describe("첫 장면에서 하는 말. 화면 표기로 쓴다"),
    on_screen: z.string().describe("첫 화면 큰 글자, spoken을 그대로 줄인 12자 안팎. 두 줄이면 줄바꿈"),
    highlight: z.string().describe("on_screen에서 강조할 낱말, 없으면 빈 문자열"),
    position: z.enum(["top", "lower"]).describe("제품을 가리지 않는 쪽"),
  }),
  scenes: z
    .array(
      z.object({
        part: z.enum(["hook", "knowledge", "product", "difference", "takeaway"]).describe("이 장면의 역할: 궁금증, 상식, 우리 상품, 우리 차이, 기억할 기준"),
        evidence: z.array(z.string()).describe("이 장면의 사실 근거. 상식 카드 K1, 우리 차이 D1, 상품 자료 P. 사실이 없는 연결 문장은 빈 배열"),
        source: z.enum(["photo", "gif", "archive", "visual", "motion"]).describe("photo 사진 후보, gif 움직이는 이미지, archive 자사 촬영 컷, visual AI 이미지, motion 코드로 그리는 설명 화면"),
        source_id: z.string().describe("쓸 후보 번호 p1 · g1 · a1. visual · motion이면 빈 문자열"),
        motion: motionSchema.nullable().describe("source가 motion이면 설명 화면 값, 아니면 null"),
        shows: z.string().describe("이 장면에서 시청자가 보는 것"),
        say: z.string().describe("이 장면의 말을 화면 표기로. 첫 장면은 hook.spoken과 같다"),
        tts: z.string().describe("say를 읽는 대로 바꾼 원고. 숫자와 영문을 말하는 대로"),
        captions: z.array(z.string()).describe("say를 의미 단위로 나눈 자막, 한 묶음 16자 이내. 이어 붙이면 say와 같아야 한다. 첫 장면은 빈 배열"),
        emphasis: z.array(z.string()).describe("자막에서 강조할 핵심어"),
        graphics: z.array(graphicSchema).describe("말에 맞춰 나오는 작은 그래픽, 없으면 빈 배열. 첫 장면은 빈 배열. 마지막 장면에는 end_card 하나"),
      }),
    )
    .describe("장면 20~26개가 기본, 합계 60~85초. 첫 장면 = 후킹"),
  visuals: z.array(visualSchema).describe("source가 visual인 장면의 AI 이미지. beat는 장면 번호(0부터). 없으면 빈 배열"),
  thumbnail: z.object({
    title: z.string().describe("표지 글자 8자 안팎"),
    highlight: z.string(),
    position: z.enum(["top", "lower"]),
    sub: z.string(),
    scene: z.number().int().describe("표지로 쓸 장면 번호(0부터)"),
  }),
  caption: z.object({
    text: z.string().describe("캡션 전체 — 첫 줄(40자 이내) · 본문 · 요청 하나 · 해시태그 3개"),
    keywords: z.array(z.string()).describe("찾히고 싶은 검색어 2~4개"),
  }),
  look: lookSchema,
  key_font: z.string().describe("큰 강조어 글꼴. 쓸 수 있는 글꼴 목록의 이름 그대로. 목록이 없으면 빈 문자열"),
  small_font: z.string().describe("작은 줄 글꼴. 쓸 수 있는 글꼴 목록의 이름 그대로. 목록이 없으면 빈 문자열"),
});
export type Storyboard = z.infer<typeof storyboardSchema>;

export interface StoryboardContext {
  service: Service | null;
  readService?: Service;
  planId?: string;
  accountName: string;
  roleFocus?: string | null;
  facts: ProductFacts;
  rules: ContentRule[];
  candidates: { id: string; w: number; h: number }[];
  sheets: string[];
  archive: { id: string; what: string; seconds: number }[];
  archiveSheets: string[];
  gifs?: { id: string; w: number; h: number; seconds: number }[];
  gifSheets?: string[];
  knowledge: VideoKnowledge;
  charLimits: [number, number];
  concept?: string | null;
  tone?: string | null;
  videoStyle?: string | null;
  phraseBlock?: string;
  visualLibrary?: { key: string; subject: string }[];
  fontChoices?: SkillFont[];
  retry?: { board: Storyboard; problems: string[] } | null;
}

const bullets = (lines: string[]) => lines.map((l) => `- ${l}`).join("\n");

/** 설명 화면에 들어가는 글. 근거 · 금지 표현 점검에 넣는다. */
export function motionTexts(m: MotionSpec): string[] {
  return [m.title, m.left_label, m.right_label, m.left_value, ...m.right_values, m.number_to ? `${m.number_to}${m.unit}` : "", m.end_text, ...m.items, m.big ? `${m.big}${m.unit}` : ""].filter(Boolean);
}

function motionEmpty(m: MotionSpec | null): boolean {
  return !m || (m.kind === "steps" && !m.items.some((t) => t.trim())) || (m.kind === "big_fact" && !m.big.trim()) || (m.kind === "compare" && !m.left_value.trim() && !m.right_values.some((t) => t.trim())) || (m.kind === "count" && !m.number_to);
}

export async function writeStoryboard(ctx: StoryboardContext): Promise<AgentResult<Storyboard>> {
  const f = ctx.facts;
  const kit = editKit();
  const system = `너는 인스타그램 @${ctx.accountName} 릴스의 작가 겸 편집자다. 사람이 나오지 않는 60~85초 설명 영상의 장면표를 쓴다. 말과 화면을 장면마다 함께 정한다.
시청자가 궁금한 상식을 배우고, 이 상품이 무엇이고 무엇이 들어 있으며 무엇이 다른지까지 알게 하는 영상이다.
상품: ${f.shop} ${f.kindLabel} "${f.name}"
계정 역할: ${ctx.roleFocus === "PERSON" ? "사람 중심" : ctx.roleFocus === "PRODUCT" ? "상품 중심" : "미정"}

순서:
1. get_product_facts와 근거 자료를 읽고 받은 이미지 · 움직이는 이미지를 모두 본다. 무엇을 보여 줄 수 있는지 먼저 판단한다.
2. 답이 이 상품의 특징이나 우리 차이로 이어지는 질문을 고른다(question_reason). 상품과 상관없는 일반 상식에서 시작해 상품을 끼워 넣지 않는다.
3. 아래 구조로 장면을 나누고, 장면마다 화면 하나와 그 화면을 보며 할 말을 정한다. check_rules로 금지 표현을 확인한다.
4. 게시물 캡션은 check_caption으로 검사하고 경고를 고친다. 첫 40자에 상품의 짧은 이름과 주제를 넣고, 검색어는 해시태그 외 본문에도 쓴다. 행동 요청은 저장 등 하나만, 구매 유도는 필요 없다.

구조와 분량(계정 설정에 적힌 길이나 "질문 하나" 같은 문구보다 이 기준이 먼저다):
- 말 전체(tts를 이어 붙인 글자, 띄어쓰기 제외)는 ${ctx.charLimits[0]}~${ctx.charLimits[1]}자. 음성으로 60~85초다.
- 장면은 20~26개가 기본. 한 장면은 2~4초(약 15~28자)이고, 한 장면에 말 한 가지만 담는다.
- hook(첫 3초): 사실이면서 의외인 한 문장. 영상 끝까지 끌고 갈 질문이다.
- knowledge(25~35%): 왜 그런지 쉬운 말과 비유로 설명한다. 낯선 단어는 바로 뜻을 붙이고, 이름만 나열하지 않는다.
- product(25~30%): 앞의 상식이 이 상품에서 어떻게 나타나는지. 성분이면 전성분 표기, 과일이면 품종 · 산지 · 먹는 법까지 구체적으로.
- difference(15~20%): 담당자가 확정한 우리 차이를 비교 대상과 함께 말한다. 확정된 차이가 없으면 이 구간을 쓰지 않고 product와 takeaway를 늘리며, 우리가 다르다는 말을 하지 않는다.
- takeaway(끝 5초): 다음에 고를 때 쓸 기준 한 줄. 저장할 이유가 된다.
- 8~12초마다 "그럼 왜", "근데" 같은 다음 궁금증 문장을 넣어 흐름을 잇는다. 강의처럼 사실을 늘어놓지 않는다.
- 첫 장면 화면에 상품이나 질문의 대상을 보여 주고, 상품 이름은 전체 말의 40% 안쪽에서 말한다. product_first_scene에 그 장면 번호를 쓴다.
- 장면마다 evidence를 채운다. 상식 문장은 상식 카드(K1...)나 상품 자료(P)에 있어야 하고, 우리 차이는 D1...만 쓴다.

글:
- 소리 내어 읽었을 때 말이 되어야 한다. 처음 보는 사람이 상품이 무엇인지 알아듣고, 앞 문장에 이어 다음 문장을 자연스럽게 듣게 쓴다.
- 첫 문장은 시청자가 궁금해할 말이어야 한다. 용량 · 가격 같은 숫자는 그 자체로 궁금증이 아니면 첫 문장에 넣지 않는다.
- 후킹은 궁금증 또는 정보라는 목적이 분명해야 한다. hook.answer에 실제 답을 적고 evidence_scenes에서 중간까지 그 답을 회수한다. 빈 호기심/끝까지 보라는 명령, 답 없이 상품 소개만 반복하는 흐름은 쓰지 않는다.
- 제형/거품/사용 결과를 '보라'는 후킹은 실제 제형/사용 컷이 있을 때만 쓴다. 용기 사진과 AI 그림/도식은 실물 증거가 아니다. 재료가 포장 사진뿐이면 포장에 보이는 구분점이나 근거가 있는 사용 순서 등 답할 수 있는 질문을 고른다.
- 체감/촉감/흡수 속도를 용기 사진으로 입증하지 않는다. 상세페이지의 설명을 전달할 때는 '제품 안내에서는'이라고 출처를 밝힌다.
- 장면에 없는 것을 말하지 않는다. 말하는 내용이 보이는 이미지를 고른다.
- 사실(숫자 · 성분 · 효과 · 구성)은 get_product_facts와 근거 자료에 있는 것만. 없는 상식을 지어내지 않는다. uncertainties에 있는 건 말하지 않는다.
- 상식 카드의 원료 설명은 원료의 뜻이다. 이 제품의 효과처럼 잇지 않는다. "그래서 피부가 좋아져요" 같은 결론을 쓰지 않는다.
- 사람이 써 본 것처럼 말하지 않는다. 지어낸 후기 · 체험을 쓰지 않는다. 최고 · 유일 · 100% 같은 단정을 쓰지 않는다.
- 건강기능식품 기능성 표현은 approvedClaims 문장 그대로만. 비어 있으면 기능성을 말하지 않는다.${f.kind === "COSMETIC" ? "\n- 화장품: 치료 · 재생 · 염증 같은 표현을 쓰지 않는다. 캡션에 개인차가 있음을 밝힌다." : ""}
- 판매 상태(재고 · 할인 · 배송)는 말하지 않는다. 인사 · 자기소개로 시작하지 않는다.
- 요청은 끝에 하나만 한다.

화면:
- 장면 예산: 상품 사진 · 움직이는 이미지 · 자사 촬영 약 40%, AI 이미지 약 35%, 코드 설명 화면은 25% 이하. 같은 종류 화면이 8초 넘게 이어지지 않게 섞는다.
- usable인 후보만 쓴다. 첫 장면은 제품이나 가장 궁금한 장면이다. texture(질감만 있는 사진)는 무엇인지 말로 설명할 때 한 번만 쓰고 첫 장면에 쓰지 않는다.
- product · difference 구간은 실제 사진 · 움직이는 이미지 · 자사 촬영으로 보여 준다. 상식 구간은 AI 이미지와 설명 화면을 쓴다.
- 같은 후보는 세 번까지, 연달아 쓰지 않는다. 자사 촬영 컷이 있으면 사진보다 먼저 고르고 후보마다 한 번만 쓴다.
- 인증서 · 표 · 그래프, 이 상품이 아닌 물건, 잘라 낼 수 없는 글자가 있으면 usable false. 위아래 글자 띠는 trim으로 잘라 낸다.
- 움직이는 이미지는 crop으로 글자와 다른 상품을 피해 움직임이 보이는 구역만 고른다. 얼굴이 있거나 다른 상품과 섞여 피할 수 없으면 usable false. CG 연출은 실제 시연이나 효과의 증거처럼 말하지 않는다.
- 다른 제품과 나란히 비교한 장면은 담당자가 확정한 우리 차이(D)와 같은 내용일 때만 쓴다. 그 외에는 usable false.
- source가 visual인 장면은 visuals에 같은 beat의 그림을 하나 넣는다. 그림을 못 만들면 상품 사진이 대신 나간다.
- 순서 · 구성 · 비교 · 숫자를 말하는 장면은 source를 motion으로 해 코드로 그린 설명 화면을 쓸 수 있다. 첫 · 마지막 장면에는 쓰지 않고, 두 장면 연달아 쓰지 않는다. 값은 근거 자료에 있는 것만 쓰고, 글자는 짧게, 색은 상품과 계정 분위기에 맞춘다.

자막과 그래픽:
${bullets(kit.caption_rules)}
- 그래픽은 그 말을 할 때 나오게 at_word를 그 장면 말 속의 낱말로 쓴다. 자막과 같은 말을 되풀이하지 않는다.

읽기용 원고(tts):
${bullets(kit.tts_rules)}

글자 디자인(look):
${bullets(kit.look_rules)}${ctx.fontChoices?.length ? `\n\n글꼴: 이 영상의 제품 · 말의 내용 · 계정 분위기에 맞게 강조어 글꼴(key_font)과 작은 줄 글꼴(small_font)을 아래에서 하나씩 고른다. 습관처럼 같은 글꼴을 고르지 않는다. 자막은 짧게 지나가므로 한 번에 읽혀야 한다.\n${ctx.fontChoices.map((x) => `- ${x.name} · ${x.role} · ${x.look}`).join("\n")}` : ""}${visualRules(f.kind, ctx.visualLibrary ?? [], LONG_VISUALS)}${conceptBlock("이 계정의 AI 자동 업로드 컨셉", ctx.concept, "무엇을 말할지와 흐름에 반영한다.")}${conceptBlock("이 계정의 말투 · 분위기", ctx.tone, "말과 글자 디자인 · 음악에 반영한다.")}${conceptBlock("이 계정의 영상 스타일", ctx.videoStyle, "장면 고르기에 반영한다.")}${ctx.phraseBlock ?? ""}`;
  const gifs = ctx.gifs ?? [];
  const user = `상세페이지 원문(상품 사실은 이 안에서만 쓴다. "원료적 특성에 한함" 같은 단서가 붙은 내용은 말로 읽지 않고 표현을 낮춰 쓴다):\n${f.sourceText}\n\n${knowledgeBlock(ctx.knowledge)}\n\n쓸 수 있는 사진 후보(가로x세로): ${ctx.candidates.map((c) => `${c.id} ${c.w}x${c.h}`).join(", ")}
그림은 후보를 번호와 함께 모은 것이다. 위 목록에 없는 번호는 화질이 낮거나 세로 화면에서 제품이 잘려 쓰지 않는다.${gifs.length ? `\n\n움직이는 이미지(사진 묶음 다음 그림부터 차례로, 그림마다 왼쪽부터 시간 순서로 프레임 6개):\n${gifs.map((g) => `${g.id} 원본 ${g.w}x${g.h}, ${g.seconds.toFixed(1)}초`).join("\n")}` : ""}${ctx.archive.length ? `\n\n자사 촬영 컷(소리 없음, 순서대로 마지막 ${ctx.archive.length}장의 그림이 컷마다 프레임 3개):\n${ctx.archive.map((a) => `${a.id} ${a.seconds.toFixed(1)}초 — ${a.what}`).join("\n")}` : ""}${
    ctx.retry
      ? `\n\n먼저 쓴 장면표:\n${JSON.stringify({ hook: ctx.retry.board.hook, scenes: ctx.retry.board.scenes.map((s) => ({ part: s.part, source: s.source, source_id: s.source_id, say: s.say })), visuals: ctx.retry.board.visuals.map((v) => ({ beat: v.beat, subject: v.subject })) })}\n\n이 문제를 고쳐 전체를 다시 내라:\n${bullets(ctx.retry.problems)}`
      : ""
  }`;
  return runAgent({
    agent: "plan",
    system,
    user,
    userImages: [...ctx.sheets, ...(ctx.gifSheets ?? []), ...ctx.archiveSheets],
    skills: writerSkills({ facts: ctx.facts, rules: ctx.rules, accountName: ctx.accountName }).filter((s) => ["get_product_facts", "time_script", "check_rules", "check_caption"].includes(s.name)),
    outputSchema: storyboardSchema,
    outputName: "storyboard",
    maxSteps: 14,
    service: ctx.service,
    readService: ctx.readService,
    planId: ctx.planId,
    input: { product: f.name, candidates: ctx.candidates.length, gifs: gifs.length, archive: ctx.archive.length, cards: ctx.knowledge.cards.map((c) => c.ref), differences: ctx.knowledge.differences.map((d) => d.ref), retry: ctx.retry?.problems ?? [] },
  });
}

const squash = (t: string) => t.replace(/[\s.,!?~·…'"]+/g, "");

/** 코드로 확인할 수 있는 문제. */
export function storyboardProblems(b: Storyboard, archiveIds: string[], fixedHook: boolean, opts: { knowledge: VideoKnowledge; charLimits: [number, number] }): string[] {
  const out: string[] = [];
  const usable = new Map(b.photos.filter((p) => p.usable).map((p) => [p.id, p]));
  const usableGifs = new Set(b.gifs.filter((g) => g.usable).map((g) => g.id));
  if (b.scenes.length < MIN_SCENES || b.scenes.length > MAX_SCENES) out.push(`장면이 ${b.scenes.length}개다. ${MIN_SCENES}~${MAX_SCENES}개로 쓴다`);
  const sizes = b.scenes.map((s) => squash(s.tts).length);
  const chars = sizes.reduce((a, n) => a + n, 0);
  if (chars < opts.charLimits[0] || chars > opts.charLimits[1]) out.push(`말이 ${chars}자다. 음성 60~85초에 맞게 ${opts.charLimits[0]}~${opts.charLimits[1]}자로 쓴다`);
  const validRefs = new Set(["P", ...opts.knowledge.cards.map((c) => c.ref), ...opts.knowledge.differences.map((d) => d.ref)]);
  const hasDifferences = opts.knowledge.differences.length > 0;
  const firstName = b.product_first_scene;
  if (!Number.isInteger(firstName) || firstName < 0 || firstName >= b.scenes.length) out.push("product_first_scene이 올바른 장면 번호가 아니다");
  else if (chars > 0 && sizes.slice(0, firstName).reduce((a, n) => a + n, 0) / chars > 0.4) out.push(`상품 이름이 ${firstName}번 장면에서야 나온다. 전체 말의 40% 안쪽에서 말한다`);
  const realScenes = b.scenes.filter((s) => (s.part === "product" || s.part === "difference") && ["photo", "gif", "archive"].includes(s.source));
  if (realScenes.length < 2) out.push("우리 상품 · 우리 차이 구간에는 실제 사진 · 움직이는 이미지 · 자사 촬영을 2장면 이상 쓴다");
  const differenceScenes = b.scenes.filter((s) => s.part === "difference");
  if (hasDifferences && !differenceScenes.length) out.push("확정된 우리 차이가 있는데 difference 장면이 없다");
  if (!hasDifferences && differenceScenes.length) out.push("확정된 우리 차이가 없으니 difference 장면을 쓰지 않는다");
  if (!b.scenes.some((s) => s.part === "knowledge")) out.push("상식(knowledge) 장면이 없다");
  if (b.scenes[b.scenes.length - 1]?.part !== "takeaway") out.push("마지막 장면은 기억할 기준(takeaway)으로 끝낸다");
  const motions = b.scenes.filter((s) => s.source === "motion").length;
  if (b.scenes.length && motions / b.scenes.length > 0.25) out.push(`설명 화면이 ${motions}개로 많다. 전체의 25% 이하로 줄이고 사진 · AI 이미지로 바꾼다`);
  const uses = new Map<string, number>();
  b.scenes.forEach((s, i) => {
    for (const r of s.evidence) if (!validRefs.has(r)) out.push(`${i}번 장면의 근거 ${r}는 받은 자료에 없다`);
    if (s.part === "difference" && !s.evidence.some((r) => r.startsWith("D"))) out.push(`${i}번 장면은 우리 차이인데 확정된 차이(D) 근거가 없다`);
    if (s.source === "photo" && !usable.has(s.source_id)) out.push(`${i}번 장면의 ${s.source_id}는 쓸 수 있는 후보가 아니다`);
    if (s.source === "gif" && !usableGifs.has(s.source_id)) out.push(`${i}번 장면의 ${s.source_id}는 쓸 수 있는 움직이는 이미지가 아니다`);
    if (s.source === "visual" && !b.visuals.some((v) => v.beat === i)) out.push(`${i}번 장면에 AI 이미지 설명(visuals)이 없다`);
    if (s.source === "visual" && (i === 0 || i === b.scenes.length - 1)) out.push("첫 · 마지막 장면에는 AI 이미지를 쓰지 않는다");
    if (s.source === "motion" && i > 0 && b.scenes[i - 1].source === "motion") out.push(`${i}번 장면이 설명 화면을 연달아 쓴다`);
    if (s.source === "motion" && i === b.scenes.length - 1) out.push("마지막 장면은 설명 화면으로 쓰지 않는다");
    if (s.source === "archive" && !archiveIds.includes(s.source_id)) out.push(`${i}번 장면의 ${s.source_id}는 없는 자사 촬영 컷이다`);
    if (s.source === "motion" && motionEmpty(s.motion)) out.push(`${i}번 장면에 도식 값이 없다`);
    if (s.source === "motion" && i === 0) out.push("첫 장면은 설명 화면으로 쓰지 않는다");
    uses.set(s.source_id, (uses.get(s.source_id) ?? 0) + 1);
    if (i > 0 && s.source_id && b.scenes[i - 1].source_id === s.source_id) out.push(`${i}번 장면이 앞 장면과 같은 이미지다`);
    if (!s.say.trim() || !s.tts.trim()) out.push(`${i}번 장면에 말이 없다`);
  });
  for (const [id, n] of uses) if (id && n > 3) out.push(`${id}를 ${n}번 썼다. 세 번까지만 쓴다`);
  const textures = b.scenes.filter((s) => usable.get(s.source_id)?.kind === "texture");
  if (textures.length > 1) out.push("질감만 있는 사진을 한 번만 쓴다");
  if (b.scenes[0] && usable.get(b.scenes[0].source_id)?.kind === "texture") out.push("첫 장면에 질감만 있는 사진을 쓰지 않는다");
  if (new Set(b.scenes.map((s, i) => s.source_id || `${s.source}${i}`)).size < 8) out.push("서로 다른 화면을 8개 이상 쓴다");
  // 후킹 글자는 말을 줄인 것이어야 한다. 글자의 절반 이상이 말에 없으면 다른 말이다
  if (!fixedHook) {
    const spoken = squash(b.hook.spoken);
    const words = b.hook.on_screen.split(/\s+/).map(squash).filter(Boolean);
    const seen = words.filter((w) => spoken.includes(w)).length;
    if (words.length && seen / words.length < 0.5) out.push(`후킹 화면 글자 "${b.hook.on_screen}"가 말 "${b.hook.spoken}"과 다르다. 말을 그대로 줄여 쓴다`);
  }
  return out;
}

const reviewSchema = z.object({
  problems: z.array(z.string()).describe("고쳐야 할 문제. 어느 장면의 어떤 말인지 구체적으로. 없으면 빈 배열"),
  unsuitable_phrases: z.array(z.object({ kind: z.enum(["hook", "ending"]), reason: z.string() })).describe("소재/내용과 맞지 않아 교체해야 하는 저장 후킹 또는 마지막 문구. 그 외 문제는 problems에 쓴다"),
});

/** 처음 보는 시청자처럼 읽는다. 점수가 아니라 말이 되는지, 이어지는지, 끌리는지를 본다. */
export async function reviewStoryboard(input: { board: Storyboard; facts: ProductFacts; knowledge: VideoKnowledge; sheets: string[]; fixedTexts: string[] }): Promise<{ problems: string[]; unsuitable_phrases: { kind: "hook" | "ending"; reason: string }[]; tokens: { input: number; output: number } }> {
  const b = input.board;
  const model = agentModel();
  const completion = await getOpenAI().chat.completions.parse({
    model,
    ...callOptions(model, 3000),
    messages: [
      {
        role: "system",
        content: `너는 인스타 릴스를 넘겨 보는 평범한 시청자이자 깐깐한 편집장이다. 장면표를 읽고 실제로 문제가 되는 것만 적는다. 말투 취향이나 사소한 표현은 적지 않는다.
- 첫 문장: 소리 내어 읽었을 때 말이 되는가, 다음이 궁금한가, 뜬금없는 숫자나 명령이 없는가.
- 흐름: 처음 보는 사람이 이게 뭔지 알아듣는가, 앞 문장에서 다음 문장으로 이어지는가, 강의처럼 사실만 나열하다 끝나지 않는가. 긴 영상이니 8~12초마다 다음이 궁금해지는가.
- 이해: 다 보고 나면 무슨 상품인지, 성분이나 품종이 무슨 뜻인지 말할 수 있는가. 확정된 우리 차이가 있으면 무엇이 다른지도 말할 수 있는가. 낯선 단어를 뜻 없이 넘기지 않는가.
- 상식과 효과: 원료 설명을 이 제품의 효과처럼 잇지 않는가.
- 화면: 그 장면 이미지가 그 말과 맞는가.
- 정보 가치: 후킹이 약속한 답이 구체적인가. 상품 이름과 장점만 나열하며 답을 피하지 않는가. 근거 있는 사용법/구분 정보로 답하는 영상은 허용한다.
후킹의 질문에 본문이 실제로 답하는지, hook.answer와 evidence_scenes가 그 답과 맞는지 확인한다. '보라'고 약속한 제형/사용 장면은 실물이 있어야 한다. 상품 설명을 전하는 도식은 허용하되 체험의 증거로 보지 않는다.
${input.fixedTexts.length ? `저장된 문구도 근거/소재/답 회수 검수에서 제외하지 않는다. 맞지 않으면 unsuitable_phrases에 종류와 이유를 쓴다. 첫 문장은 hook, 마지막 문장은 ending이다. 정상 후킹을 마지막 문구 때문에 교체하지 않는다: ${input.fixedTexts.join(" / ")}` : ""}`,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `상품: ${input.facts.name} — ${input.facts.oneLine ?? ""}\n상품 근거: ${input.facts.claims.map((c) => c.claim).join(" / ")}\n상세페이지 원문:\n${input.facts.sourceText}\n\n${knowledgeBlock(input.knowledge)}\n\n질문을 고른 이유: ${b.question_reason}\n\n후킹 화면 글자: ${b.hook.on_screen.replace(/\n/g, " ")}\n장면:\n${b.scenes.map((s, i) => `${i}. (${s.part}) [${b.visuals.find((v) => v.beat === i) ? `AI 그림: ${b.visuals.find((v) => v.beat === i)!.subject}` : `${s.source_id}: ${b.photos.find((p) => p.id === s.source_id)?.what ?? b.gifs.find((g) => g.id === s.source_id)?.what ?? s.shows}`}] ${s.say}`).join("\n")}\n\n그림은 후보 이미지 묶음이다.`,
          },
          { type: "text", text: `후킹 약속과 답/근거 장면: ${JSON.stringify(b.hook)}` },
          ...input.sheets.map((url) => ({ type: "image_url" as const, image_url: { url, detail: "high" as const } })),
        ],
      },
    ],
    response_format: zodResponseFormat(reviewSchema, "storyboard_review"),
  });
  return {
    problems: (() => { const parsed = completion.choices[0]?.message?.parsed; if (!parsed) throw new Error("장면표 검수 응답이 없어요"); return parsed.problems; })(),
    unsuitable_phrases: completion.choices[0]!.message.parsed!.unsuitable_phrases,
    tokens: { input: completion.usage?.prompt_tokens ?? 0, output: completion.usage?.completion_tokens ?? 0 },
  };
}

const firstViewerAnswerSchema = z.object({
  product: z.string().describe("무슨 상품인지. 영상만 봐서 모르겠으면 빈 문자열"),
  meaning: z.string().describe("설명한 성분이나 품종이 무슨 뜻인지. 모르겠으면 빈 문자열"),
  difference: z.string().describe("다른 것과 무엇이 다르다고 했는지. 말하지 않았으면 빈 문자열"),
  takeaway: z.string().describe("다음에 고를 때 볼 기준. 모르겠으면 빈 문자열"),
});
export type FirstViewerAnswer = z.infer<typeof firstViewerAnswerSchema>;

/** 처음 보는 사람 시험. 상품 자료 없이 영상의 화면과 말만 주고 답하게 한 뒤, 빠진 항목을 코드가 적는다. 판단의 기준이 아니라 사람이 볼 경고다. */
export async function firstViewerTest(input: { sheet: string; lines: string[]; hasDifference: boolean }): Promise<{ answer: FirstViewerAnswer; gaps: string[]; tokens: { input: number; output: number } }> {
  const model = agentModel();
  const completion = await getOpenAI().chat.completions.parse({
    model,
    ...callOptions(model, 800),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `이 상품을 처음 보는 사람으로서, 아래 릴스의 화면과 말만 보고 답한다. 모르는 것은 추측하지 말고 빈 문자열로 둔다.\n말:\n${input.lines.join("\n")}` },
          { type: "image_url", image_url: { url: input.sheet, detail: "high" } },
        ],
      },
    ],
    response_format: zodResponseFormat(firstViewerAnswerSchema, "first_viewer"),
  });
  const answer = completion.choices[0]?.message?.parsed;
  if (!answer) throw new Error("처음 보는 사람 시험 응답이 없어요");
  const gaps = [
    !answer.product.trim() ? "무슨 상품인지" : "",
    !answer.meaning.trim() ? "성분이나 품종의 뜻" : "",
    input.hasDifference && !answer.difference.trim() ? "우리 차이" : "",
    !answer.takeaway.trim() ? "기억할 기준" : "",
  ].filter(Boolean);
  return { answer, gaps, tokens: { input: completion.usage?.prompt_tokens ?? 0, output: completion.usage?.completion_tokens ?? 0 } };
}

/** 완성본 프레임을 본다. 얹은 자막까지 들어간 실제 화면 검사다. */
export async function reviewFinalFrames(input: { sheet: string; frames: { at: number; image: string }[]; lines: { at: number; say: string }[]; everySeconds: number }): Promise<{ issues: VideoIssue[]; tokens: { input: number; output: number } }> {
  const model = agentModel();
  const completion = await getOpenAI().chat.completions.parse({
    model,
    ...callOptions(model, 1500),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `완성된 릴스의 프레임이다. 첫 이미지는 ${input.everySeconds.toFixed(1)}초 간격 연락판(왼쪽→오른쪽, 위→아래), 뒤는 휴대폰 크기 개별 프레임 ${input.frames.map((f) => f.at.toFixed(2)).join(", ")}초다. 말 시각표:\n${input.lines.map((l) => `${l.at.toFixed(1)}초 ${l.say}`).join("\n")}\n\n실제 문제만 시각과 함께 적는다. kind: caption=작거나 잘리거나 읽기 어려운 자막, layout=텍스트끼리 겹침/상품을 크게 가림, crop=제품의 중요한 부분이 잘림/지나친 확대, content=말과 소재/후킹 약속 불일치, blank=알아볼 수 없는 빈 화면. severity blocking은 시청/이해를 막는 문제, minor는 작은 개선점이다. 시연을 약속하지 않는 제품 소개에 포장 사진을 쓰는 것은 허용한다. 제품 사진 속 작은 인쇄 글자를 못 읽는 것은 자막 오류가 아니다. 전환 도중 한 장만 글자가 안 보이는 것은 오류로 적지 않는다. 없으면 빈 배열.`,
          },
          { type: "image_url", image_url: { url: input.sheet, detail: "high" } },
          ...input.frames.map((f) => ({ type: "image_url" as const, image_url: { url: f.image, detail: "high" as const } })),
        ],
      },
    ],
    response_format: zodResponseFormat(z.object({ issues: z.array(z.object({ kind: z.enum(["caption", "layout", "crop", "content", "blank"]), severity: z.enum(["blocking", "minor"]), at: z.number(), detail: z.string() })) }), "final_review"),
  });
  return {
    issues: (() => { const parsed = completion.choices[0]?.message?.parsed; if (!parsed) throw new Error("완성본 검수 응답이 없어요"); return parsed.issues; })(),
    tokens: { input: completion.usage?.prompt_tokens ?? 0, output: completion.usage?.completion_tokens ?? 0 },
  };
}

/** 저장 후킹도 실제로 보여 줄 수 있는 재료로 먼저 거른다. DB 설정 문구 자체는 바꾸지 않는다. */
export async function reviewHookMaterials(input: { hooks: string[]; sheets: string[]; archive: string[]; facts: ProductFacts }) {
  if (!input.hooks.length) return { rejected: [] as { index: number; why: string }[], tokens: { input: 0, output: 0 } };
  const model = agentModel();
  const completion = await getOpenAI().chat.completions.parse({
    model, ...callOptions(model, 1600),
    messages: [{ role: "user", content: [
      { type: "text", text: `다음 저장 후킹 전부를 실제 영상 소재와 대조한다. 이미지에 없는 제형/사용법/체감/소리를 보여 준다는 약속은 부적합이다. 용기 사진과 상세페이지의 장식 거품/AI 이미지는 실제 제형 시연이 아니다. 근거에 있는 사용 순서/구성/용기의 구분점을 설명하는 정보 후킹은 사진+도식으로 답할 수 있다. 주어진 자료로 본문에서 구체적인 답을 낼 수 있어야 한다. 과도하게 거부하지 말고 소재상 불가능한 문구만 rejected에 번호와 이유를 쓴다.\n상품 근거: ${JSON.stringify({ name: input.facts.name, usage: input.facts.usage, details: input.facts.details })}\n자사 촬영: ${input.archive.join(" / ") || "없음"}\n후킹:\n${input.hooks.map((t, i) => `${i}: ${t}`).join("\n")}` },
      ...input.sheets.map((url) => ({ type: "image_url" as const, image_url: { url, detail: "high" as const } })),
    ] }],
    response_format: zodResponseFormat(z.object({ rejected: z.array(z.object({ index: z.number().int(), why: z.string() })) }), "hook_materials"),
  });
  const parsed = completion.choices[0]?.message?.parsed;
  if (!parsed) throw new Error("후킹 소재 검수 응답이 없어요");
  return { ...parsed, tokens: { input: completion.usage?.prompt_tokens ?? 0, output: completion.usage?.completion_tokens ?? 0 } };
}

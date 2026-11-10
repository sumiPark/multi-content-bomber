import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { conceptBlock } from "@/lib/agents/concept";
import { LONG_VISUALS, graphicSchema, sfxNames, visualRules, visualSchema, type EditVisual } from "@/lib/agents/edit-plan";
import { COMMON_KNOWLEDGE_REF, evidenceRef, knowledgeBlock, type VideoKnowledge } from "@/lib/agents/knowledge";
import { editKit } from "@/lib/agents/ko-skills";
import type { ProductFacts } from "@/lib/agents/product-facts";
import { EMPTY_REFERENCES, referenceBlock, type ReelReferences } from "@/lib/agents/reel-references";
import { agentModel, runAgent, type AgentResult } from "@/lib/agents/runner";
import { writerSkills } from "@/lib/agents/script";
import { motionSchema, type MotionSpec } from "@/lib/agents/source-plan";
import { getOpenAI } from "@/lib/openai";
import { callOptions } from "@/lib/products/analysis/analyze";
import type { ContentRule } from "@/lib/rules/check";
import { lookSchema } from "@/lib/shoot/video-kit/caption-style";
import { FONT_PAIRING_RULES, fontChoiceLines, type SkillFont } from "@/lib/shoot/video-kit/skill-fonts";
import type { createServiceClient } from "@/lib/supabase/service";
import type { VideoIssue } from "@/lib/shoot/video-kit/quality";

// 장면표 에이전트 — AI 자동 영상의 말 · 이미지 · 화면 글자를 한 번에 정한다.
// 대본을 먼저 쓰고 소재를 나중에 붙이면 말과 화면이 어긋나서, 재료를 본 뒤 장면 단위로 함께 쓴다.
// 대본 방식은 하나다(상식형 · 이야기형을 합침, 계정별 선택 없음 — 2026-11-10 사용자 결정).
// 주제 · 첫 문장은 성과가 높았던 릴스(다른 계정 · 우리 계정)에서 가져오고, 없으면 상품군의 일반 상식에서 고른다. 상세페이지는 상품 사실 확인에만 쓴다.
// 정해진 첫 문장 틀 · 장면 순서 · 상품 이름 위치 · 마지막 한 줄 · 저장 요청은 두지 않는다. 고정하고 싶은 규칙은 관리자가 계정 설정 "바꾸고 싶은 점"에 적는다.
// 말하는 사람은 기본이 시청자에게 말 거는 사람이고 "저희"(브랜드)도 쓸 수 있다. 저희가 했다는 내용은 상품 자료에 있는 것만. 지어낸 인물 · 체험은 쓰지 않는다.
// 길이는 내용이 정하고, 1분을 채우려고 늘리지 않는다(2026-11-06 사용자 결정).

export const AUTO_SECONDS: [number, number] = [30, 85];
// 실제 음성으로 잰 말 속도(초당 글자). 목소리마다 달라 워커가 영상마다 다시 잰다
export const DEFAULT_SPEECH_RATE = 7.4;
const MIN_SCENES = 9;
// 같은 말끝이 이만큼 반복되면 사전을 읽는 것처럼 들린다
const MAX_SAME_ENDING = 3;
export const MIN_INTEREST = 3;
export const MIN_AUTO_HOOK_SCORE = 50;

/** 문장 끝 말투. 같은 말끝의 반복을 잡을 때 쓴다. */
export function sentenceEnding(say: string): string {
  return say.replace(/[\s.,!?~…'"]+$/g, "").replace(/\s+/g, "").slice(-5);
}
const MAX_SCENES = 30;

export function charRange(rate: number): [number, number] {
  return [Math.ceil(AUTO_SECONDS[0] * rate), Math.floor(AUTO_SECONDS[1] * rate)];
}

type Service = ReturnType<typeof createServiceClient>;

export const storyboardSchema = z.object({
  selling_point: z.string().describe("이 상품에서 시청자가 가장 끌릴 점 한 줄과 그 근거 사실"),
  story: z.string().describe("처음 보는 사람이 어떤 흐름으로 따라오게 할지 한 줄. 이 상품과 계정 설정에 맞게 정한다"),
  question_reason: z.string().describe("첫 장면이 연 궁금증의 답이 왜 이 상품의 특징이나 우리 차이로 이어지는지 한 줄"),
  situation: z.string().describe("첫 장면(후킹)이 여는 것 한 줄: 시청자가 멈출 질문 · 의외의 사실 · 장면"),
  worry: z.string().describe("시청자가 궁금해하거나 잘못 알고 있거나 불편해하는 점 한 줄"),
  one_thing: z.string().describe("시청자가 이 영상에서 얻어 갈 단 한 가지. 한 문장"),
  photos: z
    .array(
      z.object({
        id: z.string(),
        usable: z.boolean().describe("이 상품의 실물 · 제형이 또렷하고, 사람 얼굴 · 다른 브랜드 · 잘린 글자가 없으면 true"),
        kind: z.enum(["product", "use", "texture", "scene"]).describe("product 제품 전체, use 쓰는 장면, texture 제형 질감만, scene 분위기"),
        what: z.string().describe("보이는 것 한 줄"),
        trim_top: z.number().describe("위에서 잘라 낼 비율 0~0.6"),
        trim_bottom: z.number().describe("아래에서 잘라 낼 비율 0~0.6"),
        upright: z.boolean().describe("제품이 똑바로 서 있으면 true. 눕히거나 비스듬히 찍은 제품 사진은 false. 제품 없는 사진은 true"),
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
        start_sec: z.number().describe("쓸 구간의 시작 초. 뒤에 다른 상품이 나오면 그 앞까지만 쓴다"),
        end_sec: z.number().describe("쓸 구간의 끝 초. 전체를 쓰면 원본 길이"),
      }),
    )
    .describe("받은 움직이는 이미지를 모두 판단한다. 없으면 빈 배열"),
  product_first_scene: z.number().int().describe("상품 이름을 처음 말하는 장면 번호(0부터). 위치는 정해져 있지 않다"),
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
        part: z.enum(["situation", "worry", "knowledge", "product", "difference", "takeaway"]).describe("이 장면의 역할: situation 첫 장면(후킹), worry 궁금증 · 고민, knowledge 상식, product 우리 상품, difference 우리 차이, takeaway 마무리"),
        evidence: z.array(z.string()).describe("이 장면의 사실 근거 번호만. 상식 카드 K1, 우리 차이 D1, 상품 자료 P, 널리 알려진 내용은 \"일반 상식\". 문구를 옮기지 않는다. 사실이 없는 연결 문장은 빈 배열"),
        source: z.enum(["photo", "gif", "archive", "visual", "motion", "stock"]).describe("photo 사진 후보, gif 움직이는 이미지, archive 자사 촬영 컷, visual AI 이미지, motion 코드로 그리는 설명 화면, stock 무료 스톡 영상"),
        source_id: z.string().describe("쓸 후보 번호 p1 · g1 · a1. visual · motion · stock이면 빈 문자열"),
        stock_query: z.string().describe("source가 stock이면 Pixabay 영어 검색어 2~3낱말(상표 없이, 얼굴이 안 나올 장면: hands, close up, back view 등). 아니면 빈 문자열"),
        motion: motionSchema.nullable().describe("source가 motion이면 설명 화면 값, 아니면 null"),
        shows: z.string().describe("이 장면에서 시청자가 보는 것"),
        say: z.string().describe("이 장면의 말을 화면 표기로. 첫 장면은 hook.spoken과 같다"),
        tts: z.string().describe("say를 읽는 대로 바꾼 원고. 숫자와 영문을 말하는 대로"),
        captions: z.array(z.string()).describe("say를 의미 단위로 나눈 자막, 한 묶음 16자 이내. 이어 붙이면 say와 같아야 한다. 첫 장면은 빈 배열"),
        emphasis: z.array(z.string()).describe("자막에서 강조할 핵심어"),
        graphics: z.array(graphicSchema).describe("말에 맞춰 나오는 작은 그래픽, 없으면 빈 배열. 첫 장면은 빈 배열. 마지막 장면에는 end_card 하나"),
        sfx: z.array(z.object({ name: z.enum(sfxNames), at_word: z.string().describe("이 소리가 날 낱말. 그 장면 말에 있는 낱말") })).describe("다음 질문 · 핵심 공개 · 비교 순간의 효과음. 대부분 장면은 빈 배열"),
      }),
    )
    .describe("내용에 맞는 장면 수. 합계 30~85초. 첫 장면 = situation(후킹)"),
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

const angleSchema = z.object({
  situation: z.string().describe("첫 장면이 여는 것: 시청자가 멈출 질문 · 의외의 사실 · 장면"),
  worry: z.string().describe("시청자가 궁금해하거나 잘못 알고 있거나 불편해하는 점"),
  hook_line: z.string().describe("첫 문장. 지어낸 인물 · 체험이 아니다"),
  one_thing: z.string().describe("시청자가 얻어 갈 단 한 가지"),
  answer: z.string().describe("궁금증에 대한 답. 상품에 대한 내용은 근거 자료에 있는 것만, 왜 그런지는 널리 알려진 일반 상식도 된다"),
  beats: z.array(z.string()).describe("이야기 흐름 3~5단계. 순서는 이 각도에 맞게 정한다"),
  evidence: z.array(z.string()).describe("쓸 근거 번호. K1, D1, P, 일반 상식"),
  reference: z.string().describe("주제 · 첫 문장을 가져온 참고 릴스 번호(B1, O1)와 거기서 가져온 점 한 줄. 참고 릴스가 없으면 빈 문자열"),
});
export type StoryAngle = z.infer<typeof angleSchema>;

/**
 * 주제로 쓰면 안 되는 것(2026-11-10 사용자 지적: 흑하랑 당류 주제, 워시오프 팩 마지막 "순서").
 * 각도 쓰기 · 각도 거르기 · 장면표 검수가 같은 기준을 본다.
 */
export const TOPIC_RULES = `- 주제(상황 · 고민 · 답 · 한 가지)는 이 상품을 사고 싶어지는 쪽이어야 한다. 당류 · 칼로리 · 나트륨 · 카페인 · 부작용 · 주의사항 · 단점처럼 우리 상품에 불리하거나 걱정을 키우는 정보는 주제나 답으로 쓰지 않는다. 수치가 낮아 좋은 쪽이어도 시청자가 그 걱정부터 떠올리게 만드는 주제는 쓰지 않는다.
- 누구나 아는 뻔한 사용법(바르고 씻는다, 뜯어서 마신다, 씻어서 먹는다)을 고민이나 "순서"처럼 꾸미지 않는다. 사용 순서를 말하려면 근거 자료에 실제 앞뒤 단계(예: 팩 다음에 바를 것)가 있어야 한다.
- 이미 다 아는 내용만 말하다 끝나지 않는다. 다 보고 나면 새로 알게 된 것이 하나 있어야 한다.`;

/** 대본을 쓰기 전에 서로 다른 이야기 각도를 낸다. 한 각도에 매달린 채 문장만 고치지 않기 위한 단계다. */
export async function writeAngles(input: { accountName: string; facts: ProductFacts; knowledge: VideoKnowledge; rejected?: string[]; references?: ReelReferences }): Promise<{ angles: StoryAngle[]; tokens: { input: number; output: number } }> {
  const f = input.facts;
  const model = agentModel();
  const refs = referenceBlock(input.references ?? EMPTY_REFERENCES);
  const shape = `주제와 첫 문장은 아래 "성과가 높았던 릴스"에서 가져온다. 상세페이지는 주제를 찾는 곳이 아니라, 고른 주제에 이 상품이 무엇으로 답하는지 사실을 확인하는 곳이다.
- 참고 릴스에서 시청자를 멈추게 한 것(의외의 사실, 흔한 오해, 비교, 구분법, 궁금증 등)을 찾아 이 상품의 주제로 옮긴다. 문장을 그대로 베끼지 않고, 어느 릴스에서 무엇을 가져왔는지 reference에 적는다. 참고 릴스가 없으면 reference는 빈 문자열이고, 이 상품군의 일반 상식 가운데 사람들이 궁금해할 주제를 고른다.
- 첫 문장(hook_line)의 모양은 각도마다 다르게 정한다. 질문, 의외의 사실, 흔한 오해 바로잡기, 비교 등 그 주제에 맞는 모양을 쓰고, 5개가 같은 말투 틀로 시작하지 않게 한다. 지어낸 인물("제 친구가", "어떤 고객님이")이나 1인칭 체험("써 봤는데")으로 시작하지 않는다.
- situation은 첫 장면이 여는 것(질문 · 의외의 사실 · 장면), worry는 시청자가 궁금해하거나 잘못 알고 있거나 불편해하는 점이다. 숫자 · 통계 · "많은 분들이" 같은 사실 주장을 지어내지 않는다.
- 답(answer): 왜 그런지와 이 상품이 그 궁금증에 어떻게 답하는지. 왜 그런지는 원리 · 원료 일반 · 생활 상식처럼 널리 알려진 내용도 되고, 이 상품에 대한 내용은 근거 자료에 있는 것만 쓴다. 답은 이 상품의 특징이나 우리 차이로 이어져야 한다.
- 흐름(beats)의 순서는 각도마다 맞게 정한다. 정해진 순서를 따르지 않는다.
- 5개는 서로 다른 주제여야 한다. 표현만 바꾼 비슷한 각도를 내지 않는다.
- 한 각도는 주제 하나만 다룬다. 성분 · 특징을 나열하지 않는다.`;
  const completion = await getOpenAI().chat.completions.parse({
    model,
    ...callOptions(model, 3000),
    messages: [
      {
        role: "system",
        content: `너는 인스타그램 @${input.accountName} 릴스 기획자다. 사람 얼굴이 나오지 않는 짧은 설명 영상의 이야기 각도를 5개 낸다.
${shape}
${TOPIC_RULES}
- 상품 사실은 근거 자료에 있는 것만 쓰고, 출처를 밝히는 말투("제품 안내에서는", "~래요") 없이 직접 설명한다. 숫자 · 통계 · 의학적 효과를 지어내지 않는다. 치료 · 재생 · 효과 보장, 지어낸 체험, 최고 · 유일 같은 단정을 쓰지 않는다. 원료 설명을 제품의 효과처럼 잇지 않는다.${input.rejected?.length ? `\n- 이미 써 봤지만 재미가 낮았던 각도와 비슷하게 쓰지 않는다: ${input.rejected.join(" / ")}` : ""}`,
      },
      {
        role: "user",
        content: `상품: ${f.shop} ${f.kindLabel} "${f.name}"\n한 줄 소개: ${f.oneLine ?? "없음"}\n상세 항목: ${JSON.stringify(f.details)}\n확인된 특징: ${f.claims.map((c) => c.claim).join(" / ")}\n상세페이지 원문:\n${f.sourceText.slice(0, 4000)}\n\n${knowledgeBlock(input.knowledge)}${refs ? `\n\n${refs}` : ""}`,
      },
    ],
    response_format: zodResponseFormat(z.object({ angles: z.array(angleSchema) }), "story_angles"),
  });
  const parsed = completion.choices[0]?.message?.parsed;
  if (!parsed?.angles.length) throw new Error("이야기 각도 응답이 없어요");
  return { angles: parsed.angles, tokens: { input: completion.usage?.prompt_tokens ?? 0, output: completion.usage?.completion_tokens ?? 0 } };
}

/** 상품 자료 없이 첫 문장과 흐름만 보고 더 보고 싶은 순서를 정한다. 파는 쪽 사정을 모르는 사람의 눈으로 고르기 위해서다. */
export async function rankAngles(angles: StoryAngle[]): Promise<{ order: number[]; scores: number[]; tokens: { input: number; output: number } }> {
  const model = agentModel();
  const completion = await getOpenAI().chat.completions.parse({
    model,
    ...callOptions(model, 1000),
    messages: [
      {
        role: "user",
        content: `인스타 릴스를 넘겨 보는 평범한 사람으로서, 아래 첫 문장과 이야기 흐름을 보고 끝까지 보고 싶은 정도를 1~5점으로 매긴다. 이 상품을 살 생각은 없다. 뻔하거나 수업 같거나 광고 같으면 낮게 준다.\n${angles.map((a, i) => `${i}. "${a.hook_line}" — ${a.beats.join(" → ")}`).join("\n")}`,
      },
    ],
    response_format: zodResponseFormat(z.object({ scores: z.array(z.object({ index: z.number().int(), score: z.number().int() })) }), "angle_scores"),
  });
  const rows = completion.choices[0]?.message?.parsed?.scores ?? [];
  const scores = angles.map((_, i) => rows.find((r) => r.index === i)?.score ?? 0);
  const order = angles.map((_, i) => i).sort((a, b) => scores[b] - scores[a] || a - b);
  return { order, scores, tokens: { input: completion.usage?.prompt_tokens ?? 0, output: completion.usage?.completion_tokens ?? 0 } };
}

/**
 * 상품 자료를 보고 주제로 쓰면 안 되는 각도(불리한 정보 · 뻔한 사용법 · 이미 아는 내용)를 거른다.
 * 순위(rankAngles)는 파는 쪽 사정을 모르는 눈으로 매기므로, 이 판단은 따로 한다.
 */
export async function screenAngles(angles: StoryAngle[], facts: ProductFacts): Promise<{ rejected: { index: number; reason: string }[]; tokens: { input: number; output: number } }> {
  const model = agentModel();
  const completion = await getOpenAI().chat.completions.parse({
    model,
    ...callOptions(model, 1500),
    messages: [
      {
        role: "system",
        content: `너는 이 상품을 파는 쪽의 릴스 편집장이다. 아래 이야기 각도 가운데 주제로 쓰면 안 되는 것만 고른다. 재미는 보지 않는다.
${TOPIC_RULES}
문제가 없는 각도는 고르지 않는다. 고른 각도는 이유를 한 문장으로 쓴다.`,
      },
      {
        role: "user",
        content: `상품: ${facts.shop} ${facts.kindLabel} "${facts.name}"
한 줄 소개: ${facts.oneLine ?? "없음"}
사용법: ${facts.usage ?? "없음"}
확인된 특징: ${facts.claims.map((c) => c.claim).join(" / ")}

각도:
${angles.map((a, i) => `${i}. 상황: ${a.situation} | 고민: ${a.worry} | 한 가지: ${a.one_thing} | 답: ${a.answer}`).join("\n")}`,
      },
    ],
    response_format: zodResponseFormat(z.object({ rejected: z.array(z.object({ index: z.number().int(), reason: z.string() })) }), "angle_screen"),
  });
  const rows = completion.choices[0]?.message?.parsed?.rejected ?? [];
  return { rejected: rows.filter((r) => r.index >= 0 && r.index < angles.length), tokens: { input: completion.usage?.prompt_tokens ?? 0, output: completion.usage?.completion_tokens ?? 0 } };
}

/**
 * 마지막 장면의 AI 이미지는 상품 사진으로 바꾼다. 다시 쓰게 할 일이 아니라 코드가 바로 고칠 수 있는 실수다.
 * 첫 장면은 상황 장면이라 AI 이미지(사람 없는 생활 장면)를 쓸 수 있다.
 */
export function repairEdgeVisuals(b: Storyboard): Storyboard {
  const last = b.scenes.length - 1;
  const photo = b.photos.find((p) => p.usable && p.kind === "product" && p.upright)?.id;
  if (!photo || last < 0) return b;
  const edges = new Set([last].filter((i) => b.scenes[i]?.source === "visual"));
  if (!edges.size) return b;
  return {
    ...b,
    scenes: b.scenes.map((s, i) => (edges.has(i) ? { ...s, source: "photo" as const, source_id: photo } : s)),
    visuals: b.visuals.filter((v) => !edges.has(v.beat)),
  };
}

export interface StoryboardContext {
  service: Service | null;
  readService?: Service;
  planId?: string;
  accountName: string;
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
  angle?: StoryAngle | null;
  /** 계정 설정의 "바꾸고 싶은 점"(0052) — 예전의 컨셉 · 말투 · 영상 스타일을 합친 한 칸. 관리자가 고정하고 싶은 규칙도 여기에 적는다 */
  notes?: string | null;
  phraseBlock?: string;
  visualLibrary?: { key: string; subject: string }[];
  fontChoices?: SkillFont[];
  /** 같은 실물 소재를 쓸 수 있는 횟수. repeatLimit로 정한다 */
  repeatLimit?: number;
  /** earlier: 앞 회차들에서 지적돼 이미 고친 것. 이번에 고치다가 다시 깨지지 않게 함께 넘긴다 */
  retry?: { board: Storyboard; problems: string[]; earlier?: string[] } | null;
}

const bullets = (lines: string[]) => lines.map((l) => `- ${l}`).join("\n");

/** 설명 화면에 들어가는 글. 근거 · 금지 표현 점검에 넣는다. */
export function motionTexts(m: MotionSpec): string[] {
  return [m.title, m.left_label, m.right_label, m.left_value, ...m.right_values, m.number_to ? `${m.number_to}${m.unit}` : "", m.end_text, ...m.items, m.big ? `${m.big}${m.unit}` : ""].filter(Boolean);
}

function motionEmpty(m: MotionSpec | null): boolean {
  return !m || (m.kind === "steps" && !m.items.some((t) => t.trim())) || (m.kind === "big_fact" && !m.big.trim()) || (m.kind === "compare" && !m.left_value.trim() && !m.right_values.some((t) => t.trim())) || (m.kind === "count" && !m.number_to);
}

/**
 * 목록 도식(steps)은 항목이 2~4개여야 한다(스키마). 빈 문자열 항목은 그리지 않으니 세지 않는다.
 * 항목이 1개면 체크 표시 하나만 떠 있는 빈 화면이 돼서, 비어 있지는 않아도 장면표 에이전트가 고치게 한다.
 */
function stepsTooFew(m: MotionSpec | null): boolean {
  return m?.kind === "steps" && m.items.filter((t) => t.trim()).length === 1;
}

export async function writeStoryboard(ctx: StoryboardContext): Promise<AgentResult<Storyboard>> {
  const f = ctx.facts;
  const kit = editKit();
  const system = `너는 인스타그램 @${ctx.accountName} 릴스의 작가 겸 편집자다. 사람 얼굴이 나오지 않는 설명 영상의 장면표를 쓴다. 말과 화면을 장면마다 함께 정한다.
시청자가 첫 문장에 멈춘 뒤, 그 궁금증이 왜 생기는지 상식 하나를 배우고, 이 상품이 거기에 어떻게 답하는지 알게 되는 영상이다. 수업이나 광고처럼 들리면 실패다.
상품: ${f.shop} ${f.kindLabel} "${f.name}"

순서:
1. get_product_facts와 근거 자료를 읽고 받은 이미지 · 움직이는 이미지를 모두 본다. 무엇을 보여 줄 수 있는지 먼저 판단한다.
2. 이 영상의 단 한 가지(one_thing)와 첫 장면이 여는 것(situation) · 궁금증(worry)을 정한다. 그 답이 이 상품의 특징이나 우리 차이로 이어지는 것을 고른다(question_reason). 상품과 상관없는 일반 상식에서 시작해 상품을 끼워 넣지 않는다.
3. 아래 구조로 장면을 나누고, 장면마다 화면 하나와 그 화면을 보며 할 말을 정한다. check_rules로 금지 표현을 확인한다.
4. 게시물 캡션은 check_caption으로 검사하고 경고를 고친다. 첫 40자에 상품의 짧은 이름과 주제를 넣고, 검색어는 해시태그 외 본문에도 쓴다. 행동 요청은 꼭 넣지 않아도 되고, 넣으면 하나만 쓴다. 구매 유도는 필요 없다.

구조와 분량:
- 길이는 내용이 정한다. 말 전체(tts를 이어 붙인 글자, 띄어쓰기 제외)가 ${ctx.charLimits[0]}~${ctx.charLimits[1]}자(30~85초) 안이면 된다. 1분을 채우려고 문장을 늘리지 않는다. 할 말이 끝나면 끝낸다.
- 한 장면은 2~4초(약 15~28자)이고, 한 장면에 말 한 가지만 담는다.
- 한 편에 이야기 하나만 한다. 성분 · 특징을 전부 설명하지 않고 one_thing과 관련된 것만 고른다. 나머지는 다른 영상의 몫이다.
- 첫 문장에서 연 궁금증을 끝까지 끌고 간다. 답을 바로 주지 않고, 사실을 차례로 읽어 주는 흐름은 쓰지 않는다.
- 친구에게 말하듯 쓴다. "~라는 이름으로 적혀 있어요", "~라고 안내해요" 같은 같은 말끝을 반복하지 않는다. 문장 길이에 변화를 준다.
- 장면 순서는 정해져 있지 않다. 이 각도의 흐름에 맞게 아래 역할을 배치한다. 첫 장면 하나만 situation이고, knowledge와 product는 꼭 들어간다.
- situation(첫 장면, 첫 3초): 시청자를 멈추게 하는 첫 문장. 각도에서 정한 첫 문장의 모양(질문 · 의외의 사실 · 오해 바로잡기 · 비교 등)을 그대로 쓰고, 정해진 말투 틀로 바꾸지 않는다.
- worry: 시청자가 궁금해하거나 잘못 알고 있거나 불편해하는 점. 필요할 때만 쓴다. 숫자 · 통계 · "많은 분들이" 같은 사실 주장을 지어내지 않는다.
- knowledge: 왜 그런지 쉬운 말로 설명한다. 낯선 단어는 바로 뜻을 붙이고, 이름만 나열하지 않는다. 비유는 도움이 될 때만 쓰고, 효과를 뜻하면 안 된다.
- product: 이 상품이 그 궁금증에 어떻게 답하는지. 성분이면 전성분 표기, 과일이면 품종 · 산지 · 먹는 법까지 구체적으로.
- difference: 담당자가 확정한 우리 차이를 비교 대상과 함께 말한다. 확정된 차이가 없으면 이 구간을 쓰지 않고, 우리가 다르다는 말을 하지 않는다.
- takeaway: 마무리 장면. 쓰고 싶을 때만 쓰고, 영상에서 말한 내용 안에서 끝낸다. 기준 한 줄로 끝내야 한다는 규칙은 없다.
- 8~12초마다 다음이 궁금해지는 문장을 넣어 흐름을 잇는다. 강의처럼 사실을 늘어놓지 않는다.
- 상품 이름은 흐름에 맞는 곳에서 말한다. 위치는 정해져 있지 않다. product_first_scene에 상품 이름을 처음 말하는 장면 번호를 쓴다.

말하는 사람:
- 기본은 시청자에게 말 거는 사람이다. 브랜드 목소리("저희는 ~를 골랐어요")를 써도 된다.
- "저희"가 했다는 내용(고른 것 · 넣은 것 · 만든 것)은 상품 자료(P) · 확정된 우리 차이(D)에 있는 것만 쓴다. 자료에 없는 개발 과정 · 연구 기간 · 시행착오 · 숫자는 지어내지 않는다. "저희가 만들었어요"는 이 브랜드가 만들거나 기획한 상품으로 자료에서 보일 때만 쓰고, 과일 · 농산물처럼 만들지 않은 상품은 고른 이유로 말한다.
- 지어낸 인물("제 친구가", "어떤 고객님이"), 1인칭 체험("써 봤는데", "제 피부가"), 지어낸 후기는 쓰지 않는다.
- 장면마다 evidence를 채운다. 상품에 대한 문장은 상품 자료(P), 상식 문장은 상식 카드(K1...)를 먼저 쓰고, 카드에 없는 널리 알려진 원리 · 원료 일반 · 생활 상식은 "일반 상식"이라고 적는다. 우리 차이는 D1...만 쓴다.

글:
- 소리 내어 읽었을 때 말이 되어야 한다. 처음 보는 사람이 상품이 무엇인지 알아듣고, 앞 문장에 이어 다음 문장을 자연스럽게 듣게 쓴다.
- 첫 문장은 시청자가 멈출 이유가 있어야 한다. 용량 · 가격 같은 숫자는 첫 문장에 넣지 않는다.
- 후킹은 궁금증 또는 정보라는 목적이 분명해야 한다. hook.answer에 실제 답을 적고 evidence_scenes에서 중간까지 그 답을 회수한다. 빈 호기심/끝까지 보라는 명령, 답 없이 상품 소개만 반복하는 흐름은 쓰지 않는다.
- 제형/거품/사용 결과를 '보라'는 후킹은 실제 제형/사용 컷이 있을 때만 쓴다. 용기 사진과 AI 그림/도식은 실물 증거가 아니다. 재료가 포장 사진뿐이면 포장에 보이는 구분점이나 근거가 있는 사용 순서 등 답할 수 있는 질문을 고른다.
- 체감/촉감/흡수 속도를 용기 사진으로 입증하지 않는다.
- 상품 사실은 직접 설명하는 말투로 쓴다. "제품 안내에서는", "상세페이지에 따르면", "~래요"처럼 출처를 밝히며 전하는 말투를 쓰지 않는다.
- 장면에 없는 것을 말하지 않는다. 말하는 내용이 보이는 이미지를 고른다.
- 이 상품에 대한 사실(숫자 · 성분 · 효과 · 구성)은 get_product_facts와 근거 자료에 있는 것만. uncertainties에 있는 건 말하지 않는다.
- 원리 · 원료 일반 · 생활 상식처럼 널리 알려진 내용은 상세페이지나 카드에 없어도 쓴다. 학계에서 논란이 있거나 확실하지 않은 내용은 쓰지 않는다.
- 숫자 · 통계 · 의학적 효과는 지어내지 않고 일반 상식으로도 쓰지 않는다. 다만 이 성분(원료)의 숫자 · 통계 · 의학적 효과가 상세페이지 원문이나 상식 카드에 있으면, 말(say · tts)로 읽지 않고 화면 그래픽에만 원료의 특성이라는 뜻이 드러나게 쓴다(예: 작은 글씨 "원료 특성"과 함께). 이 제품을 쓰면 그렇게 된다는 뜻으로 쓰지 않고, 금지 표현(check_rules)은 그래픽에도 그대로 지킨다.
- 전성분 이름은 표기 그대로 쓴다. "모나스커스/쌀발효물"처럼 한 이름을 나누거나 줄이지 않는다. 다른 이름으로 부를 때는 "성분표에는 ○○로 적혀 있어요"처럼 구분한다.
- 화면 그래픽에 "전성분 표기" 같은 이름표를 쓸 때는 실제 전성분 이름을 줄이지 않고 그대로 쓴다. 통용 이름(비타민 B12, 홍국)을 쓸 때는 그런 이름표를 붙이지 않는다.
- 성분 이름을 연달아 나열하지 않는다. 성분 하나마다 뜻을 말하고 이 상품과 왜 관련 있는지 잇는다.
- 상식 카드 · 일반 상식의 원료 설명은 원료의 뜻이다. 이 제품의 효과처럼 잇지 않는다. "그래서 피부가 좋아져요" 같은 결론을 쓰지 않는다.
- 최고 · 유일 · 100% 같은 단정을 쓰지 않는다.
- 건강기능식품 기능성 표현은 approvedClaims 문장 그대로만. 비어 있으면 기능성을 말하지 않는다.${f.kind === "COSMETIC" ? "\n- 화장품: 치료 · 재생 · 염증 같은 표현을 쓰지 않는다. 캡션에 개인차가 있음을 밝힌다." : ""}
- 판매 상태(재고 · 할인 · 배송)는 말하지 않는다. 인사 · 자기소개로 시작하지 않는다.
- 저장 · 팔로우 요청은 꼭 하지 않는다. 다시 꺼내 볼 만한 내용이 있는 영상일 때만 하나 하고, 마지막 몇 초에 요청 · 인사 · 정리를 몰아 넣어 급하게 끝내지 않는다.

화면:
- 장면 예산: 상품 사진 · 움직이는 이미지 · 자사 촬영 약 40%, AI 이미지 · 스톡 영상 약 35%, 코드 설명 화면은 25% 이하. 같은 종류 화면이 8초 넘게 이어지지 않게 섞는다. 설명 화면이 25%를 넘으면 넘는 장면은 코드가 AI 이미지로 바꾼다.
- usable인 후보만 쓴다. 첫 장면은 첫 문장이 말하는 것이 보이는 화면이다: 자사 촬영 컷, 스톡 영상, 사람 없는 생활 장면 AI 이미지, 또는 상황 속 제품 사진. texture(질감만 있는 사진)는 무엇인지 말로 설명할 때 한 번만 쓰고 첫 장면에 쓰지 않는다.
- ${ctx.candidates.length + (ctx.gifs?.length ?? 0) + ctx.archive.length ? "product · difference 구간은 실제 사진 · 움직이는 이미지 · 자사 촬영으로 보여 준다." : "이 상품은 쓸 수 있는 실제 사진 · 움직이는 이미지 · 자사 촬영이 없다. product · difference 구간도 스톡 영상 · 설명 화면 · AI 이미지로 보여 주고, 없는 사진 · 촬영 컷 번호를 지어내지 않는다."} 다른 구간은 스톡 영상 · AI 이미지 · 자사 촬영 · 설명 화면 가운데 그 말에 맞는 것을 쓴다.
- 스톡 영상(source stock): 무료 실사 영상이고 이 상품은 나오지 않는다. 개수 제한은 없다. 얼굴이 보이는 영상은 코드가 버리므로 손 · 뒷모습 · 사물 위주 장면을 stock_query(영어 2~3낱말)로 찾는다. 상표 · 브랜드 이름은 검색어에 넣지 않는다. 못 찾으면 상품 사진이 대신 나간다.
- 눕히거나 비스듬히 찍은 제품 사진은 upright를 false로 하고 쓰지 않는다. 시청자에게 제품이 똑바로 보여야 한다.
- 같은 후보는 ${ctx.repeatLimit ?? MIN_REPEAT}번까지 쓰고(쓸 수 있는 사진이 적을수록 늘어난다), 연달아 쓰지 않는다. 넘는 장면은 코드가 AI 이미지로 바꾼다. 자사 촬영 컷이 있으면 사진보다 먼저 고른다.
- 인증서 · 표 · 그래프, 이 상품이 아닌 물건, 잘라 낼 수 없는 글자가 있으면 usable false. 위아래 글자 띠는 trim으로 잘라 낸다.
- 움직이는 이미지는 crop으로 글자와 다른 상품을 피해 움직임이 보이는 구역만, start_sec · end_sec로 이 상품만 나오는 구간만 고른다. 얼굴이 있거나 다른 상품과 섞여 피할 수 없으면 usable false. CG 연출은 실제 시연이나 효과의 증거처럼 말하지 않는다.
- 다른 제품과 나란히 비교한 장면은 담당자가 확정한 우리 차이(D)와 같은 내용일 때만 쓴다. 그 외에는 usable false.
- source가 visual인 장면은 visuals에 같은 beat의 그림을 하나 넣는다. 그림을 못 만들면 상품 사진이 대신 나간다.
- 순서 · 구성 · 비교 · 숫자를 말하는 장면은 source를 motion으로 해 코드로 그린 설명 화면을 쓸 수 있다. 첫 · 마지막 장면에는 쓰지 않고, 두 장면 연달아 쓰지 않는다. 값은 근거 자료에 있는 것만 쓰고, 글자는 짧게, 색은 상품과 계정 분위기에 맞춘다. "성분명"처럼 내용 없는 낱말을 크게 쓰지 않고, 같은 설명 화면을 되풀이하지 않는다.
- 효과음(sfx)은 다음 질문 · 핵심 공개 · 비교 순간에만 넣는다. 전체에서 6~10개면 충분하다.

자막과 그래픽:
${bullets(kit.caption_rules)}
- 그래픽은 그 말을 할 때 나오게 at_word를 그 장면 말 속의 낱말로 쓴다. 자막과 같은 말을 되풀이하지 않는다.

읽기용 원고(tts):
${bullets(kit.tts_rules)}

글자 디자인(look):
${bullets(kit.look_rules)}${ctx.fontChoices?.length ? `\n\n글꼴: 이 영상의 제품 · 말의 내용 · 계정 분위기에 맞게 강조어 글꼴(key_font)과 작은 줄 글꼴(small_font)을 아래에서 하나씩 고른다. 습관처럼 같은 글꼴을 고르지 않는다. 자막은 짧게 지나가므로 한 번에 읽혀야 한다.\n${FONT_PAIRING_RULES.map((r) => `- ${r}`).join("\n")}\n${fontChoiceLines(ctx.fontChoices)}` : ""}${visualRules(f.kind, ctx.visualLibrary ?? [], LONG_VISUALS)}${conceptBlock("이 계정에서 바꾸고 싶은 점", ctx.notes, `무엇을 말할지 · 흐름 · 말하는 사람 · 말투 · 장면 고르기 · 글자 디자인에 반영한다. 여기 적힌 것은 위의 기본 흐름 · 말투보다 먼저 따른다. 상품 사실 · 금지 표현 · 건강기능식품 표현 규칙만은 바꾸지 않는다.`)}${ctx.phraseBlock ?? ""}${ctx.angle ? `\n\n이 영상의 각도(이미 정해졌다. 이 상황과 흐름으로 쓰고 다른 소재로 새지 않는다. situation · worry · one_thing도 이 값을 쓴다):\n- 첫 장면이 여는 것: ${ctx.angle.situation}\n- 궁금증: ${ctx.angle.worry}\n- 첫 문장: ${ctx.angle.hook_line}\n- 얻어 갈 한 가지: ${ctx.angle.one_thing}\n- 답: ${ctx.angle.answer}\n- 흐름: ${ctx.angle.beats.join(" → ")}${ctx.angle.reference ? `\n- 참고한 릴스: ${ctx.angle.reference}` : ""}` : ""}`;
  const gifs = ctx.gifs ?? [];
  const user = `상세페이지 원문(상품 사실은 이 안에서만 쓴다. "원료적 특성에 한함" 같은 단서가 붙은 내용은 말로 읽지 않고, 화면 그래픽에 원료의 특성이라고 밝혀 쓴다):\n${f.sourceText}\n\n${knowledgeBlock(ctx.knowledge)}\n\n쓸 수 있는 사진 후보(가로x세로): ${ctx.candidates.map((c) => `${c.id} ${c.w}x${c.h}`).join(", ")}
그림은 후보를 번호와 함께 모은 것이다. 위 목록에 없는 번호는 화질이 낮거나 제품이 아닌데 오려야 하는 사진이라 쓰지 않는다. 가로로 넓은 사진은 사진 전체를 가로 폭에 맞추고 위아래를 단색으로 채워 보여 준다.${gifs.length ? `\n\n움직이는 이미지(사진 묶음 다음 그림부터 차례로, 그림마다 왼쪽부터 시간 순서로 프레임 6개):\n${gifs.map((g) => `${g.id} 원본 ${g.w}x${g.h}, ${g.seconds.toFixed(1)}초`).join("\n")}` : ""}${ctx.archive.length ? `\n\n자사 촬영 컷(소리 없음, 순서대로 마지막 ${ctx.archive.length}장의 그림이 컷마다 프레임 3개):\n${ctx.archive.map((a) => `${a.id} ${a.seconds.toFixed(1)}초 — ${a.what}`).join("\n")}` : ""}${
    ctx.retry
      ? `\n\n먼저 쓴 장면표:\n${JSON.stringify({ hook: ctx.retry.board.hook, scenes: ctx.retry.board.scenes.map((s) => ({ part: s.part, source: s.source, source_id: s.source_id, stock_query: s.stock_query, say: s.say })), visuals: ctx.retry.board.visuals.map((v) => ({ beat: v.beat, subject: v.subject })) })}\n\n이 문제를 고쳐 전체를 다시 내라:\n${bullets(ctx.retry.problems)}${ctx.retry.earlier?.length ? `\n\n앞 회차에서 지적돼 고친 것이다. 이번에 고치면서 다시 생기지 않게 함께 지킨다:\n${bullets(ctx.retry.earlier)}` : ""}`
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

// 완성본 길이 점검과 같은 여유(초). 글자 수가 이 정도 어긋난 것으로는 다시 쓰게 하지 않는다
export const LENGTH_TOLERANCE = 3;

// 같은 실물 소재(사진 · 움직이는 이미지 · 자사 촬영)를 쓸 수 있는 횟수. 쓸 수 있는 소재가 적으면 늘리고,
// 그래도 남는 장면은 코드가 AI 이미지로 바꾼다(사용자 결정 2026-11-09)
const MIN_REPEAT = 2;
const MAX_REPEAT = 4;
// 장면 예산: 실물 소재 약 40%, 설명 화면 25% 이하
const REAL_SHARE = 0.4;
const MAX_MOTION_SHARE = 0.25;
const REAL_SOURCES = new Set<string>(["photo", "gif", "archive"]);

/** 같은 실물 소재를 쓸 수 있는 횟수. 실물 장면 예산을 쓸 수 있는 소재 수로 나눠 정한다. */
export function repeatLimit(materials: number, scenes: number): number {
  if (materials <= 0) return MIN_REPEAT;
  return Math.min(MAX_REPEAT, Math.max(MIN_REPEAT, Math.ceil((scenes * REAL_SHARE) / materials)));
}

/** 이 장면표에서 쓸 수 있는 실물 소재 수. 눕힌 제품 사진은 세지 않는다. */
export function realMaterialCount(b: Storyboard, archiveIds: string[]): number {
  return b.photos.filter((p) => p.usable && (p.kind !== "product" || p.upright)).length + b.gifs.filter((g) => g.usable).length + archiveIds.length;
}

/**
 * 같은 소재를 횟수보다 많이 쓴 장면과 25%를 넘는 설명 화면을 AI 이미지 장면으로 바꾼다.
 * 개수를 맞추라고 다시 쓰게 하면 다른 규칙이 깨져서(2026-11-09 시험 4번), 코드가 바로 고친다.
 * 바꾼 장면의 그림 설명은 writeSceneVisuals가 쓴다.
 */
export function repairOverflow(b: Storyboard, archiveIds: string[]): { board: Storyboard; converted: number[]; limit: number } {
  const n = b.scenes.length;
  const last = n - 1;
  const limit = repeatLimit(realMaterialCount(b, archiveIds), n);
  const pick = new Set<number>();
  // 상품 · 우리 차이 장면은 실물이 보여야 해서 가장 나중에 바꾼다. 마지막 장면은 AI 이미지를 쓰지 않으니 바꾸지 않는다
  const keep = (i: number) => (b.scenes[i].part === "product" || b.scenes[i].part === "difference" ? 1 : 0);
  const byId = new Map<string, number[]>();
  b.scenes.forEach((s, i) => {
    if (REAL_SOURCES.has(s.source) && s.source_id) byId.set(s.source_id, [...(byId.get(s.source_id) ?? []), i]);
  });
  for (const at of byId.values()) {
    if (at.length <= limit) continue;
    // 첫 장면은 후킹 말이 그 화면을 가리키는 일이 많아(“이 표시”) 바꾸지 않는다(2026-11-09 시험)
    const order = at.filter((i) => i !== last && i !== 0).sort((x, y) => keep(x) - keep(y) || y - x);
    order.slice(0, at.length - limit).forEach((i) => pick.add(i));
  }
  // 같은 실물 소재가 연달아 나오면 뒤 장면을 바꾼다. 뒤 장면이 마지막이면 앞 장면을 바꾼다(사용자 결정 2026-11-09)
  for (let i = 1; i < n; i++) {
    const s = b.scenes[i];
    const prev = b.scenes[i - 1];
    if (!REAL_SOURCES.has(s.source) || !s.source_id || prev.source_id !== s.source_id || pick.has(i) || pick.has(i - 1)) continue;
    if (i !== last) pick.add(i);
    else if (i - 1 !== 0) pick.add(i - 1);
  }
  const motions = b.scenes.map((s, i) => (s.source === "motion" ? i : -1)).filter((i) => i >= 0);
  const motionMax = Math.floor(n * MAX_MOTION_SHARE);
  if (motions.length > motionMax) {
    // 연달아 나오는 설명 화면부터, 그다음 뒤쪽부터 바꾼다
    const runs = (i: number) => (motions.includes(i - 1) ? 0 : 1);
    const order = motions.filter((i) => i !== last && i !== 0).sort((x, y) => runs(x) - runs(y) || y - x);
    order.slice(0, motions.length - motionMax).forEach((i) => pick.add(i));
  }
  // AI 이미지는 영상당 개수 한도가 있어 그 안에서만 바꾼다. 넘는 것은 점검에 남아 다시 쓰게 한다
  const room = Math.max(0, LONG_VISUALS.max - b.scenes.filter((s) => s.source === "visual").length);
  const converted = [...pick].sort((x, y) => x - y).slice(0, room);
  if (!converted.length) return { board: b, converted, limit };
  const set = new Set(converted);
  return {
    board: {
      ...b,
      scenes: b.scenes.map((s, i) => (set.has(i) ? { ...s, source: "visual" as const, source_id: `v${i}`, motion: null, stock_query: "" } : s)),
      visuals: b.visuals.filter((v) => !set.has(v.beat)),
    },
    converted,
    limit,
  };
}

/** 코드가 AI 이미지로 바꾼 장면의 그림 설명만 쓴다. 장면표 전체를 다시 쓰지 않는다. */
export async function writeSceneVisuals(input: { board: Storyboard; beats: number[]; facts: ProductFacts; knowledge: VideoKnowledge; visualLibrary?: { key: string; subject: string }[] }): Promise<{ visuals: EditVisual[]; tokens: { input: number; output: number } }> {
  const f = input.facts;
  const model = agentModel();
  const completion = await getOpenAI().chat.completions.parse({
    model,
    ...callOptions(model, 3000),
    messages: [
      {
        role: "system",
        content: `너는 릴스 편집자다. 아래 장면들은 실제 사진이 모자라거나 설명 화면이 많아 AI 이미지로 채운다. 장면마다 그 장면의 말을 돕는 그림을 하나씩 정한다. beat는 장면 번호 그대로 쓴다.
- 목록의 장면마다 빠짐없이 하나씩 낸다. 빈 배열로 내거나 장면을 건너뛰지 않는다.
- 0번 장면(상황)이면 그 상황이 보이는 사람 없는 생활 장면으로 만든다.
- 상품 · 우리 차이 · 정리 장면이어도 상품을 그리지 않는다. 그 장면 말에 나오는 원료 · 품종 · 산지 · 원리 · 보관 같은 개념을 그린다. 말에 그릴 개념이 없으면 상품 자료에 나오는 원료나 재료의 생김새를 그린다.${visualRules(f.kind, input.visualLibrary ?? [], LONG_VISUALS)}`,
      },
      {
        role: "user",
        content: `상품: ${f.shop} ${f.kindLabel} "${f.name}"\n상세페이지 원문:\n${f.sourceText.slice(0, 4000)}\n\n${knowledgeBlock(input.knowledge)}\n\n그림이 필요한 장면:\n${input.beats.map((i) => `${i}. (${input.board.scenes[i].part}) 화면: ${input.board.scenes[i].shows} / 말: ${input.board.scenes[i].say}`).join("\n")}`,
      },
    ],
    response_format: zodResponseFormat(z.object({ visuals: z.array(visualSchema) }), "scene_visuals"),
  });
  const want = new Set(input.beats);
  const seen = new Set<number>();
  const visuals = (completion.choices[0]?.message?.parsed?.visuals ?? []).filter((v) => want.has(v.beat) && !seen.has(v.beat) && seen.add(v.beat));
  return { visuals, tokens: { input: completion.usage?.prompt_tokens ?? 0, output: completion.usage?.completion_tokens ?? 0 } };
}

/** 코드로 확인할 수 있는 문제. */
export function storyboardProblems(b: Storyboard, archiveIds: string[], fixedHook: boolean, opts: { knowledge: VideoKnowledge; charLimits: [number, number] }): string[] {
  const out: string[] = [];
  // 눕힌 제품 사진은 후보에 있어도 쓰지 않는다
  const usable = new Map(b.photos.filter((p) => p.usable && (p.kind !== "product" || p.upright)).map((p) => [p.id, p]));
  const usableGifs = new Set(b.gifs.filter((g) => g.usable).map((g) => g.id));
  if (b.scenes.length < MIN_SCENES || b.scenes.length > MAX_SCENES) out.push(`장면이 ${b.scenes.length}개다. ${MIN_SCENES}~${MAX_SCENES}개로 쓴다`);
  const sizes = b.scenes.map((s) => squash(s.tts).length);
  const chars = sizes.reduce((a, n) => a + n, 0);
  const slack = Math.round(LENGTH_TOLERANCE * (opts.charLimits[1] / AUTO_SECONDS[1]));
  if (chars < opts.charLimits[0] - slack || chars > opts.charLimits[1] + slack) out.push(`말이 ${chars}자다. 음성 ${AUTO_SECONDS[0]}~${AUTO_SECONDS[1]}초에 맞게 ${opts.charLimits[0]}~${opts.charLimits[1]}자로 쓴다`);
  const validRefs = new Set(["P", COMMON_KNOWLEDGE_REF, ...opts.knowledge.cards.map((c) => c.ref), ...opts.knowledge.differences.map((d) => d.ref)]);
  const hasDifferences = opts.knowledge.differences.length > 0;
  const firstName = b.product_first_scene;
  // 상품 이름은 흐름 어디에서 나와도 된다(2026-11-10 사용자 결정). 번호가 맞는지만 본다
  if (!Number.isInteger(firstName) || firstName < 0 || firstName >= b.scenes.length) out.push("product_first_scene이 올바른 장면 번호가 아니다");
  const realScenes = b.scenes.filter((s) => (s.part === "product" || s.part === "difference") && ["photo", "gif", "archive"].includes(s.source));
  // 실물 소재가 1개뿐이면 같은 소재가 붙어 나오지 않게 1장면만 요구한다(사용자 결정 2026-11-09).
  // 쓸 수 있는 실물 소재가 하나도 없으면 스톡 · 도식만으로 만든다(사용자 결정 2026-11-10)
  const realNeed = Math.min(2, realMaterialCount(b, archiveIds));
  if (realNeed > 0 && realScenes.length < realNeed) out.push(`우리 상품 · 우리 차이 구간에는 실제 사진 · 움직이는 이미지 · 자사 촬영을 ${realNeed}장면 이상 쓴다`);
  const differenceScenes = b.scenes.filter((s) => s.part === "difference");
  if (hasDifferences && !differenceScenes.length) out.push("확정된 우리 차이가 있는데 difference 장면이 없다");
  if (!hasDifferences && differenceScenes.length) out.push("확정된 우리 차이가 없으니 difference 장면을 쓰지 않는다");
  if (!b.scenes.some((s) => s.part === "knowledge")) out.push("상식(knowledge) 장면이 없다");
  // 대본 방식은 하나다. 장면 순서 · 마지막 한 줄 · 말하는 사람은 정하지 않는다(2026-11-10 사용자 결정). 첫 장면 = 후킹, 상식 · 상품 장면이 있는지만 본다
  if (b.scenes[0] && b.scenes[0].part !== "situation") out.push("첫 장면은 후킹(situation)으로 시작한다");
  if (b.scenes.slice(1).some((s) => s.part === "situation")) out.push("situation은 첫 장면 하나만 쓴다. 뒤의 장면은 다른 역할로 나눈다");
  if (!b.scenes.some((s) => s.part === "product")) out.push("우리 상품(product) 장면이 없다");
  const motions = b.scenes.filter((s) => s.source === "motion").length;
  if (b.scenes.length && motions / b.scenes.length > MAX_MOTION_SHARE) out.push(`설명 화면이 ${motions}개로 많다. 전체의 25% 이하로 줄이고 사진 · AI 이미지로 바꾼다`);
  const endings = new Map<string, number>();
  for (const s of b.scenes) {
    const e = sentenceEnding(s.say);
    if (e.length >= 4) endings.set(e, (endings.get(e) ?? 0) + 1);
  }
  for (const [e, n] of endings) if (n > MAX_SAME_ENDING) out.push(`"${e}"로 끝나는 문장이 ${n}개다. 같은 말끝을 ${MAX_SAME_ENDING}번까지만 쓴다`);
  const motionKeys = new Map<string, number>();
  for (const s of b.scenes) {
    if (s.source !== "motion" || !s.motion) continue;
    const key = `${s.motion.kind}:${s.motion.title}:${s.motion.big}`;
    motionKeys.set(key, (motionKeys.get(key) ?? 0) + 1);
  }
  if ([...motionKeys.values()].some((n) => n > 1)) out.push("같은 설명 화면을 되풀이한다. 화면마다 내용을 다르게 하거나 다른 소재로 바꾼다");
  const uses = new Map<string, number>();
  b.scenes.forEach((s, i) => {
    // "P: 상세 문구"처럼 번호 뒤에 문구를 덧붙여도 번호만 본다. "일반 상식"은 카드 없이 쓰는 널리 알려진 내용이다
    const refs = s.evidence.map(evidenceRef);
    for (const r of refs) if (!validRefs.has(r)) out.push(`${i}번 장면의 근거 ${r}는 받은 자료에 없다`);
    if (s.part === "difference" && !refs.some((r) => r.startsWith("D"))) out.push(`${i}번 장면은 우리 차이인데 확정된 차이(D) 근거가 없다`);
    if (s.source === "photo" && !usable.has(s.source_id)) out.push(`${i}번 장면의 ${s.source_id}는 쓸 수 있는 후보가 아니다`);
    if (s.source === "gif" && !usableGifs.has(s.source_id)) out.push(`${i}번 장면의 ${s.source_id}는 쓸 수 있는 움직이는 이미지가 아니다`);
    if (s.source === "visual" && !b.visuals.some((v) => v.beat === i)) out.push(`${i}번 장면에 AI 이미지 설명(visuals)이 없다`);
    if (s.source === "visual" && i === b.scenes.length - 1) out.push("마지막 장면에는 AI 이미지를 쓰지 않는다");
    if (s.source === "stock" && !s.stock_query.trim()) out.push(`${i}번 장면에 스톡 검색어(stock_query)가 없다`);
    if (s.source === "motion" && i > 0 && b.scenes[i - 1].source === "motion") out.push(`${i}번 장면이 설명 화면을 연달아 쓴다`);
    if (s.source === "motion" && i === b.scenes.length - 1) out.push("마지막 장면은 설명 화면으로 쓰지 않는다");
    if (s.source === "archive" && !archiveIds.includes(s.source_id)) out.push(`${i}번 장면의 ${s.source_id}는 없는 자사 촬영 컷이다`);
    if (s.source === "motion" && motionEmpty(s.motion)) out.push(`${i}번 장면에 도식 값이 없다`);
    if (s.source === "motion" && stepsTooFew(s.motion)) out.push(`${i}번 장면의 목록 도식(steps) 항목이 1개다. 항목을 2~4개로 쓰거나 다른 도식 · 소재로 바꾼다`);
    if (s.source === "motion" && i === 0) out.push("첫 장면은 설명 화면으로 쓰지 않는다");
    uses.set(s.source_id, (uses.get(s.source_id) ?? 0) + 1);
    if (i > 0 && s.source_id && b.scenes[i - 1].source_id === s.source_id) out.push(`${i}번 장면이 앞 장면과 같은 이미지다`);
    if (!s.say.trim() || !s.tts.trim()) out.push(`${i}번 장면에 말이 없다`);
  });
  const limit = repeatLimit(realMaterialCount(b, archiveIds), b.scenes.length);
  for (const [id, n] of uses) if (id && n > limit) out.push(`${id}를 ${n}번 썼다. ${limit}번까지만 쓴다`);
  const textures = b.scenes.filter((s) => usable.get(s.source_id)?.kind === "texture");
  if (textures.length > 1) out.push("질감만 있는 사진을 한 번만 쓴다");
  if (b.scenes[0] && usable.get(b.scenes[0].source_id)?.kind === "texture") out.push("첫 장면에 질감만 있는 사진을 쓰지 않는다");
  if (new Set(b.scenes.map((s, i) => s.source_id || `${s.source}${i}`)).size < 6) out.push("서로 다른 화면을 6개 이상 쓴다");
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
  problems: z.array(z.string()).describe("반드시 고칠 문제만: 말이 안 되는 문장, 사실과 어긋남, 앞뒤 흐름이 끊겨 이해할 수 없음, 화면이 말과 정반대. 어느 장면의 어떤 말인지 구체적으로. 없으면 빈 배열"),
  notes: z.array(z.string()).describe("더 좋아질 수 있는 점. 사람이 참고할 의견이고 제작을 막지 않는다. 없으면 빈 배열"),
  interest: z.number().int().describe("상품에 관심 없는 사람이 끝까지 볼 만한 재미 1~5. 3 미만이면 수업이나 광고처럼 들리는 영상"),
  boring_parts: z.array(z.string()).describe("지루해서 넘길 만한 구간과 이유. 어느 장면인지 구체적으로. 없으면 빈 배열"),
  unsuitable_phrases: z.array(z.object({ kind: z.enum(["hook", "ending"]), reason: z.string() })).describe("소재/내용과 맞지 않아 교체해야 하는 저장 후킹 또는 마지막 문구. 그 외 문제는 problems에 쓴다"),
  topic_problem: z.string().describe("주제 자체가 쓰면 안 되는 것(우리에게 불리한 정보 · 뻔한 사용법을 고민처럼 꾸밈 · 이미 다 아는 내용만 말함)이면 그 이유 한 문장. 문장을 고쳐서 해결되는 문제는 여기 쓰지 않는다. 없으면 빈 문자열"),
});

/** 처음 보는 시청자처럼 읽는다. 점수가 아니라 말이 되는지, 이어지는지, 끌리는지를 본다. */
export async function reviewStoryboard(input: { board: Storyboard; facts: ProductFacts; knowledge: VideoKnowledge; sheets: string[]; fixedTexts: string[] }): Promise<{ problems: string[]; notes: string[]; interest: number; boringParts: string[]; unsuitable_phrases: { kind: "hook" | "ending"; reason: string }[]; topicProblem: string; tokens: { input: number; output: number } }> {
  const b = input.board;
  const model = agentModel();
  const completion = await getOpenAI().chat.completions.parse({
    model,
    ...callOptions(model, 3000),
    messages: [
      {
        role: "system",
        content: `너는 인스타 릴스를 넘겨 보는 평범한 시청자이자 깐깐한 편집장이다. 장면표를 읽고 실제로 문제가 되는 것만 적는다. 말투 취향이나 사소한 표현은 적지 않는다.
- 첫 문장: 소리 내어 읽었을 때 말이 되는가, 시청자가 멈출 이유가 있는가, 뜬금없는 숫자나 명령이 없는가.
- 궁금증 → 답: 첫 장면이 연 궁금증에 본문이 실제로 답하는가, 그 답이 이 상품과 이어지는가. 첫 장면과 상관없는 상품 설명으로 새지 않는가. 장면 순서 · 상품 이름이 나오는 위치는 정해져 있지 않으니 그 자체를 문제로 적지 않는다.
- 말하는 사람: 지어낸 인물 · 1인칭 체험 · 지어낸 후기가 없는가. "저희"(브랜드)가 말해도 되지만, 저희가 했다는 내용이 상품 자료에 없는 개발 과정 · 시행착오 · 숫자면 문제로 적는다.
- 흐름: 처음 보는 사람이 이게 뭔지 알아듣는가, 앞 문장에서 다음 문장으로 이어지는가, 강의처럼 사실만 나열하다 끝나지 않는가. 긴 영상이니 8~12초마다 다음이 궁금해지는가.
- 이해: 다 보고 나면 무슨 상품인지, 성분이나 품종이 무슨 뜻인지 말할 수 있는가. 확정된 우리 차이가 있으면 무엇이 다른지도 말할 수 있는가. 낯선 단어를 뜻 없이 넘기지 않는가.
- 상식과 효과: 원료 설명을 이 제품의 효과처럼 잇지 않는가. 원료의 숫자 · 통계 · 의학적 효과를 말로 읽지 않는가(화면 그래픽에 원료 특성으로 밝힌 것은 괜찮다). 널리 알려진 일반 상식은 상세페이지에 없어도 문제로 적지 않는다.
- 말투: "제품 안내에서는", "상세페이지에 따르면", "~래요"처럼 출처를 밝히며 전하는 말투가 있으면 직접 설명하는 말투로 고치라고 적는다.
- 재미: 이 상품을 살 생각이 없는 사람도 끝까지 볼 만한가. 다음 말이 궁금한가, 뻔한 사실을 읽어 주는 수업처럼 들리지 않는가. interest와 boring_parts에 솔직하게 적는다.
- 화면: 그 장면 이미지가 그 말과 맞는가. [스톡: ...]은 아직 받지 않은 분위기 영상이라 적힌 장면 설명으로 판단한다.
- 정보 가치: 후킹이 약속한 답이 구체적인가. 상품 이름과 장점만 나열하며 답을 피하지 않는가. 근거 있는 사용법/구분 정보로 답하는 영상은 허용한다.
- 마지막 말: 마지막 장면(마무리 · 요청)이 영상에서 실제로 말하거나 보여 준 내용과 맞는가. 영상에 없던 순서 · 방법 · 비교를 마지막에 처음 꺼내면 problems에 적는다.
- 주제: 아래 기준에 어긋나면 topic_problem에 적는다. 이것은 문장을 고쳐서 풀리지 않고 주제를 바꿔야 하는 문제다.
${TOPIC_RULES}
후킹의 질문에 본문이 실제로 답하는지, hook.answer와 evidence_scenes가 그 답과 맞는지 확인한다. '보라'고 약속한 제형/사용 장면은 실물이 있어야 한다. 상품 설명을 전하는 도식은 허용하되 체험의 증거로 보지 않는다.
실제 사용 영상이 없는 상품이 많다. 사용법이나 안내 문구를 말할 때 화면에 용기 · 상품 사진이 나오는 것은 문제가 아니다. 효과를 눈으로 보여 준다고 약속할 때만 문제다.
${input.fixedTexts.length ? `저장된 문구도 근거/소재/답 회수 검수에서 제외하지 않는다. 맞지 않으면 unsuitable_phrases에 종류와 이유를 쓴다. 첫 문장은 hook, 마지막 문장은 ending이다. 정상 후킹을 마지막 문구 때문에 교체하지 않는다: ${input.fixedTexts.join(" / ")}` : ""}`,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `상품: ${input.facts.name} — ${input.facts.oneLine ?? ""}\n상품 근거: ${input.facts.claims.map((c) => c.claim).join(" / ")}\n상세페이지 원문:\n${input.facts.sourceText}\n\n${knowledgeBlock(input.knowledge)}\n\n이 영상의 한 가지: ${b.one_thing}\n첫 장면이 여는 것: ${b.situation}\n궁금증: ${b.worry}\n이 주제를 고른 이유: ${b.question_reason}\n\n후킹 화면 글자: ${b.hook.on_screen.replace(/\n/g, " ")}\n장면:\n${b.scenes.map((s, i) => `${i}. (${s.part}) [${s.source === "stock" ? `스톡: ${s.shows}` : b.visuals.find((v) => v.beat === i) ? `AI 그림: ${b.visuals.find((v) => v.beat === i)!.subject}` : `${s.source_id}: ${b.photos.find((p) => p.id === s.source_id)?.what ?? b.gifs.find((g) => g.id === s.source_id)?.what ?? s.shows}`}] ${s.say}`).join("\n")}\n\n그림은 후보 이미지 묶음이다.`,
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
    notes: completion.choices[0]!.message.parsed!.notes,
    interest: completion.choices[0]!.message.parsed!.interest,
    boringParts: completion.choices[0]!.message.parsed!.boring_parts,
    unsuitable_phrases: completion.choices[0]!.message.parsed!.unsuitable_phrases,
    topicProblem: completion.choices[0]!.message.parsed!.topic_problem.trim(),
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
    // 마지막 기준 한 줄은 이제 어느 대본 방식에도 필수가 아니라 묻지 않는다(2026-11-10)
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
            text: `완성된 릴스의 프레임이다. 첫 이미지는 ${input.everySeconds.toFixed(1)}초 간격 연락판(왼쪽→오른쪽, 위→아래), 뒤는 휴대폰 크기 개별 프레임 ${input.frames.map((f) => f.at.toFixed(2)).join(", ")}초다. 말 시각표:\n${input.lines.map((l) => `${l.at.toFixed(1)}초 ${l.say}`).join("\n")}\n\n실제 문제만 시각과 함께 적는다. kind: caption=작거나 잘리거나 읽기 어려운 자막, layout=텍스트끼리 겹침/상품을 크게 가림, crop=제품의 중요한 부분이 잘림/지나친 확대, content=말과 소재/후킹 약속 불일치, blank=알아볼 수 없는 빈 화면. severity blocking은 시청/이해를 막는 문제, minor는 작은 개선점이다. 소개하는 상품이 아닌 다른 제품이 화면에 나오거나 제품이 눕혀져 보이면 content이고 blocking이다. 시연을 약속하지 않는 제품 소개에 포장 사진을 쓰는 것은 허용한다. 제품 사진 속 작은 인쇄 글자를 못 읽는 것은 자막 오류가 아니다. 전환 도중 한 장만 글자가 안 보이는 것은 오류로 적지 않는다. 없으면 빈 배열.`,
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

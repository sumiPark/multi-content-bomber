import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { conceptBlock } from "@/lib/agents/concept";
import { graphicSchema, visualRules, visualSchema } from "@/lib/agents/edit-plan";
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

// 장면표 에이전트 — AI 자동 영상의 말 · 이미지 · 화면 글자를 한 번에 정한다.
// 대본을 먼저 쓰고 소재를 나중에 붙이면 말과 화면이 어긋나서, 재료를 본 뒤 장면 단위로 함께 쓴다.

type Service = ReturnType<typeof createServiceClient>;

export const storyboardSchema = z.object({
  selling_point: z.string().describe("이 상품에서 시청자가 가장 끌릴 점 한 줄과 그 근거 사실"),
  story: z.string().describe("처음 보는 사람이 어떤 흐름으로 따라오게 할지 한 줄. 이 상품과 계정 설정에 맞게 정한다"),
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
  hook: z.object({
    spoken: z.string().describe("첫 장면에서 하는 말. 화면 표기로 쓴다"),
    on_screen: z.string().describe("첫 화면 큰 글자, spoken을 그대로 줄인 12자 안팎. 두 줄이면 줄바꿈"),
    highlight: z.string().describe("on_screen에서 강조할 낱말, 없으면 빈 문자열"),
    position: z.enum(["top", "lower"]).describe("제품을 가리지 않는 쪽"),
  }),
  scenes: z
    .array(
      z.object({
        source: z.enum(["photo", "archive", "motion"]).describe("photo 사진 후보, archive 자사 촬영 컷, motion 코드로 그리는 설명 화면"),
        source_id: z.string().describe("쓸 후보 번호 p1 또는 a1. motion이면 빈 문자열"),
        motion: motionSchema.nullable().describe("source가 motion이면 설명 화면 값, 아니면 null"),
        shows: z.string().describe("이 장면에서 시청자가 보는 것"),
        say: z.string().describe("이 장면의 말을 화면 표기로. 첫 장면은 hook.spoken과 같다"),
        tts: z.string().describe("say를 읽는 대로 바꾼 원고. 숫자와 영문을 말하는 대로"),
        captions: z.array(z.string()).describe("say를 의미 단위로 나눈 자막, 한 묶음 16자 이내. 이어 붙이면 say와 같아야 한다. 첫 장면은 빈 배열"),
        emphasis: z.array(z.string()).describe("자막에서 강조할 핵심어"),
        graphics: z.array(graphicSchema).describe("말에 맞춰 나오는 작은 그래픽, 없으면 빈 배열. 첫 장면은 빈 배열. 마지막 장면에는 end_card 하나"),
      }),
    )
    .describe("장면 5~8개, 합계 15~25초. 첫 장면 = 후킹"),
  visuals: z.array(visualSchema).describe("AI 이미지. beat는 장면 번호(0부터). 없으면 빈 배열"),
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
  const system = `너는 인스타그램 @${ctx.accountName} 릴스의 작가 겸 편집자다. 사람이 나오지 않고 상품 이미지로 만드는 영상의 장면표를 쓴다. 말과 화면을 장면마다 함께 정한다.
상품: ${f.shop} ${f.kindLabel} "${f.name}"
계정 역할: ${ctx.roleFocus === "PERSON" ? "사람 중심" : ctx.roleFocus === "PRODUCT" ? "상품 중심" : "미정"}

순서:
1. get_product_facts를 읽고 받은 이미지를 모두 본다. 무엇을 보여 줄 수 있는지 먼저 판단한다.
2. 이 상품에서 시청자가 끌릴 점을 고르고(selling_point), 보여 줄 수 있는 이미지로 어떻게 이어 갈지 정한다(story).
3. 장면마다 이미지 하나와 그 이미지를 보며 할 말을 정한다. time_script로 길이를 재고, check_rules로 금지 표현을 확인한다.

글:
- 소리 내어 읽었을 때 말이 되어야 한다. 처음 보는 사람이 상품이 무엇인지 알아듣고, 앞 문장에 이어 다음 문장을 자연스럽게 듣게 쓴다.
- 첫 문장은 시청자가 궁금해할 말이어야 한다. 용량 · 가격 같은 숫자는 그 자체로 궁금증이 아니면 첫 문장에 넣지 않는다.
- 장면에 없는 것을 말하지 않는다. 말하는 내용이 보이는 이미지를 고른다.
- 사실(숫자 · 성분 · 효과 · 구성)은 get_product_facts에 있는 것만. uncertainties에 있는 건 말하지 않는다.
- 사람이 써 본 것처럼 말하지 않는다. 지어낸 후기 · 체험을 쓰지 않는다. 최고 · 유일 · 100% 같은 단정을 쓰지 않는다.
- 건강기능식품 기능성 표현은 approvedClaims 문장 그대로만. 비어 있으면 기능성을 말하지 않는다.${f.kind === "COSMETIC" ? "\n- 화장품: 치료 · 재생 · 염증 같은 표현을 쓰지 않는다. 캡션에 개인차가 있음을 밝힌다." : ""}
- 판매 상태(재고 · 할인 · 배송)는 말하지 않는다. 인사 · 자기소개로 시작하지 않는다.
- 요청은 끝에 하나만 한다.

이미지:
- usable인 후보만 쓴다. 쓸 만한 후보가 3개 미만이면 모든 후보를 있는 그대로 판단해 내고 억지로 장면을 채우지 않는다.
- 첫 장면은 제품이나 가장 궁금한 장면이다. texture(질감만 있는 사진)는 무엇인지 말로 설명할 때 한 번만 쓰고 첫 장면에 쓰지 않는다.
- 같은 후보는 두 번까지, 연달아 쓰지 않는다. 자사 촬영 컷이 있으면 사진보다 먼저 고르고 후보마다 한 번만 쓴다.
- 인증서 · 표 · 그래프, 이 상품이 아닌 물건, 잘라 낼 수 없는 글자가 있으면 usable false. 위아래 글자 띠는 trim으로 잘라 낸다.
- 순서 · 구성 · 비교 · 숫자를 말하는 장면은 source를 motion으로 해 코드로 그린 설명 화면을 쓸 수 있다. 첫 장면에는 쓰지 않는다. 보여 줄 사진이 부족하면 motion을 늘린다. 값은 get_product_facts에 있는 것만 쓰고, 글자는 짧게, 색은 상품과 계정 분위기에 맞춘다. motion 장면에는 AI 이미지(visuals)를 넣지 않는다.

자막과 그래픽:
${bullets(kit.caption_rules)}
- 그래픽은 그 말을 할 때 나오게 at_word를 그 장면 말 속의 낱말로 쓴다. 자막과 같은 말을 되풀이하지 않는다.

읽기용 원고(tts):
${bullets(kit.tts_rules)}

글자 디자인(look):
${bullets(kit.look_rules)}${ctx.fontChoices?.length ? `\n\n글꼴: 이 영상의 제품 · 말의 내용 · 계정 분위기에 맞게 강조어 글꼴(key_font)과 작은 줄 글꼴(small_font)을 아래에서 하나씩 고른다. 습관처럼 같은 글꼴을 고르지 않는다. 자막은 짧게 지나가므로 한 번에 읽혀야 한다.\n${ctx.fontChoices.map((x) => `- ${x.name} · ${x.role} · ${x.look}`).join("\n")}` : ""}${visualRules(f.kind, ctx.visualLibrary ?? [])}${conceptBlock("이 계정의 AI 자동 업로드 컨셉", ctx.concept, "무엇을 말할지와 흐름에 반영한다.")}${conceptBlock("이 계정의 말투 · 분위기", ctx.tone, "말과 글자 디자인 · 음악에 반영한다.")}${conceptBlock("이 계정의 영상 스타일", ctx.videoStyle, "장면 고르기에 반영한다.")}${ctx.phraseBlock ?? ""}`;
  const user = `상세페이지 원문(사실은 이 안에서만 쓴다. "원료적 특성에 한함" 같은 단서가 붙은 내용은 말로 읽지 않고 표현을 낮춰 쓴다):\n${f.sourceText}\n\n쓸 수 있는 사진 후보(가로x세로): ${ctx.candidates.map((c) => `${c.id} ${c.w}x${c.h}`).join(", ")}
그림은 후보를 번호와 함께 모은 것이다. 위 목록에 없는 번호는 화질이 낮거나 세로 화면에서 제품이 잘려 쓰지 않는다.${ctx.archive.length ? `\n\n자사 촬영 컷(소리 없음, 순서대로 마지막 ${ctx.archive.length}장의 그림이 컷마다 프레임 3개):\n${ctx.archive.map((a) => `${a.id} ${a.seconds.toFixed(1)}초 — ${a.what}`).join("\n")}` : ""}${
    ctx.retry
      ? `\n\n먼저 쓴 장면표:\n${JSON.stringify({ hook: ctx.retry.board.hook, scenes: ctx.retry.board.scenes.map((s) => ({ source_id: s.source_id, say: s.say })), visuals: ctx.retry.board.visuals.map((v) => ({ beat: v.beat, subject: v.subject })) })}\n\n이 문제를 고쳐 전체를 다시 내라:\n${bullets(ctx.retry.problems)}`
      : ""
  }`;
  return runAgent({
    agent: "plan",
    system,
    user,
    userImages: [...ctx.sheets, ...ctx.archiveSheets],
    skills: writerSkills({ facts: ctx.facts, rules: ctx.rules, accountName: ctx.accountName }).filter((s) => ["get_product_facts", "time_script", "check_rules"].includes(s.name)),
    outputSchema: storyboardSchema,
    outputName: "storyboard",
    maxSteps: 8,
    service: ctx.service,
    readService: ctx.readService,
    planId: ctx.planId,
    input: { product: f.name, candidates: ctx.candidates.length, archive: ctx.archive.length, retry: ctx.retry?.problems ?? [] },
  });
}

const squash = (t: string) => t.replace(/[\s.,!?~·…'"]+/g, "");

/** 코드로 확인할 수 있는 문제. */
export function storyboardProblems(b: Storyboard, archiveIds: string[], fixedHook: boolean): string[] {
  const out: string[] = [];
  const usable = new Map(b.photos.filter((p) => p.usable).map((p) => [p.id, p]));
  if (b.scenes.length < 4) out.push("장면이 너무 적다. 5~8개로 쓴다");
  const uses = new Map<string, number>();
  b.scenes.forEach((s, i) => {
    if (s.source === "photo" && !usable.has(s.source_id)) out.push(`${i}번 장면의 ${s.source_id}는 쓸 수 있는 후보가 아니다`);
    if (s.source === "archive" && !archiveIds.includes(s.source_id)) out.push(`${i}번 장면의 ${s.source_id}는 없는 자사 촬영 컷이다`);
    if (s.source === "motion" && motionEmpty(s.motion)) out.push(`${i}번 장면에 도식 값이 없다`);
    if (s.source === "motion" && i === 0) out.push("첫 장면은 설명 화면으로 쓰지 않는다");
    uses.set(s.source_id, (uses.get(s.source_id) ?? 0) + 1);
    if (i > 0 && b.scenes[i - 1].source_id === s.source_id) out.push(`${i}번 장면이 앞 장면과 같은 이미지다`);
    if (!s.say.trim() || !s.tts.trim()) out.push(`${i}번 장면에 말이 없다`);
  });
  for (const [id, n] of uses) if (n > 2) out.push(`${id}를 ${n}번 썼다. 두 번까지만 쓴다`);
  const textures = b.scenes.filter((s) => usable.get(s.source_id)?.kind === "texture");
  if (textures.length > 1) out.push("질감만 있는 사진을 한 번만 쓴다");
  if (b.scenes[0] && usable.get(b.scenes[0].source_id)?.kind === "texture") out.push("첫 장면에 질감만 있는 사진을 쓰지 않는다");
  if (new Set(b.scenes.map((s) => s.source_id)).size < 3) out.push("서로 다른 이미지를 3개 이상 쓴다");
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
});

/** 처음 보는 시청자처럼 읽는다. 점수가 아니라 말이 되는지, 이어지는지, 끌리는지를 본다. */
export async function reviewStoryboard(input: { board: Storyboard; facts: ProductFacts; sheets: string[]; fixedTexts: string[] }): Promise<{ problems: string[]; tokens: { input: number; output: number } }> {
  const b = input.board;
  const model = agentModel();
  const completion = await getOpenAI().chat.completions.parse({
    model,
    ...callOptions(model, 2000),
    messages: [
      {
        role: "system",
        content: `너는 인스타 릴스를 넘겨 보는 평범한 시청자이자 깐깐한 편집장이다. 장면표를 읽고 실제로 문제가 되는 것만 적는다. 말투 취향이나 사소한 표현은 적지 않는다.
- 첫 문장: 소리 내어 읽었을 때 말이 되는가, 다음이 궁금한가, 뜬금없는 숫자나 명령이 없는가.
- 흐름: 처음 보는 사람이 이게 뭔지 알아듣는가, 앞 문장에서 다음 문장으로 이어지는가, 나열만 하다 끝나지 않는가.
- 화면: 그 장면 이미지가 그 말과 맞는가.
- 매력: 상품 사실 가운데 끌리는 점이 살았는가, 사용법 안내문처럼 끝나지 않는가.
${input.fixedTexts.length ? `사람이 정한 고정 문구라 고칠 수 없다. 문제로 적지 않는다: ${input.fixedTexts.join(" / ")}` : ""}`,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `상품: ${input.facts.name} — ${input.facts.oneLine ?? ""}\n상품 근거: ${input.facts.claims.map((c) => c.claim).join(" / ")}\n상세페이지 원문:\n${input.facts.sourceText}\n\n후킹 화면 글자: ${b.hook.on_screen.replace(/\n/g, " ")}\n장면:\n${b.scenes.map((s, i) => `${i}. [${b.visuals.find((v) => v.beat === i) ? `AI 그림: ${b.visuals.find((v) => v.beat === i)!.subject}` : `${s.source_id}: ${b.photos.find((p) => p.id === s.source_id)?.what ?? s.shows}`}] ${s.say}`).join("\n")}\n\n그림은 후보 이미지 묶음이다.`,
          },
          ...input.sheets.slice(0, 3).map((url) => ({ type: "image_url" as const, image_url: { url, detail: "low" as const } })),
        ],
      },
    ],
    response_format: zodResponseFormat(reviewSchema, "storyboard_review"),
  });
  return {
    problems: completion.choices[0]?.message?.parsed?.problems ?? [],
    tokens: { input: completion.usage?.prompt_tokens ?? 0, output: completion.usage?.completion_tokens ?? 0 },
  };
}

/** 완성본 프레임을 본다. 얹은 자막까지 들어간 실제 화면 검사다. */
export async function reviewFinalFrames(input: { sheet: string; lines: { at: number; say: string }[]; everySeconds: number }): Promise<{ issues: string[]; tokens: { input: number; output: number } }> {
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
            text: `완성된 릴스의 프레임이다. ${input.everySeconds.toFixed(1)}초마다 한 장, 왼쪽에서 오른쪽, 위에서 아래 순서다. 말 시각표:\n${input.lines.map((l) => `${l.at.toFixed(1)}초 ${l.say}`).join("\n")}\n\n실제 문제만 시각과 함께 적는다: 무엇인지 알 수 없는 빈 화면, 제품이 이상하게 잘리거나 지나치게 확대됨, 글자가 안 읽히거나 겹침, 글자가 제품 글자를 가림, 말과 화면이 맞지 않음. 없으면 빈 배열.`,
          },
          { type: "image_url", image_url: { url: input.sheet, detail: "high" } },
        ],
      },
    ],
    response_format: zodResponseFormat(z.object({ issues: z.array(z.string()) }), "final_review"),
  });
  return {
    issues: completion.choices[0]?.message?.parsed?.issues ?? [],
    tokens: { input: completion.usage?.prompt_tokens ?? 0, output: completion.usage?.completion_tokens ?? 0 },
  };
}

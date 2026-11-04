import { z } from "zod";
import { conceptBlock } from "@/lib/agents/concept";
import { runAgent, type AgentResult } from "@/lib/agents/runner";
import { selectSkills, type SelectContext } from "@/lib/agents/select";
import { KIND_LABEL, SHOPS } from "@/lib/products/shops";

// 직접 촬영 기획 — 계정별 기획 목록(날짜 · 시각 없음, 계정당 5개 유지)에 넣을 기획을 낸다(상품 선정(1) + 기획(2)을 한 번에).
// 사람은 "촬영 기획 고르기" 화면에서 찍을 수 있을 때 하나를 고른다. 고르면 컷 리스트(shotlist.ts)가 이어진다.
// 상품 후보 규칙(판매 중 · 분석 완료 · 최근 사용 · 다른 계정 목록과 중복)은 상품 선정 에이전트와 같은 스킬이 건다.
// 사람이 보고 고를 수 있게 대본 초안(첫 문장 + 장면 흐름)도 같이 쓴다. 다 쓴 컷 리스트는 비싸서 고른 기획만 만들고, 이 초안을 따라 다듬는다.

export type PlanAContext = SelectContext & {
  // 이번에 채울 기획 개수
  count: number;
};

const ideaSchema = z.object({
  product_id: z.string().describe("list_candidates가 준 id만"),
  title: z.string().describe("기획 제목, 20자 안팎 (예: 세럼 제형 실험)"),
  format: z.string().describe("형식 이름 — 제형 실험 · 자르고 단면 · 비교 · 고르는 법 · 보관법 · 루틴 · 코디 · 언박싱 등"),
  concept: z.string().describe("무엇을 어떻게 찍는지 1~2문장. 휴대폰 하나로 사무실 · 집에서 찍을 수 있어야 한다"),
  why: z.string().describe("왜 이 기획인지 — 상품 근거 · 지난 게시물 반응 · 제철 등 (1문장)"),
  draft: z
    .object({
      hook: z.string().describe("영상 첫 문장. 사람이 말하거나 화면에 크게 나갈 말. 인사 · 자기소개 없이 바로 시작"),
      beats: z
        .array(
          z.object({
            scene: z.string().describe("이 장면에서 보이는 것, 짧게"),
            line: z.string().describe("이 장면의 대사나 화면 문구, 한 문장"),
          }),
        )
        .describe("첫 문장 뒤로 이어지는 장면 3~5개, 15~25초 분량"),
    })
    .describe("사람이 고를 때 읽는 대본 초안"),
});

const planASchema = z.object({
  ideas: z.array(ideaSchema).describe("상품과 형식이 서로 다른 기획"),
});
export type PlanAOutput = z.infer<typeof planASchema>;
export type PlanAIdea = z.infer<typeof ideaSchema>;

function systemPrompt(ctx: PlanAContext): string {
  const focus =
    ctx.roleFocus === "PERSON" ? "사람 중심(사람이 나와 쓰는 모습 · 일상 · 공감)" : ctx.roleFocus === "PRODUCT" ? "상품 중심(손 · 제형 · 구성 클로즈업, 얼굴 없이)" : "미정";
  return `너는 인스타그램 @${ctx.accountName}의 릴스 기획자다. 사람이 휴대폰으로 직접 찍고, AI 편집본을 받아 다듬어 직접 올린다.
계정 역할: ${focus}${ctx.roleNote ? ` — ${ctx.roleNote}` : ""}
쓸 수 있는 상품: ${ctx.scopes.map((s) => `${SHOPS[s.shop].name} ${KIND_LABEL[s.kind]}`).join(", ")}

할 일: 이 계정의 촬영 기획 목록에 넣을 기획 ${ctx.count}개. 날짜 · 시각은 정하지 않는다. 사람이 찍을 수 있을 때 고른다.
- 반드시 list_candidates로 후보를 받고 그 안의 id만 쓴다. 상품을 지어내지 않는다.
- 기획마다 상품이 달라야 하고, 형식도 되도록 겹치지 않아야 고르는 의미가 있다.
- 실제로 찍을 수 있는 기획만: 휴대폰 한 대, 사무실 · 집, 혼자 또는 둘, 15~25초. 촬영 장비 · 장소 섭외 · 다른 사람 얼굴이 필요한 기획은 안 된다.
- 찍으면 보이는 것으로 보여 준다: 제형 · 단면 · 크기 비교 · 사용 과정 · 구성. 효과 전후 비교, 장기 사용 결과처럼 촬영으로 증명할 수 없는 기획은 안 된다.
- 근거가 있는 특징(topClaims · get_product)을 찍을 거리로 바꾼다. 최근 게시물 반응(account_recent_posts)이 있으면 잘된 형식을 참고한다.
- 건강기능식품은 기능성 효과를 보여 주는 기획을 하지 않는다(구성 · 먹는 방법 · 맛 · 포장 위주).
- why는 사람이 고를 때 읽는다. 짧고 구체적으로.
- draft는 사람이 읽고 고르는 대본 초안이다. 기획을 고르기 전에 get_product로 사실을 확인하고, 거기 있는 숫자 · 성분 · 효과만 쓴다. 1인칭은 그 장면에서 실제로 보여 주는 것까지만.
- draft 말투는 짧은 구어체. 최고 · 유일 · 100% 같은 단정, 효과 보장, 번역투를 쓰지 않는다.
- 후보가 모자라면 있는 만큼만.${conceptBlock("이 계정의 직접 촬영 컨셉", ctx.concept, "기획 형식 · 찍는 방식 · 분위기를 이 방향에 맞추고, why에 어떻게 맞췄는지 적는다.")}`;
}

export async function planShootIdeas(ctx: PlanAContext, opts: { log: boolean }): Promise<AgentResult<PlanAOutput>> {
  const cache = { ids: new Set<string>() };
  const result = await runAgent({
    agent: "plan",
    system: systemPrompt(ctx),
    user: `직접 찍을 릴스 기획 ${ctx.count}개를 내 줘.`,
    skills: selectSkills(ctx, cache),
    outputSchema: planASchema,
    outputName: "shoot_ideas",
    maxSteps: 12,
    service: opts.log ? ctx.service : null,
    readService: ctx.service,
    accountId: ctx.accountId,
    input: { track: "A", account: ctx.accountName, count: ctx.count, concept: ctx.concept ?? null },
  });

  // 코드로 한 번 더: 후보에서 받은 id만, 한 상품은 한 기획에만, 정한 개수까지.
  const used = new Set<string>();
  const ideas = result.output.ideas
    .filter((i) => {
      if (!cache.ids.has(i.product_id) || used.has(i.product_id)) return false;
      used.add(i.product_id);
      return true;
    })
    .slice(0, ctx.count);
  return { ...result, output: { ideas } };
}

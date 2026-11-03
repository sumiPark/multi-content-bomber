import { z } from "zod";
import { runAgent, type AgentResult } from "@/lib/agents/runner";
import { selectSkills, topicLine, type SelectContext } from "@/lib/agents/select";
import { KIND_LABEL, SHOPS } from "@/lib/products/shops";

// 직접 촬영 기획 — 12 · 18시 칸마다 무엇을 찍을지 기획안 후보 2~3개를 낸다(상품 선정(1) + 기획(2)을 한 번에).
// 사람은 "촬영 기획 고르기" 화면에서 하나를 고르거나 상품을 직접 지정한다. 고르면 컷 리스트(shotlist.ts)가 이어진다.
// 상품 후보 규칙(판매 중 · 분석 완료 · 반복 간격 · 같은 날 다른 계정 미사용)은 상품 선정 에이전트와 같은 스킬이 건다.

export type PlanAContext = SelectContext;

const ideaSchema = z.object({
  product_id: z.string().describe("list_candidates가 준 id만"),
  title: z.string().describe("기획 제목, 20자 안팎 (예: 세럼 제형 실험)"),
  format: z.string().describe("형식 이름 — 제형 실험 · 자르고 단면 · 비교 · 고르는 법 · 보관법 · 루틴 · 코디 · 언박싱 등"),
  concept: z.string().describe("무엇을 어떻게 찍는지 1~2문장. 휴대폰 하나로 사무실 · 집에서 찍을 수 있어야 한다"),
  why: z.string().describe("왜 이 기획인지 — 상품 근거 · 지난 게시물 반응 · 제철 등 (1문장)"),
});

const planASchema = z.object({
  slots: z.array(
    z.object({
      slot_time: z.string().describe("HH:MM — 주어진 칸 중 하나"),
      ideas: z.array(ideaSchema).describe("서로 다른 상품 · 형식으로 2~3개"),
    }),
  ),
});
export type PlanAOutput = z.infer<typeof planASchema>;
export type PlanAIdea = z.infer<typeof ideaSchema>;

function systemPrompt(ctx: PlanAContext): string {
  const focus =
    ctx.roleFocus === "PERSON" ? "사람 중심(사람이 나와 쓰는 모습 · 일상 · 공감)" : ctx.roleFocus === "PRODUCT" ? "상품 중심(손 · 제형 · 구성 클로즈업, 얼굴 없이)" : "미정";
  return `너는 인스타그램 @${ctx.accountName}의 릴스 기획자다. 이 칸은 사람이 휴대폰으로 직접 찍고 AI가 자막 · 컷을 편집한다.
계정 역할: ${focus}${ctx.roleNote ? ` — ${ctx.roleNote}` : ""}
쓸 수 있는 상품: ${ctx.scopes.map((s) => `${SHOPS[s.shop].name} ${KIND_LABEL[s.kind]}`).join(", ")}

할 일: ${ctx.slotDate}의 칸(${ctx.slotTimes.join(", ")})마다 기획안 후보 2~3개.
- 반드시 list_candidates로 후보를 받고 그 안의 id만 쓴다. 상품을 지어내지 않는다.
- 한 칸 안의 후보는 상품도 형식도 서로 달라야 고르는 의미가 있다. 다른 칸과도 상품이 겹치지 않게 한다.
- 실제로 찍을 수 있는 기획만: 휴대폰 한 대, 사무실 · 집, 혼자 또는 둘, 15~25초. 촬영 장비 · 장소 섭외 · 다른 사람 얼굴이 필요한 기획은 안 된다.
- 찍으면 보이는 것으로 보여 준다: 제형 · 단면 · 크기 비교 · 사용 과정 · 구성. 효과 전후 비교, 장기 사용 결과처럼 촬영으로 증명할 수 없는 기획은 안 된다.
- 근거가 있는 특징(topClaims · get_product)을 찍을 거리로 바꾼다. 최근 게시물 반응(account_recent_posts)이 있으면 잘된 형식을 참고한다.
- 건강기능식품은 기능성 효과를 보여 주는 기획을 하지 않는다(구성 · 먹는 방법 · 맛 · 포장 위주).
- why는 사람이 고를 때 읽는다. 짧고 구체적으로.
- 후보가 모자라면 있는 만큼만.${topicLine(ctx, "상품 · 기획")}`;
}

export async function planShootIdeas(ctx: PlanAContext, opts: { log: boolean }): Promise<AgentResult<PlanAOutput>> {
  const cache = { ids: new Set<string>() };
  const result = await runAgent({
    agent: "plan",
    system: systemPrompt(ctx),
    user: `${ctx.slotDate} ${ctx.slotTimes.join(", ")} 칸에 직접 찍을 릴스 기획안 후보를 내 줘.`,
    skills: selectSkills(ctx, cache),
    outputSchema: planASchema,
    outputName: "shoot_ideas",
    maxSteps: 10,
    service: opts.log ? ctx.service : null,
    readService: ctx.service,
    accountId: ctx.accountId,
    input: { track: "A", account: ctx.accountName, slotDate: ctx.slotDate, slotTimes: ctx.slotTimes, slotTopics: ctx.slotTopics ?? {} },
  });

  // 코드로 한 번 더: 후보에서 받은 id만, 칸마다 하나, 한 상품은 한 칸에만, 칸당 최대 3개.
  const used = new Set<string>();
  const bySlot = new Map<string, PlanAIdea[]>();
  for (const slot of result.output.slots) {
    if (!ctx.slotTimes.includes(slot.slot_time) || bySlot.has(slot.slot_time)) continue;
    const ideas = slot.ideas
      .filter((i) => {
        if (!cache.ids.has(i.product_id) || used.has(i.product_id)) return false;
        used.add(i.product_id);
        return true;
      })
      .slice(0, 3);
    if (ideas.length) bySlot.set(slot.slot_time, ideas);
  }
  return { ...result, output: { slots: [...bySlot].map(([slot_time, ideas]) => ({ slot_time, ideas })) } };
}

import { z } from "zod";
import { conceptBlock } from "@/lib/agents/concept";
import type { ProductFacts } from "@/lib/agents/product-facts";
import { runAgent, type AgentResult } from "@/lib/agents/runner";
import { writerSkills } from "@/lib/agents/script";
import type { ContentRule } from "@/lib/rules/check";
import type { createServiceClient } from "@/lib/supabase/service";

// 소재 에이전트 — AI 자동 콘텐츠의 대본 비트마다 어떤 소재를 쓸지 정한다(촬영이 없는 대신 이 단계가 있다).
// ① 상세페이지 제품 사진 ② 무료 스톡 분위기 영상 ③ 코드 모션 ④ 자사 촬영 제품 컷. 사진 후보는 코드가 미리 잘라 번호를 붙여 준다.
// AI는 고르고 값을 쓰기만 한다. 움직임 · 내려받기 · 렌더링은 코드(lib/auto-video)가 한다.

type Service = ReturnType<typeof createServiceClient>;

export const motionSchema = z.object({
  kind: z.enum(["compare", "count", "steps", "big_fact"]).describe("compare 둘 비교 · 단계 변화, count 숫자가 차오름, steps 차례 · 목록, big_fact 큰 숫자 · 낱말 하나"),
  title: z.string().describe("도식 위 작은 제목, 14자 이내. 없으면 빈 문자열"),
  left_label: z.string().describe("compare 왼쪽 이름. 다른 종류면 빈 문자열"),
  right_label: z.string().describe("compare 오른쪽 이름"),
  left_value: z.string().describe("compare 왼쪽 값, 6자 이내"),
  right_values: z.array(z.string()).describe("compare 오른쪽 값이 차례로 바뀌는 단계, 1~5개. 6자 이내. 근거에 있는 값만"),
  number_to: z.number().describe("count가 도달할 숫자. 다른 종류면 0"),
  unit: z.string().describe("count · big_fact 단위. 없으면 빈 문자열"),
  end_text: z.string().describe("count가 끝난 뒤 나오는 짧은 글, 10자 이내. 없으면 빈 문자열"),
  items: z.array(z.string()).describe("steps 항목, 2~4개. 각 12자 이내"),
  big: z.string().describe("big_fact의 큰 글자, 6자 이내. 다른 종류면 빈 문자열"),
  accent: z.string().describe("강조색 #RRGGBB. 상품 사진과 계정 분위기에 맞춘다"),
});
export type MotionSpec = z.infer<typeof motionSchema>;

export const sourcePlanSchema = z.object({
  photos: z
    .array(
      z.object({
        id: z.string().describe("후보 번호 p1, p2 ..."),
        usable: z.boolean().describe("이 상품의 실물이나 제형 · 질감이 보이고, 사람 얼굴 · 다른 브랜드가 없고, 글자를 잘라 낼 수 있으면 true"),
        what: z.string().describe("사진에 보이는 것 한 줄"),
        trim_top: z.number().describe("위에서 잘라 낼 비율 0~0.6. 글자 띠 · 제목이 위에 있으면 그만큼"),
        trim_bottom: z.number().describe("아래에서 잘라 낼 비율 0~0.6"),
      }),
    )
    .describe("모든 후보를 판단한다"),
  beats: z
    .array(
      z.object({
        beat: z.number().int().describe("대본 비트 번호(0부터)"),
        use: z.enum(["photo", "stock", "motion", "archive"]),
        archive_id: z.string().describe("use가 archive면 자사 촬영 컷 번호 a1, a2 ..., 아니면 빈 문자열"),
        photo_id: z.string().describe("use가 photo면 usable인 후보 번호, 아니면 빈 문자열"),
        stock_query: z.string().describe("use가 stock이면 영어 검색어 2~3낱말(상표 · 인물 없이), 아니면 빈 문자열"),
        stock_intent: z.string().describe("use가 stock이면 원하는 장면 한국어 한 문장, 아니면 빈 문자열"),
        motion: motionSchema.nullable().describe("use가 motion이면 도식 값, 아니면 null"),
      }),
    )
    .describe("대본 비트마다 하나"),
  warnings: z.array(z.string()).describe("사람이 결정해야 하는 문제만: 쓸 사진이 전혀 없음, 사진이 안전 주의사항과 부딪힘. 어떤 소재로 대체했는지 같은 작업 설명과 문구 제안은 쓰지 않는다. 없으면 빈 배열"),
});
export type SourcePlan = z.infer<typeof sourcePlanSchema>;

export interface SourceContext {
  service: Service | null;
  readService?: Service;
  planId?: string;
  accountName: string;
  facts: ProductFacts;
  rules: ContentRule[];
  beats: { spoken: string; on_screen: string; visual: string }[];
  candidates: { id: string; w: number; h: number }[];
  sheets: string[];
  archive?: { id: string; what: string; seconds: number }[];
  archiveSheets?: string[];
  tone?: string | null;
  videoStyle?: string | null;
  retry?: { problems: string[] } | null;
}

export async function writeSourcePlan(ctx: SourceContext): Promise<AgentResult<SourcePlan>> {
  const f = ctx.facts;
  const archive = ctx.archive ?? [];
  const system = `너는 인스타그램 @${ctx.accountName} 릴스의 소재 담당이다. 촬영본 없이 영상을 만든다. 대본 비트마다 쓸 소재를 정한다.
상품: ${f.shop} ${f.kindLabel} "${f.name}"

소재 세 가지:
- photo: 대표 이미지와 상세페이지의 사진 후보(번호 붙은 그림). 카메라가 천천히 움직이는 컷이 된다. 이 상품을 보여 주는 비트의 기본이고, 쓸 사진이 있으면 비트의 절반 이상에 쓴다.
- motion: 코드로 그리는 설명 도식. 숫자 · 비교 · 차례를 말할 때 쓴다. 값은 get_product_facts에 있는 것만 쓴다.
- stock: 무료 분위기 영상. 상황 · 공감 문장에만, 한 영상에 2개 이내. 상품 기능을 말하는 비트에는 쓰지 않는다.
${archive.length ? "- archive: 우리가 이 상품을 직접 찍은 짧은 영상(소리 없음, 얼굴 없음, 손이 나올 수 있음). 상품을 보여 주는 비트에 사진보다 먼저 고른다. 한 영상에 2개 이내, 같은 컷은 한 번만 쓴다.\n" : ""}
사진 후보 판단:
- 사람 얼굴이 보이면 usable false(모델 사진은 초상권 문제가 있어 움직이지 않는다). 손 · 팔만 보이면 괜찮다.
- 이 상품의 제형 · 질감을 보여 주는 사진은 쓸 수 있다. 다만 그 사진을 효과의 증거처럼 말하지 않는다.
- 이 상품이 아닌 물건, 인증서 · 표 · 그래프 · 비교 그림, 성분 목록은 false. 그림 위에 글자가 박혀 잘라 낼 수 없으면 false. 제품 글자나 로고가 화면 끝에서 잘려 보이면 false.
- 위나 아래에 글자 띠가 있으면 trim_top, trim_bottom으로 잘라 내고 쓴다. 제품 표면에 인쇄된 글자는 괜찮다.
- 제품 주의사항과 부딪히는 사진은 쓰지 않거나 warnings에 적는다.

규칙:
- 첫 비트(후킹)에는 가장 궁금한 장면을 쓴다. 같은 사진을 세 비트 넘게 쓰지 않는다.
- 상품이 매력적으로 보이는 장면을 우선한다. 쓸 사진이 3장 이상이면 motion은 2개 이내로 쓰고, 정말 숫자 · 비교가 필요한 비트에만 쓴다. 쓸 사진이 적으면 motion을 늘린다. 근거 없는 숫자 · 효과를 도식에 넣지 않는다. uncertainties에 있는 내용은 넣지 않는다.
- 건강기능식품 기능성은 approvedClaims 그대로만, 화장품은 치료 · 재생 같은 표현을 쓰지 않는다.
- 도식의 글자는 짧게, 색은 계정 분위기와 상품에 맞춘다.${conceptBlock("이 계정의 말투 · 분위기", ctx.tone, "도식의 말과 색에 반영한다.")}${conceptBlock("이 계정의 영상 스타일", ctx.videoStyle, "소재 비율과 도식 분위기에 반영한다.")}`;
  const user = `대본 비트:
${ctx.beats.map((b, i) => `${i}. "${b.spoken}"${b.on_screen ? ` [화면 문구: ${b.on_screen}]` : ""}${b.visual ? ` (원하는 장면: ${b.visual})` : ""}`).join("\n")}

사진 후보(가로x세로): ${ctx.candidates.map((c) => `${c.id} ${c.w}x${c.h}`).join(", ") || "없음"}
그림은 후보를 번호와 함께 모은 것이다.${archive.length ? `\n\n자사 촬영 컷(소리 없음, 순서대로 마지막 ${archive.length}장의 그림이 컷마다 프레임 3개):\n${archive.map((a) => `${a.id} ${a.seconds.toFixed(1)}초 — ${a.what}`).join("\n")}` : ""}${ctx.retry ? `\n\n먼저 낸 답이 점검에 걸렸다. 고쳐서 전체를 다시 내라:\n${ctx.retry.problems.map((p) => `- ${p}`).join("\n")}` : ""}`;
  return runAgent({
    agent: "edit",
    system,
    user,
    userImages: [...ctx.sheets, ...(ctx.archiveSheets ?? [])],
    skills: writerSkills({ facts: ctx.facts, rules: ctx.rules, accountName: ctx.accountName }).filter((s) => s.name === "get_product_facts" || s.name === "check_rules"),
    outputSchema: sourcePlanSchema,
    outputName: "source_plan",
    maxSteps: 6,
    service: ctx.service,
    readService: ctx.readService,
    planId: ctx.planId,
    input: { product: f.name, beats: ctx.beats.length, candidates: ctx.candidates.length, archive: archive.length },
  });
}

/** 코드로 확인할 수 있는 문제. 다시 쓰게 하거나 워커가 대체한다. */
export function sourcePlanProblems(plan: SourcePlan, beatCount: number, archiveIds: string[] = []): string[] {
  const out: string[] = [];
  const archiveUses = new Map<string, number>();
  const usable = new Set(plan.photos.filter((p) => p.usable).map((p) => p.id));
  const seen = new Set<number>();
  let stock = 0;
  const photoUses = new Map<string, number>();
  for (const b of plan.beats) {
    seen.add(b.beat);
    if (b.use === "photo") {
      if (!usable.has(b.photo_id)) out.push(`${b.beat}번 비트의 사진 ${b.photo_id}는 쓸 수 있는 후보가 아니다`);
      photoUses.set(b.photo_id, (photoUses.get(b.photo_id) ?? 0) + 1);
    }
    if (b.use === "archive") {
      if (!archiveIds.includes(b.archive_id)) out.push(`${b.beat}번 비트의 자사 촬영 컷 ${b.archive_id}는 쓸 수 있는 후보가 아니다`);
      archiveUses.set(b.archive_id, (archiveUses.get(b.archive_id) ?? 0) + 1);
    }
    if (b.use === "stock") {
      stock++;
      if (!b.stock_query.trim()) out.push(`${b.beat}번 비트에 스톡 검색어가 없다`);
    }
    if (b.use === "motion") {
      const m = b.motion;
      const empty =
        !m ||
        (m.kind === "steps" && !m.items.some((t) => t.trim())) ||
        (m.kind === "big_fact" && !m.big.trim()) ||
        (m.kind === "compare" && !m.left_value.trim() && !m.right_values.some((t) => t.trim()));
      if (empty) out.push(`${b.beat}번 비트에 도식 값이 없다`);
    }
  }
  for (let i = 0; i < beatCount; i++) if (!seen.has(i)) out.push(`${i}번 비트의 소재가 없다`);
  if (stock > 2) out.push("스톡은 2개 이내로 줄인다");
  const motions = plan.beats.filter((b) => b.use === "motion").length;
  if (usable.size >= 3 && motions > 2) out.push(`쓸 사진이 ${usable.size}장인데 도식이 ${motions}개다. 2개 이내로 줄이고 사진을 쓴다`);
  if ([...archiveUses.values()].reduce((sum, n) => sum + n, 0) > 2) out.push("자사 촬영 컷은 2개 이내로 줄인다");
  for (const [id, n] of archiveUses) if (n > 1) out.push(`자사 촬영 컷 ${id}는 한 번만 쓴다`);
  for (const [id, n] of photoUses) if (n > 3) out.push(`사진 ${id}를 ${n}번 썼다. 3번 이내로 줄인다`);
  return out;
}

import { z } from "zod";
import { conceptBlock } from "@/lib/agents/concept";
import { videoProductName } from "@/lib/agents/product-facts";
import { runAgent, type AgentResult, type AgentSkill } from "@/lib/agents/runner";
import { addDays } from "@/lib/automation/time";
import { KIND_LABEL, SHOPS, type ProductKind, type ShopCode } from "@/lib/products/shops";
import type { createServiceClient } from "@/lib/supabase/service";

// 상품 선정 에이전트(1) — B 트랙 칸마다 어떤 상품으로 영상을 만들지 제안한다. 사람은 컨펌만.
// AI 판단에 맡기면 안 되는 규칙은 스킬(코드)이 먼저 걸러서 후보에서 뺀다:
//   판매 중 · 제외 안 됨 · 상세페이지 분석 완료(ready), 건강기능식품은 확정 심의 문구가 있어야,
//   이 계정에서 repeat_gap_days 안에 쓴 상품 빼기, 같은 날 다른 계정이 쓰는 상품 빼기.

type Service = ReturnType<typeof createServiceClient>;
export type ProductScope = { shop: ShopCode; kind: Exclude<ProductKind, "OTHER"> };

export interface SelectContext {
  service: Service;
  accountId: string;
  accountName: string;
  roleFocus: string | null;
  roleNote: string | null;
  scopes: ProductScope[];
  repeatGapDays: number;
  slotDate: string;
  slotTimes: string[];
  // 편성표 칸 주제 (slot_time → 주제, 0031). 사람이 정한 것만 들어 있다.
  slotTopics?: Record<string, string>;
  // 계정 컨셉(0038) — AI 자동 칸은 auto_notes(0052, 바꾸고 싶은 점), 직접 촬영 칸은 shoot_concept
  concept?: string | null;
  // 이번 실행에서 앞 계정이 이미 고른 상품 (아직 DB에 없을 수 있어 따로 넘긴다)
  alsoBlocked: Set<string>;
  // 직접 촬영 기획 목록을 채울 때 — 다른 계정 목록에 있거나 이 계정에서 방금 지운 상품도 뺀다
  shootPlanning?: boolean;
}

// 직접 촬영에서 진행 중인 상태 — 날짜가 없어 "같은 날" 대신 이 상태로 중복을 본다
const SHOOT_COMMITTED = ["CONFIRMED", "SCRIPTED", "SHOT", "RENDERED", "BLOCKED"];
// 사람이 지우거나 새로 고침한 기획의 상품은 한동안 다시 내지 않는다(새로 고침이 같은 기획을 내지 않게)
const DISMISSED_KEEP_DAYS = 7;

const pickSchema = z.object({
  picks: z.array(
    z.object({
      slot_time: z.string().describe("HH:MM — 주어진 B 칸 중 하나"),
      product_id: z.string().describe("list_candidates가 준 id만"),
      reason: z.string().describe("이 상품을 이 칸에 고른 이유 (한국어 1~2문장, 근거 위주)"),
      alternatives: z
        .array(z.object({ product_id: z.string(), reason: z.string() }))
        .describe("사람이 바꿀 때 볼 다른 후보 2~3개"),
    }),
  ),
});
export type SelectOutput = z.infer<typeof pickSchema>;

type AnalysisSummary = { oneLine?: string };

// 직접 촬영 기획(plan-a.ts)도 같은 후보 규칙을 쓴다.
export async function candidateRows(ctx: Pick<SelectContext, "service" | "accountId" | "scopes" | "repeatGapDays" | "slotDate" | "alsoBlocked" | "shootPlanning">) {
  const s = ctx.service;
  const since = addDays(ctx.slotDate, -ctx.repeatGapDays);
  const sinceMs = Date.now() - ctx.repeatGapDays * 86_400_000;
  const dismissedSinceMs = Date.now() - DISMISSED_KEEP_DAYS * 86_400_000;
  const [{ data: usedHere }, { data: usedToday }, { data: shootRows }] = await Promise.all([
    s
      .from("content_plans")
      .select("product_id, slot_date")
      .eq("social_account_id", ctx.accountId)
      .gte("slot_date", since)
      .not("status", "in", "(SKIPPED,FAILED)")
      .not("product_id", "is", null),
    s
      .from("content_plans")
      .select("product_id")
      .eq("slot_date", ctx.slotDate)
      .neq("social_account_id", ctx.accountId)
      .not("status", "in", "(SKIPPED,FAILED)")
      .not("product_id", "is", null),
    // 직접 촬영 기획은 날짜가 없어 위 두 조건에 안 잡힌다
    s
      .from("content_plans")
      .select("product_id, social_account_id, status, created_at, updated_at, posted_at")
      .eq("track", "A")
      .neq("status", "FAILED")
      .not("product_id", "is", null),
  ]);
  const blocked = new Set([...(usedHere ?? []), ...(usedToday ?? [])].map((r) => r.product_id as string));
  for (const id of ctx.alsoBlocked) blocked.add(id);
  for (const p of shootRows ?? []) {
    const mine = p.social_account_id === ctx.accountId;
    const block =
      p.status === "SKIPPED"
        ? !!ctx.shootPlanning && mine && Date.parse(p.updated_at) >= dismissedSinceMs
        : mine
          ? Date.parse(p.posted_at ?? p.created_at) >= sinceMs
          : SHOOT_COMMITTED.includes(p.status) || (!!ctx.shootPlanning && p.status === "PROPOSED");
    if (block) blocked.add(p.product_id as string);
  }

  const rows = [];
  for (const scope of ctx.scopes) {
    const { data, error } = await s
      .from("products")
      .select("id, shop_code, kind, name, price, raw, product_analyses!inner(summary, claims, health_functional)")
      .eq("shop_code", scope.shop)
      .eq("kind", scope.kind)
      .eq("stock_status", "available")
      .eq("excluded", false)
      .eq("analysis_state", "ready")
      .limit(300);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
  }

  // 건강기능식품은 사람이 확정한 심의 문구가 있어야 B에 쓴다(없으면 기능성 표현을 못 씀).
  const healthIds = rows.filter((r) => r.product_analyses.health_functional).map((r) => r.id);
  const approved = new Set<string>();
  if (healthIds.length) {
    const { data } = await s.from("product_claim_approvals").select("product_id").in("product_id", healthIds);
    for (const a of data ?? []) approved.add(a.product_id);
  }

  return rows
    .filter((r) => !blocked.has(r.id))
    .filter((r) => !r.product_analyses.health_functional || approved.has(r.id))
    .map((r) => {
      const raw = (r.raw ?? {}) as { salesQuantity?: number | null; reviewCount?: number | null; scoreAverage?: number | null };
      const claims = (Array.isArray(r.product_analyses.claims) ? r.product_analyses.claims : []) as { claim: string }[];
      return {
        id: r.id,
        shop: SHOPS[r.shop_code as ShopCode]?.name ?? r.shop_code,
        kind: KIND_LABEL[(r.kind ?? "OTHER") as ProductKind],
        name: videoProductName(r.name),
        price: r.price,
        oneLine: (r.product_analyses.summary as AnalysisSummary)?.oneLine ?? null,
        topClaims: claims.slice(0, 3).map((c) => c.claim),
        healthFunctional: r.product_analyses.health_functional,
        sales: raw.salesQuantity ?? null,
        reviews: raw.reviewCount ?? null,
        rating: raw.scoreAverage ?? null,
      };
    });
}

export function selectSkills(ctx: Parameters<typeof candidateRows>[0], cache: { ids: Set<string> }): AgentSkill[] {
  const listCandidates: AgentSkill = {
    name: "list_candidates",
    description:
      "이 계정이 쓸 수 있는 상품 후보 (판매 중 · 분석 완료 · 최근 사용 안 함 · 다른 계정과 겹치지 않는 것만). 판매량 · 후기 수 많은 순.",
    input: z.object({
      kind: z.enum(["FRUIT", "COSMETIC", "HEALTH_FOOD", "CLOTHING"]).nullable().describe("종류로 좁히기, 전체면 null"),
      limit: z.number().int().min(5).max(60).describe("최대 개수 (보통 30)"),
    }),
    async run(args) {
      const a = args as { kind: ProductKind | null; limit: number };
      const all = await candidateRows(ctx);
      const filtered = all
        .filter((c) => !a.kind || c.kind === KIND_LABEL[a.kind])
        .sort((x, y) => (y.sales ?? 0) + (y.reviews ?? 0) * 5 - ((x.sales ?? 0) + (x.reviews ?? 0) * 5))
        .slice(0, a.limit);
      for (const c of filtered) cache.ids.add(c.id);
      return { total: all.length, candidates: filtered };
    },
  };

  const getProduct: AgentSkill = {
    name: "get_product",
    description: "후보 상품 하나의 상세 요약 · 원문 근거가 확인된 특징 · 주의사항",
    input: z.object({ id: z.string() }),
    async run(args) {
      const { id } = args as { id: string };
      const { data, error } = await ctx.service
        .from("products")
        .select("name, price, category_name, detail_image_urls, product_analyses(summary, claims, uncertainties)")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new Error("상품 없음");
      return {
        name: videoProductName(data.name),
        price: data.price,
        category: data.category_name,
        detailImages: data.detail_image_urls.length,
        summary: data.product_analyses?.summary ?? null,
        claims: data.product_analyses?.claims ?? [],
        uncertainties: data.product_analyses?.uncertainties ?? [],
      };
    },
  };

  const recentPosts: AgentSkill = {
    name: "account_recent_posts",
    description: "이 계정의 최근 인스타 게시물과 성과(있으면) — 어떤 상품 · 소재가 반응이 좋았는지 볼 때",
    input: z.object({ limit: z.number().int().min(5).max(30) }),
    async run(args) {
      const { limit } = args as { limit: number };
      const { data: posts } = await ctx.service
        .from("social_posts")
        .select("id, caption, media_product_type, posted_at")
        .eq("social_account_id", ctx.accountId)
        .order("posted_at", { ascending: false })
        .limit(limit);
      const ids = (posts ?? []).map((p) => p.id);
      const { data: metrics } = ids.length
        ? await ctx.service.from("post_latest_metrics").select("post_id, views, likes, saved, shares").in("post_id", ids)
        : { data: [] };
      const m = new Map((metrics ?? []).map((x) => [x.post_id, x]));
      return (posts ?? []).map((p) => ({
        caption: p.caption?.split("\n")[0]?.slice(0, 80) ?? null,
        type: p.media_product_type,
        postedAt: p.posted_at,
        ...(m.get(p.id) ?? {}),
      }));
    },
  };

  return [listCandidates, getProduct, recentPosts];
}

/** 편성표 주제 안내 한 줄 — 주제가 정해진 칸이 없으면 빈 문자열(프롬프트가 예전과 같다). */
export function topicLine(ctx: Pick<SelectContext, "slotTimes" | "slotTopics">, what: string): string {
  const pairs = ctx.slotTimes.filter((t) => ctx.slotTopics?.[t]).map((t) => `${t} = ${ctx.slotTopics![t]}`);
  if (pairs.length === 0) return "";
  return `
- 편성표 칸 주제(사람이 정함): ${pairs.join(" · ")}. 이 주제에 맞는 ${what}을 먼저 찾고, 맞는 후보가 없으면 주제와 가장 가까운 것으로 고른 뒤 이유에 그렇게 적는다.`;
}

function systemPrompt(ctx: SelectContext): string {
  const focus = ctx.roleFocus === "PERSON" ? "사람 중심(1인칭 후기 · 일상 루틴)" : ctx.roleFocus === "PRODUCT" ? "상품 중심(성분 · 제형 · 구성 · 가격)" : "미정";
  return `너는 인스타그램 계정 @${ctx.accountName}의 B 트랙(AI 자동 생성 릴스) 상품 선정 담당이다.
계정 역할: ${focus}${ctx.roleNote ? ` — ${ctx.roleNote}` : ""}
쓸 수 있는 상품: ${ctx.scopes.map((s) => `${SHOPS[s.shop].name} ${KIND_LABEL[s.kind]}`).join(", ")}

할 일: ${ctx.slotDate}의 B 칸(${ctx.slotTimes.join(", ")})마다 상품 하나씩 고른다.
- 반드시 list_candidates로 후보를 받고, 그 안의 id만 쓴다. 후보에 없는 상품을 지어내지 않는다.
- 같은 날 두 칸에 같은 상품을 쓰지 않는다. 가능하면 종류 · 가격대가 다른 상품으로 섞는다.
- B 영상은 사람이 보지 않고 나가므로, 원문 근거가 있는 특징(topClaims)이 분명하고 영상 소재(상세 이미지)가 넉넉한 상품을 우선한다.
- 판매량 · 후기가 많은 상품은 근거가 되지만 그것만 보지 말고, 최근 게시물 반응(account_recent_posts)이 있으면 참고한다.
- 과일은 제철 · 지금 판매 중인 상품을 고른다. 건강기능식품은 기능성 표현에 기대지 않는 특징이 있는지 본다.
- reason은 사람이 컨펌할 때 읽는다. 짧고 구체적으로(왜 이 상품, 왜 이 시간대).
- 후보가 칸 수보다 적으면 있는 만큼만 고른다.${topicLine(ctx, "상품")}${conceptBlock("이 계정의 AI 자동 업로드 컨셉", ctx.concept, "이 방향에 맞는 상품을 먼저 고르고, reason에 왜 맞는지 적는다.")}`;
}

export async function selectProducts(
  ctx: SelectContext,
  opts: { log: boolean },
): Promise<AgentResult<SelectOutput>> {
  const cache = { ids: new Set<string>() };
  const result = await runAgent({
    agent: "select",
    system: systemPrompt(ctx),
    user: `${ctx.slotDate} B 칸 ${ctx.slotTimes.join(", ")}에 넣을 상품을 골라 줘.`,
    skills: selectSkills(ctx, cache),
    outputSchema: pickSchema,
    outputName: "product_picks",
    service: opts.log ? ctx.service : null,
    readService: ctx.service,
    accountId: ctx.accountId,
    input: { account: ctx.accountName, slotDate: ctx.slotDate, slotTimes: ctx.slotTimes, slotTopics: ctx.slotTopics ?? {}, concept: ctx.concept ?? null },
  });

  // 코드로 한 번 더: 후보에서 받은 id만, 칸마다 하나, 같은 상품 중복 없음.
  const seen = new Set<string>();
  const picks = result.output.picks.filter((p) => {
    if (!ctx.slotTimes.includes(p.slot_time) || !cache.ids.has(p.product_id) || seen.has(p.product_id)) return false;
    seen.add(p.product_id);
    return true;
  });
  const bySlot = new Map(picks.map((p) => [p.slot_time, p]));
  return {
    ...result,
    output: {
      picks: [...bySlot.values()].map((p) => ({
        ...p,
        alternatives: p.alternatives.filter((a) => cache.ids.has(a.product_id) && a.product_id !== p.product_id).slice(0, 3),
      })),
    },
  };
}

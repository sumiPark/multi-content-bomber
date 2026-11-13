import { z } from "zod";
import { KIND_LABEL, SHOPS, type ProductKind, type ShopCode } from "@/lib/products/shops";
import { createServiceClient } from "@/lib/supabase/service";
import type { McpServer, McpTool } from "./server";

// MCB 상품 MCP — 세 몰(오늘과일 · 쿠마마켓 · 리유) 상품, 상세페이지 분석, 확정 심의 문구, 표현 규칙을
// Claude(claude.ai 커넥터 · Claude Code)가 읽는다. 기존 리유 MCP(ChatGPT-Codex/ai-recommend)를 대체.
// 모두 읽기 전용. 제외(excluded)한 상품은 보여 주지 않는다.

const SHOP_ENUM = z.enum(["cuma", "cm", "ru"]);
const KIND_ENUM = z.enum(["FRUIT", "FOOD", "COSMETIC", "HEALTH_FOOD", "CLOTHING"]);
const SOURCE_TEXT_LIMIT = 8000;

const INSTRUCTIONS = `MCB 상품 카탈로그 MCP입니다. 오늘과일(과일 · 채소 · 수산 · 축산 · 식품) · 쿠마마켓(식품/건기식) · 리유코스메틱(화장품 · 건강식품 · 의류) 상품과,
상세페이지(이미지)를 AI가 읽어 만든 요약을 읽기 전용으로 제공합니다. 인스타 릴스 · 캡션 제작용입니다.
권장 순서: search_products로 후보 찾기 → get_products로 상세(근거 인용 · 원문 · 확정 심의 문구) 확인 → get_rules로 표현 규칙 확인.
콘텐츠 작성 원칙:
- 특징 · 효능은 claims(원문 근거가 확인된 문장)와 sourceText에 있는 내용만 씁니다. uncertainties의 항목은 단정하지 않습니다.
- analysisState가 ready가 아니면(review · insufficient 등) 사람이 아직 확인하지 않은 요약이니 초안에만 쓰고 그렇게 밝힙니다.
- analysisState가 pending · queued · analyzing이면 상세페이지를 아직 분석하지 않은 상품입니다. 요약 · 근거가 비어 있으니 특징 · 효능을 쓰지 않습니다.
- 건강기능식품: approvedClaims(사람이 확정한 심의 문구)만 기능성 표현으로 씁니다. 비어 있으면 기능성 표현을 쓰지 않습니다.
  healthFunctional이 false인 식품에는 기능성 표현을 붙이지 않습니다.
- 화장품: 질병 치료 · 예방, 의약품 오인 표현(치료, 완치, 염증 개선, 재생), 기능성 표기 없는 미백 · 주름 · 자외선 차단 주장,
  최상급 · 절대 표현, 타사 비방을 쓰지 않고 개인차를 밝힙니다. get_rules의 금지 표현은 모두 피합니다.
- stockStatus가 available이 아닌 상품은 판매 중처럼 소개하지 않습니다. 가격 · 재고는 게시 직전에 url에서 다시 확인합니다.
- 이미지는 images.main · images.detail(몰 공식 자산)만 소재로 씁니다.`;

const db = () => createServiceClient();

// PostgREST or() 필터에 들어갈 검색어 — 구분 문자를 지운다.
const safeQuery = (q: string) => q.replace(/[,()%*\\]/g, " ").trim();

// 분석 전으로 보는 상태(0057) — 상세페이지를 아직 분석하지 않았거나 분석 중
const NOT_ANALYZED = ["pending", "queued", "analyzing"];

type AnalysisSummary = { oneLine?: string; usage?: string; cautions?: string; details?: Record<string, unknown> };

const searchProducts: McpTool = {
  name: "search_products",
  title: "상품 찾기",
  description: "상품명 · 몰 요약 · 한 줄 소개로 상품을 찾습니다. 몰(shop)과 종류(kind)로 좁힐 수 있습니다.",
  input: z.object({
    query: z.string().max(100).default("").describe("검색어 (비우면 최근 상품)"),
    shop: SHOP_ENUM.optional().describe("cuma=오늘과일, cm=쿠마마켓, ru=리유코스메틱"),
    kind: KIND_ENUM.optional().describe("FRUIT 과일 · FOOD 식품(채소 · 수산 · 축산 · 가공식품) · COSMETIC 화장품 · HEALTH_FOOD 건기식 · CLOTHING 의류"),
    includeOutOfStock: z.boolean().default(false).describe("일시 품절 · 판매 중지 포함"),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  async run(args) {
    const a = args as { query: string; shop?: ShopCode; kind?: ProductKind; includeOutOfStock: boolean; limit: number };
    let q = db()
      .from("products")
      .select("id, shop_code, kind, name, summary_title, price, stock_status, url, represent_image_url, analysis_state, product_analyses(summary, health_functional)")
      .eq("excluded", false)
      .order("updated_at", { ascending: false })
      .limit(a.limit);
    if (a.shop) q = q.eq("shop_code", a.shop);
    if (a.kind) q = q.eq("kind", a.kind);
    q = a.includeOutOfStock ? q.neq("stock_status", "unavailable") : q.eq("stock_status", "available");
    const term = safeQuery(a.query);
    if (term) q = q.or(`name.ilike.%${term}%,summary_title.ilike.%${term}%`);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return {
      total: data.length,
      products: data.map((p) => {
        // 분석 전(0057) 상품에 남은 예전 분석은 상세페이지가 바뀐 뒤라 내보내지 않는다
        const an = NOT_ANALYZED.includes(p.analysis_state) ? null : p.product_analyses;
        return {
          id: p.id,
          shop: SHOPS[p.shop_code as ShopCode]?.name ?? p.shop_code,
          kind: KIND_LABEL[(p.kind ?? "OTHER") as ProductKind],
          name: p.name,
          price: p.price,
          stockStatus: p.stock_status,
          url: p.url,
          image: p.represent_image_url,
          oneLine: (an?.summary as AnalysisSummary | undefined)?.oneLine ?? p.summary_title,
          analysisState: p.analysis_state,
          healthFunctional: an?.health_functional ?? null,
        };
      }),
    };
  },
};

const getProducts: McpTool = {
  name: "get_products",
  title: "상품 상세",
  description: "상품 1~5개의 상세: 분석 요약 · 종류별 항목 · 원문 근거가 확인된 특징 · 확정 심의 문구 · 이미지 · 상세페이지 원문.",
  input: z.object({
    ids: z.array(z.string().uuid()).min(1).max(5).describe("search_products가 준 id"),
    sourceText: z.boolean().default(true).describe("상세페이지에서 받아 적은 원문 포함 (이미지 순서, 최대 8000자)"),
  }),
  async run(args) {
    const a = args as { ids: string[]; sourceText: boolean };
    const client = db();
    const [{ data: products, error }, { data: extracts }, { data: approvals }] = await Promise.all([
      client
        .from("products")
        .select("id, shop_code, kind, name, summary_title, category_name, price, stock_status, url, represent_image_url, detail_image_urls, analysis_state, analysis_note, product_analyses(summary, claims, health_functional, functional_claims, uncertainties, edited, approved_at, analyzed_at, model)")
        .in("id", a.ids)
        .eq("excluded", false),
      a.sourceText
        ? client.from("product_image_extracts").select("product_id, image_index, text").in("product_id", a.ids)
        : Promise.resolve({ data: [] as { product_id: string; image_index: number; text: string }[] }),
      client.from("product_claim_approvals").select("product_id, claim").in("product_id", a.ids),
    ]);
    if (error) throw new Error(error.message);

    return (products ?? []).map((p) => {
      // 분석 전(0057) 상품은 요약 · 근거 · 원문을 비워 둔다(예전 분석이 남아 있어도 상세페이지가 바뀐 뒤다)
      const notAnalyzed = NOT_ANALYZED.includes(p.analysis_state);
      const an = notAnalyzed ? null : p.product_analyses;
      const summary = (an?.summary ?? {}) as AnalysisSummary;
      let budget = SOURCE_TEXT_LIMIT;
      const sourceText = (notAnalyzed ? [] : (extracts ?? []))
        .filter((e) => e.product_id === p.id)
        .sort((x, y) => x.image_index - y.image_index)
        .map((e) => {
          const t = e.text.slice(0, Math.max(0, budget));
          budget -= t.length;
          return { image: e.image_index, text: t };
        })
        .filter((e) => e.text);
      return {
        id: p.id,
        shop: SHOPS[p.shop_code as ShopCode]?.name ?? p.shop_code,
        kind: KIND_LABEL[(p.kind ?? "OTHER") as ProductKind],
        name: p.name,
        mallSummary: p.summary_title,
        category: p.category_name,
        price: p.price,
        stockStatus: p.stock_status,
        url: p.url,
        images: { main: p.represent_image_url, detail: p.detail_image_urls },
        analysisState: p.analysis_state,
        analysisNote: notAnalyzed ? "분석 전 — 상세페이지를 아직 분석하지 않은 상품이라 요약 · 근거가 없어요. 콘텐츠에 쓰려면 MCB 상품 화면에서 분석을 요청해 주세요." : p.analysis_note,
        oneLine: summary.oneLine ?? null,
        usage: summary.usage ?? null,
        cautions: summary.cautions ?? null,
        details: summary.details ?? null,
        claims: an?.claims ?? [],
        uncertainties: an?.uncertainties ?? [],
        healthFunctional: an?.health_functional ?? null,
        functionalClaimCandidates: an?.functional_claims ?? [],
        approvedClaims: (approvals ?? []).filter((x) => x.product_id === p.id).map((x) => x.claim),
        reviewedByHuman: !!an?.approved_at,
        analyzedAt: an?.analyzed_at ?? null,
        sourceText,
      };
    });
  },
};

const getRules: McpTool = {
  name: "get_rules",
  title: "표현 규칙",
  description: "켜져 있는 금지 표현 · 꼭 넣을 문구. kind를 주면 그 종류 + 전체 공통 규칙만.",
  input: z.object({ kind: KIND_ENUM.optional() }),
  async run(args) {
    const a = args as { kind?: ProductKind };
    let q = db()
      .from("content_rules")
      .select("scope, rule_type, phrase, match_type, reason, suggestion")
      .eq("active", true);
    if (a.kind) q = q.in("scope", ["ALL", a.kind]);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return {
      banned: data.filter((r) => r.rule_type === "BANNED").map((r) => ({ scope: r.scope, phrase: r.phrase, regex: r.match_type === "REGEX", reason: r.reason, suggestion: r.suggestion })),
      required: data.filter((r) => r.rule_type === "REQUIRED").map((r) => ({ scope: r.scope, phrase: r.phrase, reason: r.reason })),
    };
  },
};

export const catalogServer: McpServer = {
  name: "mcb-catalog",
  version: "1.0.0",
  instructions: INSTRUCTIONS,
  tools: [searchProducts, getProducts, getRules],
};

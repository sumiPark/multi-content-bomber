import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { ProductFacts } from "@/lib/agents/product-facts";
import { agentModel } from "@/lib/agents/runner";
import { firstLine, HIT_MULTIPLE } from "@/lib/benchmark/discovery";
import type { InsightSummary, ReelStyle } from "@/lib/benchmark/style-stats";
import { getOpenAI } from "@/lib/openai";
import { callOptions } from "@/lib/products/analysis/analyze";
import type { createServiceClient } from "@/lib/supabase/service";

// AI 자동 대본의 주제 · 후킹 재료 — 우리 계정에서 성과가 높았던 릴스와 다른 계정에서 성과가 높았던 릴스.
// 상세페이지만 보고 주제를 정하면 상품 설명서 같은 영상이 나와서(2026-11-10 사용자 결정), 주제 · 첫 문장은 여기서 가져오고
// 상세페이지는 상품 사실을 확인하는 데만 쓴다. 워커가 이미 수집한 값만 읽고 인스타를 부르지 않는다.
// 2026-11-10 사용자 결정: 다른 계정 릴스는 영상 분석이 있는 것만, 이 상품과 같은 상품군만 쓰고(과일 영상에 소시지 · 굿즈 릴스가 섞였다),
// 우리 계정 릴스를 먼저 본다.

type Service = ReturnType<typeof createServiceClient>;

// 분석 화면(lib/benchmark/load.ts)과 같은 기준: 최근 180일, 평소의 3배 이상, 광고 의심 · 캠페인(30배 이상) 제외, 한 계정 3개까지
const WINDOW_DAYS = 180;
const CAMPAIGN_MULTIPLE = 30;
const PER_ACCOUNT = 3;
const MAX_HITS = 10;
const MAX_OWN = 8;
// 상품군으로 거르기 전 후보 수. 걸러지고 남은 것에서 위 개수만큼 쓴다
const POOL_HITS = 40;
const POOL_OWN = 24;

export interface ReferenceReel {
  ref: string;
  account: string;
  hook: string;
  /** 다른 계정 릴스: 그 계정 평소 조회수의 몇 배인지 */
  multiple: number | null;
  views: number | null;
  saved: number | null;
  shares: number | null;
  formula: string | null;
  /** 영상 분석이 있으면: 여는 방식 · 형식 · 특징 */
  style: string | null;
  /** 무엇을 다룬 릴스인지(캡션 앞부분 · 영상 특징). 상품군을 가리는 데만 쓰고 프롬프트에는 넣지 않는다 */
  about: string;
}

export interface ReelReferences {
  /** 다른 계정에서 성과가 높았던 릴스 (B1...) */
  benchmark: ReferenceReel[];
  /** 우리 계정에서 성과가 높았던 릴스 (O1...) */
  own: ReferenceReel[];
  /** 최근 분석 요약 문장 */
  insights: string[];
}

export const EMPTY_REFERENCES: ReelReferences = { benchmark: [], own: [], insights: [] };

function styleLine(style: ReelStyle | null): string | null {
  if (!style) return null;
  const parts = [style.opening, style.format, style.note].filter((t) => t && t !== "알 수 없음" && t !== "기타");
  return parts.length ? parts.join(" · ") : null;
}

const snippet = (caption: string | null) => (caption ?? "").replace(/\s+/g, " ").trim().slice(0, 120);

/** 상품군으로 거르기 전 후보. 다른 계정은 영상 분석이 있는 릴스만, 한 계정 개수 제한은 거른 뒤(pickSameCategory)에 건다. */
export async function loadReelReferences(service: Service, socialAccountId: string, now = Date.now()): Promise<ReelReferences> {
  const since = new Date(now - WINDOW_DAYS * 86_400_000).toISOString();

  const { data: links } = await service.from("benchmark_links").select("benchmark_account_id, benchmark_accounts(id, username)").eq("social_account_id", socialAccountId);
  const names = new Map<string, string>();
  for (const l of links ?? []) {
    const a = l.benchmark_accounts as unknown as { id: string; username: string } | null;
    if (a) names.set(a.id, a.username);
  }
  const { data: posts } = names.size
    ? await service
        .from("benchmark_posts")
        .select("benchmark_account_id, caption, view_count, multiple, formula, style")
        .in("benchmark_account_id", [...names.keys()])
        .eq("media_product_type", "REELS")
        .eq("ad_suspected", false)
        // 캡션 · 표지만 본 릴스는 무엇이 시청자를 멈췄는지 알 수 없어 쓰지 않는다
        .eq("style_source", "VIDEO")
        .gte("multiple", HIT_MULTIPLE)
        .lt("multiple", CAMPAIGN_MULTIPLE)
        .gte("posted_at", since)
        .order("multiple", { ascending: false })
        .limit(POOL_HITS)
    : { data: [] };
  const benchmark: ReferenceReel[] = [];
  for (const p of posts ?? []) {
    const style = (p.style ?? null) as unknown as ReelStyle | null;
    // 영상 분석이 읽은 실제 첫 마디
    const hook = style?.hookLine?.trim() ?? "";
    if (!hook) continue;
    benchmark.push({
      ref: `B${benchmark.length + 1}`,
      account: names.get(p.benchmark_account_id) ?? "",
      hook,
      multiple: p.multiple == null ? null : Number(p.multiple),
      views: p.view_count,
      saved: null,
      shares: null,
      formula: p.formula,
      style: styleLine(style),
      about: [style?.note, snippet(p.caption)].filter(Boolean).join(" / "),
    });
  }

  // 우리 계정 릴스는 저장 · 공유가 많은 순(다시 볼 이유가 있는 영상)으로, 조회수가 같으면 조회수 순
  const { data: ownRows } = await service
    .from("account_post_stats")
    .select("caption, views, saved, shares")
    .eq("social_account_id", socialAccountId)
    .eq("media_product_type", "REELS")
    .not("views", "is", null)
    .gte("posted_at", since)
    .order("views", { ascending: false })
    .limit(POOL_OWN * 3);
  const ownSorted = (ownRows ?? [])
    .map((r) => ({ ...r, hook: firstLine(r.caption) }))
    .filter((r) => r.hook)
    .sort((a, b) => (b.saved ?? 0) + (b.shares ?? 0) - ((a.saved ?? 0) + (a.shares ?? 0)) || (b.views ?? 0) - (a.views ?? 0))
    .slice(0, POOL_OWN);
  const own: ReferenceReel[] = ownSorted.map((r, i) => ({ ref: `O${i + 1}`, account: "우리 계정", hook: r.hook, multiple: null, views: r.views, saved: r.saved, shares: r.shares, formula: null, style: null, about: snippet(r.caption) }));

  const insights: string[] = [];
  const { data: bench } = await service.from("benchmark_analyses").select("summary").eq("social_account_id", socialAccountId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const summary = (bench?.summary ?? null) as unknown as InsightSummary | null;
  if (summary?.headline) insights.push(`다른 계정 분석: ${summary.headline}`);
  for (const p of summary?.points ?? []) if (p.apply) insights.push(`다른 계정 분석: ${p.apply}`);
  const { data: perf } = await service.from("post_analyses").select("headline, actions").eq("social_account_id", socialAccountId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (perf?.headline) insights.push(`우리 계정 성과 분석: ${perf.headline}`);
  for (const a of ((perf?.actions ?? []) as unknown as { text?: string }[]).slice(0, 4)) if (a.text) insights.push(`우리 계정 성과 분석: ${a.text}`);

  return { benchmark, own, insights: insights.slice(0, 8) };
}

/**
 * 상품군으로 고른 뒤 개수를 맞추고 번호를 다시 붙인다. 순서(다른 계정은 배수 순, 우리 계정은 저장 · 공유 순)는 그대로 둔다.
 * 다른 계정은 한 계정 3개 · 전체 10개, 우리 계정은 8개까지.
 */
export function capReferences(refs: ReelReferences, keepBenchmark: Set<string>, keepOwn: Set<string>): ReelReferences {
  const perAccount = new Map<string, number>();
  const benchmark: ReferenceReel[] = [];
  for (const r of refs.benchmark) {
    if (!keepBenchmark.has(r.ref) || benchmark.length >= MAX_HITS) continue;
    const n = perAccount.get(r.account) ?? 0;
    if (n >= PER_ACCOUNT) continue;
    perAccount.set(r.account, n + 1);
    benchmark.push({ ...r, ref: `B${benchmark.length + 1}` });
  }
  const own = refs.own.filter((r) => keepOwn.has(r.ref)).slice(0, MAX_OWN).map((r, i) => ({ ...r, ref: `O${i + 1}` }));
  return { benchmark, own, insights: refs.insights };
}

/**
 * 이 상품과 같은 상품군을 다룬 릴스만 남긴다(과일이면 과일 · 제철 먹거리, 화장품이면 같은 쓰임의 화장품).
 * 계정 단위(같은 업종 · 이웃 업종)로는 가릴 수 없어(편의점 계정의 소시지 · 굿즈 릴스) 릴스마다 본다.
 * 분석 요약은 상품군과 상관없는 계정 단위 판단이라 그대로 둔다.
 */
export async function pickSameCategory(refs: ReelReferences, facts: ProductFacts): Promise<{ refs: ReelReferences; tokens: { input: number; output: number } }> {
  const all = [...refs.own, ...refs.benchmark];
  if (!all.length) return { refs, tokens: { input: 0, output: 0 } };
  const model = agentModel();
  const completion = await getOpenAI().chat.completions.parse({
    model,
    ...callOptions(model, 800),
    messages: [
      {
        role: "user",
        content: `아래 릴스 가운데 이 상품과 같은 상품군을 다룬 것의 번호만 고른다.
같은 상품군: 시청자가 같은 필요로 찾는 물건이다. 과일이면 과일 · 채소 같은 신선 먹거리, 건강식품이면 건강식품 · 영양제, 스킨케어면 스킨케어. 색조 화장품 · 가공 간식 · 캐릭터 상품 · 약 · 시술처럼 쓰임이 다른 것은 고르지 않는다. 애매하면 고르지 않는다.

상품: ${facts.shop} ${facts.kindLabel} "${facts.name}"${facts.oneLine ? ` — ${facts.oneLine}` : ""}

릴스:
${all.map((r) => `${r.ref}. "${r.hook}" / ${r.about || "내용 정보 없음"}`).join("\n")}`,
      },
    ],
    response_format: zodResponseFormat(z.object({ same: z.array(z.string()) }), "same_category_reels"),
  });
  const same = new Set((completion.choices[0]?.message?.parsed?.same ?? []).map((s) => s.trim().toUpperCase()));
  return {
    refs: capReferences(refs, same, same),
    tokens: { input: completion.usage?.prompt_tokens ?? 0, output: completion.usage?.completion_tokens ?? 0 },
  };
}

const num = (n: number | null) => (n == null ? "" : n >= 10_000 ? `${Math.round(n / 1000) / 10}만` : n.toLocaleString("en-US"));

/** 각도 · 장면표 프롬프트에 넣는 참고 릴스 묶음. 우리 계정 릴스를 먼저 둔다. 참고가 하나도 없으면 빈 문자열. */
export function referenceBlock(refs: ReelReferences): string {
  if (!refs.benchmark.length && !refs.own.length && !refs.insights.length) return "";
  const line = (r: ReferenceReel) =>
    `${r.ref} [${r.account}${r.multiple ? ` · 평소의 ${r.multiple.toFixed(1)}배` : ""}${r.views ? ` · 조회 ${num(r.views)}` : ""}${r.saved ? ` · 저장 ${num(r.saved)}` : ""}${r.shares ? ` · 공유 ${num(r.shares)}` : ""}] "${r.hook}"${r.formula ? ` (후킹 공식: ${r.formula})` : ""}${r.style ? ` — ${r.style}` : ""}`;
  return [
    "성과가 높았던 같은 상품군 릴스(주제 · 첫 문장 재료. 문장을 그대로 베끼지 않고, 시청자의 어떤 바람 · 불편을 건드려 멈추게 했는지를 이 상품에 옮긴다):",
    ...(refs.own.length ? ["우리 계정(먼저 본다. 저장 · 공유가 많은 순):", ...refs.own.map(line)] : []),
    ...(refs.benchmark.length ? ["다른 계정(영상 분석이 있는 것만):", ...refs.benchmark.map(line)] : []),
    ...(refs.insights.length ? ["분석 요약:", ...refs.insights.map((t) => `- ${t}`)] : []),
  ].join("\n");
}

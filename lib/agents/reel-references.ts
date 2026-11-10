import { firstLine, HIT_MULTIPLE } from "@/lib/benchmark/discovery";
import type { InsightSummary, ReelStyle } from "@/lib/benchmark/style-stats";
import type { createServiceClient } from "@/lib/supabase/service";

// AI 자동 대본의 주제 · 후킹 재료 — 다른 계정에서 성과가 높았던 릴스와 우리 계정에서 성과가 높았던 릴스.
// 상세페이지만 보고 주제를 정하면 상품 설명서 같은 영상이 나와서(2026-11-10 사용자 결정), 주제 · 첫 문장은 여기서 가져오고
// 상세페이지는 상품 사실을 확인하는 데만 쓴다. 워커가 이미 수집한 값만 읽고 인스타를 부르지 않는다.

type Service = ReturnType<typeof createServiceClient>;

// 분석 화면(lib/benchmark/load.ts)과 같은 기준: 최근 180일, 평소의 3배 이상, 광고 의심 · 캠페인(30배 이상) 제외, 한 계정 3개까지
const WINDOW_DAYS = 180;
const CAMPAIGN_MULTIPLE = 30;
const PER_ACCOUNT = 3;
const MAX_HITS = 15;
const MAX_OWN = 8;

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
  /** 영상 · 표지 분석이 있으면: 여는 방식 · 형식 · 특징 */
  style: string | null;
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
        .gte("multiple", HIT_MULTIPLE)
        .lt("multiple", CAMPAIGN_MULTIPLE)
        .gte("posted_at", since)
        .order("multiple", { ascending: false })
        .limit(300)
    : { data: [] };
  const perAccount = new Map<string, number>();
  const benchmark: ReferenceReel[] = [];
  for (const p of posts ?? []) {
    if (benchmark.length >= MAX_HITS) break;
    const style = (p.style ?? null) as unknown as ReelStyle | null;
    // 영상 분석이 읽은 실제 첫 마디가 있으면 그걸, 없으면 캡션 첫 줄
    const hook = (style?.hookLine?.trim() || firstLine(p.caption)).trim();
    const n = perAccount.get(p.benchmark_account_id) ?? 0;
    if (!hook || n >= PER_ACCOUNT) continue;
    perAccount.set(p.benchmark_account_id, n + 1);
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
    .limit(MAX_OWN * 4);
  const ownSorted = (ownRows ?? [])
    .map((r) => ({ ...r, hook: firstLine(r.caption) }))
    .filter((r) => r.hook)
    .sort((a, b) => (b.saved ?? 0) + (b.shares ?? 0) - ((a.saved ?? 0) + (a.shares ?? 0)) || (b.views ?? 0) - (a.views ?? 0))
    .slice(0, MAX_OWN);
  const own: ReferenceReel[] = ownSorted.map((r, i) => ({ ref: `O${i + 1}`, account: "우리 계정", hook: r.hook, multiple: null, views: r.views, saved: r.saved, shares: r.shares, formula: null, style: null }));

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

const num = (n: number | null) => (n == null ? "" : n >= 10_000 ? `${Math.round(n / 1000) / 10}만` : n.toLocaleString("en-US"));

/** 각도 · 장면표 프롬프트에 넣는 참고 릴스 묶음. 참고가 하나도 없으면 빈 문자열. */
export function referenceBlock(refs: ReelReferences): string {
  if (!refs.benchmark.length && !refs.own.length && !refs.insights.length) return "";
  const line = (r: ReferenceReel) =>
    `${r.ref} [${r.account}${r.multiple ? ` · 평소의 ${r.multiple.toFixed(1)}배` : ""}${r.views ? ` · 조회 ${num(r.views)}` : ""}${r.saved ? ` · 저장 ${num(r.saved)}` : ""}${r.shares ? ` · 공유 ${num(r.shares)}` : ""}] "${r.hook}"${r.formula ? ` (후킹 공식: ${r.formula})` : ""}${r.style ? ` — ${r.style}` : ""}`;
  return [
    "성과가 높았던 릴스(주제 · 첫 문장 재료. 문장을 그대로 베끼지 않고, 무엇이 시청자를 멈추게 했는지를 이 상품에 옮긴다):",
    ...(refs.benchmark.length ? ["다른 계정:", ...refs.benchmark.map(line)] : []),
    ...(refs.own.length ? ["우리 계정:", ...refs.own.map(line)] : []),
    ...(refs.insights.length ? ["분석 요약:", ...refs.insights.map((t) => `- ${t}`)] : []),
  ].join("\n");
}

import type { AiUsage } from "@/lib/lemo/contract";

// 영상 한 편 · 단계별 사용량 장부(lemo_productions.usage, out/usage.json).
// 비용은 세 종류를 나눈다:
//   actual   : 청구서 · 대시보드로 확인한 금액. 사람이 넣을 때만 채운다
//   api_rate : 공식 단가 × 사용량 환산. 단가를 모르는 항목은 0이 아니라 미상(null)으로 남기고 목록에 적는다
//   estimate : 위 둘로 못 정하는 어림(예: 러너 시간). 근거를 함께 적는다
// 단가는 항목마다 { unit, usd, as_of, source }. 확인한 값만 넣는다.

export type CostKind = "actual" | "api_rate" | "estimate";

export interface RateEntry {
  unit: string;
  // 단가(USD). 모르면 null — 0으로 두지 않는다
  usd: number | null;
  as_of: string;
  source: string;
}

/** 모델 하나의 단가. 키는 AiUsage의 칸(input · cached_input · cache_write · output)과 units 이름. */
export type ModelRates = Partial<Record<"input" | "cached_input" | "cache_write" | "cache_write_1h" | "output", RateEntry>> & { units?: Record<string, RateEntry> };

const M = "USD / 100만 토큰";
const CLAUDE_SKILL = "claude-api 스킬 모델표(cached 2026-10-06), 2026-11-10 확인";
const CLAUDE_CACHE_WRITE = "claude-api 스킬 prompt-caching: 5분 캐시 쓰기 약 1.25배, 1시간 캐시 쓰기 2배(입력 단가 기준), 2026-11-10 확인";
const OPENAI_TEXT = "lib/products/analysis/pricing.ts — OpenAI 표준 단가(캐시 할인 미반영)";
const OPENAI_IMAGE = "lib/shoot/video-kit/generated-visual.ts PRICE — 공식 단가(텍스트 입력 · 이미지 출력)";

const rate = (usd: number | null, as_of: string, source: string, unit = M): RateEntry => ({ unit, usd, as_of, source });

/** Claude 단가: 스킬 표에 있는 값만. 캐시 읽기는 표에 적힌 모델만 넣고 나머지는 미상. */
function claude(input: number, output: number, cacheRead: number | null): ModelRates {
  return {
    input: rate(input, "2026-10-06", CLAUDE_SKILL),
    output: rate(output, "2026-10-06", CLAUDE_SKILL),
    cached_input: rate(cacheRead, "2026-10-06", cacheRead == null ? `${CLAUDE_SKILL} — 이 모델의 캐시 읽기 단가는 표에 없어 미상` : CLAUDE_SKILL),
    cache_write: rate(Number((input * 1.25).toFixed(4)), "2026-10-06", CLAUDE_CACHE_WRITE),
    cache_write_1h: rate(input * 2, "2026-10-06", CLAUDE_CACHE_WRITE),
  };
}

/** provider:model → 단가. 여기 없는 모델 · 항목은 미상으로 집계한다. */
export const RATES: Record<string, ModelRates> = {
  "anthropic:claude-opus-5-5": claude(4, 20, 0.2),
  "anthropic:claude-opus-5": claude(5, 25, null),
  "anthropic:claude-opus-4-8": claude(5, 25, null),
  "anthropic:claude-sonnet-5-5": claude(2, 10, 0.2),
  "anthropic:claude-sonnet-5": claude(2, 10, null),
  "anthropic:claude-haiku-5-5": claude(0.1, 0.5, null),
  "anthropic:claude-fable-5-1": claude(10, 50, 0.25),
  "openai:gpt-6.1-terra": {
    input: rate(1, "2026-11-03", OPENAI_TEXT),
    output: rate(5, "2026-11-03", OPENAI_TEXT),
    cached_input: rate(null, "2026-11-03", `${OPENAI_TEXT} — 캐시 할인 단가는 확인 안 함`),
  },
  "openai:gpt-image-2.6-sunburst": {
    input: rate(5, "2026-11-05", OPENAI_IMAGE),
    output: rate(30, "2026-11-05", OPENAI_IMAGE),
  },
  // 받아쓰기는 저장소에 확인한 단가가 없다
  "openai:whisper-1": { units: { audio_seconds: rate(null, "2026-11-10", "저장소에 확인한 단가 없음", "USD / 초") } },
  // 무료 모델: 안내상 2026-11-30까지 무료 제공(CLAUDE.md · lib/shoot/voices.ts). 그 뒤 단가는 미정
  "fish:s2.1-pro-free": { units: { characters: rate(0, "2026-11-10", "Fish Audio S2.1 Pro Free — 무료 제공 모델, 안내상 2026-11-30까지(CLAUDE.md 편집 음성 모델 고정)", "USD / 글자") } },
};

// Claude Code 기록의 모델 이름("claude-opus-5-5[1m]", 날짜 붙은 이름)을 단가표 이름으로
export function rateKey(provider: AiUsage["provider"], model: string): string {
  const m = model.replace(/\[.*?\]/g, "").replace(/-\d{8}$/, "").trim();
  return `${provider}:${m}`;
}

export interface PricedUsage {
  // 알려진 항목만 더한 환산액(미상 항목이 있으면 complete=false)
  usd: number;
  complete: boolean;
  unknown: string[];
}

/** 사용량 하나를 단가표로 환산한다. 단가가 없는 항목은 unknown에 적고 더하지 않는다(0으로 보지 않는다). */
export function priceUsage(u: AiUsage, rates: Record<string, ModelRates> = RATES): PricedUsage {
  const key = rateKey(u.provider, u.model);
  const r = rates[key];
  const unknown: string[] = [];
  let usd = 0;
  const units = { ...(u.units ?? {}) };
  const write1h = units.cache_write_1h ?? 0;
  delete units.cache_write_1h;
  const tokenParts: [keyof ModelRates & string, number][] = [
    ["input", u.input],
    ["cached_input", u.cached_input],
    ["cache_write", Math.max(0, u.cache_write - write1h)],
    ["cache_write_1h", write1h],
    ["output", u.output],
  ];
  for (const [field, n] of tokenParts) {
    if (!n) continue;
    const e = r?.[field] as RateEntry | undefined;
    if (e?.usd == null) unknown.push(`${key} ${field}`);
    else usd += (n * e.usd) / 1_000_000;
  }
  for (const [name, n] of Object.entries(units)) {
    if (!n) continue;
    const e = r?.units?.[name];
    if (e?.usd == null) unknown.push(`${key} ${name}`);
    else usd += n * e.usd;
  }
  return { usd: Number(usd.toFixed(6)), complete: unknown.length === 0, unknown };
}

export interface RenderRun {
  stage: string;
  seconds: number;
  where: "local" | "server";
  frames?: number | null;
  note?: string;
}

export interface RetryRecord {
  stage: string;
  attempt: number;
  // 다시 한 범위(예: "장면 3 · 4만", "전체 장면 계획")
  scope: string;
  reason: string;
}

export interface AssetRecord {
  kind: "character" | "background" | "voice" | "music" | "sfx" | "other";
  id: string;
  reused: boolean;
  note?: string;
}

export interface UsageSummary {
  version: 1;
  stages: (AiUsage & { cost: PricedUsage })[];
  stage_seconds: Record<string, number>;
  render: RenderRun[];
  retries: RetryRecord[];
  assets: { reused: AssetRecord[]; created: AssetRecord[] };
  totals: {
    by_provider: Record<string, { calls: number; input: number; cached_input: number; cache_write: number; output: number; units: Record<string, number> }>;
    render_seconds: { local: number; server: number };
  };
  cost: {
    actual: { usd: number; note: string } | null;
    api_rate: { usd: number; complete: boolean; unknown: string[] };
    estimate: { usd: number; note: string } | null;
  };
  rates_used: Record<string, ModelRates | null>;
}

export class UsageLedger {
  private usages: AiUsage[] = [];
  private seconds: Record<string, number> = {};
  private renders: RenderRun[] = [];
  private retryList: RetryRecord[] = [];
  private assetList: AssetRecord[] = [];
  private actualCost: { usd: number; note: string } | null = null;
  private estimateCost: { usd: number; note: string } | null = null;

  add(u: AiUsage | AiUsage[] | null | undefined): void {
    for (const x of Array.isArray(u) ? u : u ? [u] : []) this.usages.push(x);
  }

  /** 단계 실행 시간을 잰다. 실패해도 시간은 남기고 다시 던진다. */
  async time<T>(stage: string, fn: () => Promise<T> | T): Promise<T> {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      this.seconds[stage] = Number(((this.seconds[stage] ?? 0) + (Date.now() - t0) / 1000).toFixed(2));
    }
  }

  render(run: RenderRun): void {
    this.renders.push({ ...run, seconds: Number(run.seconds.toFixed(2)) });
  }

  retry(r: RetryRecord): void {
    this.retryList.push(r);
  }

  asset(a: AssetRecord): void {
    this.assetList.push(a);
  }

  /** 청구서로 확인한 금액. 사람이 확인했을 때만 넣는다. */
  setActual(usd: number, note: string): void {
    this.actualCost = { usd, note };
  }

  setEstimate(usd: number, note: string): void {
    this.estimateCost = { usd, note };
  }

  summarize(rates: Record<string, ModelRates> = RATES): UsageSummary {
    const stages = this.usages.map((u) => ({ ...u, cost: priceUsage(u, rates) }));
    const byProvider: UsageSummary["totals"]["by_provider"] = {};
    for (const u of this.usages) {
      const k = rateKey(u.provider, u.model);
      const t = (byProvider[k] ??= { calls: 0, input: 0, cached_input: 0, cache_write: 0, output: 0, units: {} });
      t.calls += u.calls;
      t.input += u.input;
      t.cached_input += u.cached_input;
      t.cache_write += u.cache_write;
      t.output += u.output;
      for (const [n, v] of Object.entries(u.units ?? {})) t.units[n] = (t.units[n] ?? 0) + v;
    }
    const unknown = [...new Set(stages.flatMap((s) => s.cost.unknown))];
    const rendered = { local: 0, server: 0 };
    for (const r of this.renders) rendered[r.where] = Number((rendered[r.where] + r.seconds).toFixed(2));
    const keys = [...new Set(this.usages.map((u) => rateKey(u.provider, u.model)))];
    return {
      version: 1,
      stages,
      stage_seconds: { ...this.seconds },
      render: [...this.renders],
      retries: [...this.retryList],
      assets: { reused: this.assetList.filter((a) => a.reused), created: this.assetList.filter((a) => !a.reused) },
      totals: { by_provider: byProvider, render_seconds: rendered },
      cost: {
        actual: this.actualCost,
        api_rate: { usd: Number(stages.reduce((s, x) => s + x.cost.usd, 0).toFixed(6)), complete: unknown.length === 0, unknown },
        estimate: this.estimateCost,
      },
      rates_used: Object.fromEntries(keys.map((k) => [k, rates[k] ?? null])),
    };
  }
}

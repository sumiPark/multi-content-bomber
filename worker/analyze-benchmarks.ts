// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions에선 no-op).
import "./load-env";

import { resolveOrgId } from "@/lib/agents/playbook";
import { agentModel } from "@/lib/agents/runner";
import { firstLine, HIT_MULTIPLE } from "@/lib/benchmark/discovery";
import { computeStyleStats, type ReelStyle, type StyleRow, type StyleSource } from "@/lib/benchmark/style-stats";
import { analyzeCover, analyzeVideo, writeInsight } from "@/lib/benchmark/video-style";
import { clip } from "@/lib/post-analysis/stats";
import { checkText, type ContentRule } from "@/lib/rules/check";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// ─────────────────────────────────────────────────────────────────────────────
// 다른 계정 잘된 릴스 종합 분석 워커. "한 번 실행하고 종료"하는 배치. 인스타에는 쓰지 않는다.
//
// .github/workflows/benchmark-analysis.yml이 매일 05:30(KST) 깨운다(비교 수집 04:50 뒤 — 영상 주소가 며칠 뒤 만료된다).
//   1. 우리 계정마다 비교 계정의 잘된 릴스와, 그 계정의 평소 릴스를 같은 수만큼 고른다
//   2. 아직 판정 안 한 릴스를 판정한다 — 영상 주소가 있으면 영상, 없으면 표지와 캡션 (benchmark_posts.style)
//   3. 고른 릴스가 바뀌었거나 7일이 지났으면 종합 분석을 새로 쓴다 (benchmark_analyses)
//
// 영상 · 프레임 · 음성은 저장하지 않는다(lib/benchmark/video-style.ts).
// 옵션: --account <id> · --no-ai (판정만 하고 종합 분석은 건너뜀) · --force-ai · --limit <n>
// ─────────────────────────────────────────────────────────────────────────────

const RUN_BUDGET_MS = 30 * 60_000;
const RUN_LIMIT = 80;
const HIT_WINDOW_DAYS = 180;
// 화면의 "평소보다 잘된 릴스"와 같은 기준 — 이 배수를 넘으면 광고 · 유명인 캠페인일 가능성이 커서 뺀다
const CAMPAIGN_MULTIPLE = 30;
const HITS_PER_ACCOUNT = 5;
const HITS_PER_OWN = 20;
const NORMAL_RANGE = [0.5, 1.5] as const;
const YOUNG_DAYS = 3;
const MIN_HITS_FOR_INSIGHT = 5;
const ANALYSIS_DAYS = 7;
const DAY_MS = 86_400_000;

type Service = ReturnType<typeof createServiceClient>;

interface Post {
  id: string;
  benchmark_account_id: string;
  caption: string | null;
  thumbnail_url: string | null;
  video_url: string | null;
  posted_at: string | null;
  multiple: number | null;
  ad_suspected: boolean;
  style: unknown;
  style_source: string | null;
}

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** 잘된 릴스와, 같은 계정에서 시기가 가장 가까운 평소 릴스를 짝지어 고른다. 영상을 볼 수 있는 릴스를 먼저 고른다. */
function pickReels(posts: Post[], now: number): { hits: Post[]; normals: Post[] } {
  const matured = posts.filter((p) => !p.ad_suspected && p.multiple != null && p.posted_at && now - Date.parse(p.posted_at) >= YOUNG_DAYS * DAY_MS);
  const perAccount = new Map<string, number>();
  const hits = matured
    .filter((p) => (p.multiple as number) >= HIT_MULTIPLE && (p.multiple as number) < CAMPAIGN_MULTIPLE)
    .sort((a, b) => Number(!!b.video_url) - Number(!!a.video_url) || (b.multiple as number) - (a.multiple as number))
    .filter((p) => {
      const n = perAccount.get(p.benchmark_account_id) ?? 0;
      if (n >= HITS_PER_ACCOUNT) return false;
      perAccount.set(p.benchmark_account_id, n + 1);
      return true;
    })
    .slice(0, HITS_PER_OWN);

  const used = new Set<string>();
  const normals = hits.flatMap((h) => {
    const at = Date.parse(h.posted_at as string);
    const best = matured
      .filter((p) => p.benchmark_account_id === h.benchmark_account_id && !used.has(p.id) && (p.multiple as number) >= NORMAL_RANGE[0] && (p.multiple as number) <= NORMAL_RANGE[1])
      .sort((a, b) => Number(!!b.video_url) - Number(!!a.video_url) || Math.abs(Date.parse(a.posted_at as string) - at) - Math.abs(Date.parse(b.posted_at as string) - at))[0];
    if (!best) return [];
    used.add(best.id);
    return [best];
  });
  return { hits, normals };
}

async function loadRules(service: Service): Promise<ContentRule[]> {
  const { data } = await service.from("content_rules").select("id, phrase, match_type, reason, suggestion").eq("active", true).eq("rule_type", "BANNED");
  return (data ?? []).map((r) => ({ id: r.id, scope: "ALL", ruleType: "BANNED", phrase: r.phrase, matchType: r.match_type as ContentRule["matchType"], reason: r.reason, suggestion: r.suggestion }));
}

async function main() {
  const argv = process.argv.slice(2);
  const onlyAccount = arg(argv, "--account");
  const noAi = argv.includes("--no-ai");
  const forceAi = argv.includes("--force-ai");
  const runLimit = Number(arg(argv, "--limit") ?? RUN_LIMIT);
  const service = createServiceClient();
  const started = Date.now();
  const now = started;
  const since = new Date(now - HIT_WINDOW_DAYS * DAY_MS).toISOString();

  let q = service
    .from("social_accounts")
    .select("id, organization_id, display_name, role_note")
    .eq("platform", "INSTAGRAM")
    .eq("is_active", true)
    .is("disconnected_at", null);
  if (onlyAccount) q = q.eq("id", onlyAccount);
  const { data: accounts, error } = await q;
  if (error) {
    console.error("[analyze-benchmarks] 계정 조회 실패:", error.message);
    process.exitCode = 1;
    return;
  }

  // 1. 우리 계정마다 고를 릴스
  const plans: { account: NonNullable<typeof accounts>[number]; hits: Post[]; normals: Post[]; usernames: Map<string, string> }[] = [];
  for (const account of accounts ?? []) {
    const { data: links } = await service.from("benchmark_links").select("benchmark_account_id, benchmark_accounts(username, status)").eq("social_account_id", account.id);
    const usernames = new Map(
      (links ?? []).flatMap((l) => {
        const a = l.benchmark_accounts as unknown as { username: string; status: string } | null;
        return a?.status === "OK" ? [[l.benchmark_account_id, a.username] as const] : [];
      }),
    );
    if (!usernames.size) continue;
    const { data: posts, error: postErr } = await service
      .from("benchmark_posts")
      .select("id, benchmark_account_id, caption, thumbnail_url, video_url, posted_at, multiple, ad_suspected, style, style_source")
      .in("benchmark_account_id", [...usernames.keys()])
      .eq("media_product_type", "REELS")
      .gte("posted_at", since)
      .limit(2000);
    if (postErr) {
      console.error(`[analyze-benchmarks] ${account.display_name}: ${postErr.message}`);
      continue;
    }
    const picked = pickReels((posts ?? []) as Post[], now);
    plans.push({ account, ...picked, usernames });
  }

  // 2. 판정 — 잘된 릴스 먼저. 여러 우리 계정이 같은 비교 계정을 쓰면 한 번만 판정한다
  const queue = new Map<string, Post>();
  for (const pick of [(p: (typeof plans)[number]) => p.hits, (p: (typeof plans)[number]) => p.normals]) {
    for (const plan of plans) {
      for (const post of pick(plan)) {
        // 표지만 본 릴스는 영상 주소가 새로 생기면 다시 본다
        if (!post.style || (post.style_source === "COVER" && post.video_url)) queue.set(post.id, post);
      }
    }
  }

  const usage = { input: 0, output: 0, audioSec: 0 };
  const judged = new Map<string, { style: ReelStyle; source: StyleSource }>();
  let videos = 0;
  let covers = 0;
  let failed = 0;
  let stoppedEarly = false;
  for (const post of queue.values()) {
    if (Date.now() - started > RUN_BUDGET_MS || videos + covers >= runLimit) {
      stoppedEarly = true;
      break;
    }
    const caption = post.caption ?? "";
    let result: { style: ReelStyle; source: StyleSource } | null = null;
    if (post.video_url) {
      try {
        result = { style: await analyzeVideo(post.video_url, caption, usage), source: "VIDEO" };
      } catch (err) {
        console.warn(`[analyze-benchmarks] 영상 판정 실패 ${post.id}:`, err instanceof Error ? err.message.slice(0, 200) : err);
      }
    }
    if (!result && post.thumbnail_url && post.style_source !== "COVER") {
      try {
        result = { style: await analyzeCover(post.thumbnail_url, caption, usage), source: "COVER" };
      } catch (err) {
        console.warn(`[analyze-benchmarks] 표지 판정 실패 ${post.id}:`, err instanceof Error ? err.message.slice(0, 200) : err);
      }
    }
    if (!result) {
      failed++;
      continue;
    }
    if (result.source === "VIDEO") videos++;
    else covers++;
    const { error: saveErr } = await service
      .from("benchmark_posts")
      .update({ style: result.style as unknown as Json, style_source: result.source, style_analyzed_at: new Date().toISOString() })
      .eq("id", post.id);
    if (saveErr) throw new Error(`판정 저장 실패: ${saveErr.message}`);
    judged.set(post.id, result);
  }
  console.log(`[analyze-benchmarks] 판정 대상 ${queue.size} | 영상 ${videos} | 표지만 ${covers} | 실패 ${failed} | 받아쓰기 ${Math.round(usage.audioSec / 60)}분 | 토큰 ${usage.input}/${usage.output}${stoppedEarly ? " | 나머지는 다음 실행에" : ""}`);

  // 3. 종합 분석 — 다 판정하지 못했어도 판정된 만큼으로 쓰되, 표본이 적으면 쓰지 않는다
  if (noAi) return;
  const rules = await loadRules(service);
  for (const { account, hits, normals, usernames } of plans) {
    const label = account.display_name ?? account.id;
    const toRow = (p: Post, isHit: boolean): StyleRow | null => {
      const fresh = judged.get(p.id);
      const style = (fresh?.style ?? p.style) as ReelStyle | null;
      const source = (fresh?.source ?? p.style_source) as StyleSource | null;
      return style && source ? { id: p.id, isHit, source, style } : null;
    };
    const rows = [...hits.map((p) => toRow(p, true)), ...normals.map((p) => toRow(p, false))].filter((r): r is StyleRow => !!r);
    const hitRows = rows.filter((r) => r.isHit);
    if (hitRows.length < MIN_HITS_FOR_INSIGHT) {
      console.log(`[analyze-benchmarks] ${label}: 판정된 잘된 릴스 ${hitRows.length}개뿐이라 종합 분석 안 함`);
      continue;
    }
    const stats = computeStyleStats(rows);
    const fingerprint = rows.map((r) => `${r.id}:${r.source}`).sort().join(",");

    if (!forceAi) {
      const { data: last } = await service.from("benchmark_analyses").select("created_at, stats").eq("social_account_id", account.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
      const same = (last?.stats as { fingerprint?: string } | null)?.fingerprint === fingerprint;
      if (last && same && now - Date.parse(last.created_at) < ANALYSIS_DAYS * DAY_MS) {
        console.log(`[analyze-benchmarks] ${label}: 바뀐 릴스 없음`);
        continue;
      }
    }

    const insightUsage = { input: 0, output: 0 };
    const model = agentModel();
    const { data: run } = await service
      .from("agent_runs")
      .insert({
        organization_id: await resolveOrgId(service, { accountId: account.id }),
        agent: "analyze",
        model,
        input: { task: "benchmark_insight", account: label, hits: hitRows.length, normals: rows.length - hitRows.length, video: stats.hits.video + stats.normals.video } as Json,
      })
      .select("id")
      .single();
    const finish = async (patch: { status: "success" | "failed"; output?: unknown; error?: string }) => {
      if (!run) return;
      await service
        .from("agent_runs")
        .update({ status: patch.status, output: (patch.output ?? null) as Json, error: patch.error ?? null, tokens_input: insightUsage.input, tokens_output: insightUsage.output, finished_at: new Date().toISOString() })
        .eq("id", run.id);
    };
    try {
      const styleById = new Map(hitRows.map((r) => [r.id, r.style]));
      const reels = hits.flatMap((p) => {
        const s = styleById.get(p.id);
        return s ? [{ username: usernames.get(p.benchmark_account_id) ?? "", multiple: p.multiple as number, hookLine: s.hookLine || clip(firstLine(p.caption), 40), note: s.note }] : [];
      });
      const { summary, dropped } = await writeInsight(label, account.role_note, stats, reels, insightUsage);
      // 그대로 쓰면 광고 문구 규칙에 걸리는 제안은 뺀다
      const points = summary.points.map((p) => (checkText(p.apply, "OTHER", rules).length ? { ...p, apply: "" } : p));
      const { error: insertErr } = await service.from("benchmark_analyses").insert({
        organization_id: account.organization_id,
        social_account_id: account.id,
        hits_count: stats.hits.total,
        normal_count: stats.normals.total,
        video_count: stats.hits.video + stats.normals.video,
        stats: { ...stats, fingerprint } as unknown as Json,
        summary: { ...summary, points } as unknown as Json,
        model,
        tokens_input: insightUsage.input,
        tokens_output: insightUsage.output,
      });
      if (insertErr) throw new Error(`종합 분석 저장 실패: ${insertErr.message}`);
      await finish({ status: "success", output: { points: points.length, standouts: stats.standouts.length, dropped } });
      console.log(`[analyze-benchmarks] ${label}: 잘된 ${stats.hits.total}(영상 ${stats.hits.video}) · 평소 ${stats.normals.total}(영상 ${stats.normals.video}) | 눈에 띈 차이 ${stats.standouts.length}개 | 토큰 ${insightUsage.input}/${insightUsage.output}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await finish({ status: "failed", error: message });
      console.error(`[analyze-benchmarks] ${label}: ${message.slice(0, 300)}`);
    }
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("[analyze-benchmarks] 치명적 오류:", err);
    process.exit(1);
  });

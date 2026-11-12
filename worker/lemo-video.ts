// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions에선 no-op).
import "./load-env";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadAccountConcept } from "@/lib/agents/concept";
import { loadProductFacts, type ProductFacts } from "@/lib/agents/product-facts";
import type { Storyboard } from "@/lib/agents/storyboard";
import type { SavedStoryboard } from "@/lib/auto-video/make";
import { boardBrief } from "@/lib/lemo/board-brief";
import type { AccountContext } from "@/lib/lemo/contract";
import { runLemoJob, type LemoJob, type LemoOutcome, type LemoSources } from "@/lib/lemo/run";
import { UsageLedger } from "@/lib/lemo/usage";
import { voiceFromExisting } from "@/lib/lemo/voice";
import type { ContentRule } from "@/lib/rules/check";
import { captionSkillDir } from "@/lib/shoot/video-kit/caption-skill";
import { chosenFonts, loadSkillFonts } from "@/lib/shoot/video-kit/skill-fonts";
import { createServiceClient } from "@/lib/supabase/service";

// ─────────────────────────────────────────────────────────────────────────────
// lemo 코드 애니메이션 워커 — 수동 실행용. 제작 흐름은 lib/lemo/run.ts에 있고 AI 자동 영상 워커(make-auto-videos.ts)도 기본 경로로 같은 흐름을 쓴다.
//   선택(select) → 캐릭터(characters) → 음성 확정(voice) → 장면 계획(direct) → 코드 구성(project) → 렌더(render)
//   → 자동 검사(checks) → 합성(compose: 기존 편집 키트, 모션 자막 스킬 필수) → 결과 · 사용량
// 모드:
//   (a) --compare-firstgel --out <dir>          기존 음성(voice.wav · timeline.json · lines.tsv) + 고정 장면 데이터로 화면만 lemo로 바꿔 비교
//         --voice/--timeline/--lines (또는 LEMO_COMPARE_VOICE/_TIMELINE/_LINES), --production <json>, --facts <json>, --hook <글>
//   (b) --script <json> --account <key> --out <dir>   DB 없이 로컬 파일(대본 줄 · 상품 요약 · 계정 맥락)로 처음부터
//   (c) --plan <id> --dry-run --out <dir>        content_plans · products · account_concepts를 읽기만 하고 같은 흐름(DB 쓰기 없음)
//       --plan <id> (dry-run 아님)               lemo_productions에 기록한다. 0055 미적용이면 시작 전에 멈춘다
// out 폴더: production.json · choice.json · checks.json · usage.json · final.mp4 · cover.jpg (+ contact.jpg, film/)
// ─────────────────────────────────────────────────────────────────────────────

const COMPARE_DEFAULTS = {
  voice: "D:/ai/ogai-test/story/final/voice.wav",
  timeline: "D:/ai/ogai-test/story/final/timeline.json",
  lines: "D:/ai/ogai-test/story/lines.tsv",
  production: "lib/lemo/fixtures/firstgel-story.production.json",
};

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function writeJson(dir: string, name: string, value: unknown): void {
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2));
}

/** DB 없이 쓰는 최소 상품 요약. 자막 디자인 AI가 상품 이름 · 종류만 읽는다. */
function localFacts(raw: Partial<ProductFacts> | null | undefined, fallbackName: string): ProductFacts {
  return {
    id: "local",
    name: fallbackName,
    rawName: fallbackName,
    shop: "local",
    kind: "OTHER",
    kindLabel: "상품",
    price: null,
    stockStatus: "available",
    url: "",
    detailImages: 0,
    oneLine: null,
    usage: null,
    cautions: null,
    details: {},
    claims: [],
    uncertainties: [],
    healthFunctional: null,
    approvedClaims: [],
    certifiedFunctions: [],
    sourceText: "",
    ...(raw ?? {}),
  } as ProductFacts;
}

/** 장면표가 고른 글꼴을 스킬 글꼴 목록과 대조한다(AI 자동 영상과 같은 방식). 목록을 못 읽으면 null — 자막 디자인 AI가 고른다. */
function boardFonts(board: Storyboard): { key_font: string; small_font: string } | null {
  try {
    const dir = captionSkillDir();
    const list = dir ? loadSkillFonts(dir) : [];
    if (!list.length) return null;
    const picked = chosenFonts(list, { key_font: board.key_font, small_font: board.small_font });
    return { key_font: picked.key.name, small_font: picked.small.name };
  } catch (e) {
    console.warn("[lemo] 스킬 글꼴 목록을 읽지 못했어요:", e instanceof Error ? e.message : e);
    return null;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const out = resolve(arg(argv, "--out") ?? join("lemo-out", String(Date.now())));
  mkdirSync(out, { recursive: true });
  const dryRun = argv.includes("--dry-run");
  const planId = arg(argv, "--plan");
  const scriptFile = arg(argv, "--script");
  const compare = argv.includes("--compare-firstgel");
  if ([compare, !!scriptFile, !!planId].filter(Boolean).length !== 1) throw new Error("--compare-firstgel · --script · --plan 중 하나만 주세요");

  let job: LemoJob;
  const emptySources: LemoSources = { photos: 0, gifs: 0, archive: 0 };
  if (compare) {
    const c = {
      voice: arg(argv, "--voice") ?? process.env.LEMO_COMPARE_VOICE ?? COMPARE_DEFAULTS.voice,
      timeline: arg(argv, "--timeline") ?? process.env.LEMO_COMPARE_TIMELINE ?? COMPARE_DEFAULTS.timeline,
      lines: arg(argv, "--lines") ?? process.env.LEMO_COMPARE_LINES ?? COMPARE_DEFAULTS.lines,
      production: arg(argv, "--production") ?? COMPARE_DEFAULTS.production,
    };
    for (const [k, f] of Object.entries(c)) if (!existsSync(f)) throw new Error(`비교 시험 ${k} 파일이 없어요: ${f}`);
    const factsFile = arg(argv, "--facts");
    const hookText = arg(argv, "--hook");
    const accountKey = (JSON.parse(readFileSync(c.production, "utf8")) as { account_key?: string }).account_key ?? "local";
    const lines = voiceFromExisting({ voiceWav: c.voice, timelineJson: c.timeline, linesTsv: c.lines }).map((v) => v.text);
    job = {
      mode: "compare",
      out,
      account: { accountKey, accountName: accountKey, notes: null, voiceId: null, preferredStyles: [] },
      facts: localFacts(factsFile ? JSON.parse(readFileSync(factsFile, "utf8")) : { name: "퍼스트겔", rawName: "퍼스트겔", kind: "COSMETIC", kindLabel: "화장품" }, "퍼스트겔"),
      rules: [],
      script: lines,
      hook: hookText ? { spoken: lines[0], on_screen: hookText } : null,
      sources: emptySources,
      tone: null,
      service: null,
      compare: c,
    };
  } else if (scriptFile) {
    const accountKey = arg(argv, "--account");
    if (!accountKey) throw new Error("--script에는 --account <key>가 필요해요");
    const spec = JSON.parse(readFileSync(scriptFile, "utf8")) as { lines?: string[]; hook?: { spoken: string; on_screen: string } | null; facts?: Partial<ProductFacts>; account?: Partial<AccountContext>; sources?: unknown };
    if (!spec.lines?.length) throw new Error(`${scriptFile}: lines(대본 줄)가 없어요`);
    job = {
      mode: "script",
      out,
      account: { accountName: accountKey, notes: null, voiceId: null, preferredStyles: [], ...(spec.account ?? {}), accountKey },
      facts: localFacts(spec.facts, spec.facts?.name ?? "상품"),
      rules: [],
      script: spec.lines,
      hook: spec.hook ?? null,
      sources: { ...emptySources, ...((spec.sources ?? {}) as Partial<LemoSources>) },
      tone: spec.account?.notes ?? null,
      service: null,
    };
  } else {
    // (c) 칸 읽기. dry-run은 읽기만 하고 쓰지 않는다
    const service = createServiceClient();
    const { data: plan, error } = await service
      .from("content_plans")
      .select("id, organization_id, social_account_id, product_id, storyboard, social_accounts(display_name)")
      .eq("id", planId!)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!plan) throw new Error(`칸을 찾지 못했어요: ${planId}`);
    if (!plan.product_id) throw new Error("상품이 정해지지 않은 칸이에요");
    const saved = (plan.storyboard as { version?: number } | null)?.version === 1 ? (plan.storyboard as unknown as SavedStoryboard) : null;
    const board: Storyboard | null = saved?.board ?? null;
    if (!board?.scenes.length) throw new Error("장면표(대본)가 저장된 칸만 lemo로 만들 수 있어요");
    // 소재 수: 장면표를 쓸 때 정리한 상세 사진 · 움직이는 이미지 · 자사 촬영 클립
    const sources: LemoSources = { photos: Object.keys(saved?.assets?.photos ?? {}).length, gifs: Object.keys(saved?.assets?.gifs ?? {}).length, archive: Object.keys(saved?.assets?.archive ?? {}).length };
    const [facts, concept, prefs, ruleRows] = await Promise.all([
      loadProductFacts(service, plan.product_id),
      loadAccountConcept(service, plan.social_account_id),
      // 0055 전이면 칸이 없어 오류가 난다. 선호 스타일은 기본값일 뿐이라 비워 두고 이어 간다
      (service as unknown as SupabaseClient).from("account_concepts").select("lemo_preferred_styles").eq("social_account_id", plan.social_account_id).maybeSingle(),
      service.from("content_rules").select("id, scope, rule_type, phrase, match_type, reason, suggestion").eq("active", true),
    ]);
    const display = plan.social_accounts?.display_name ?? "";
    const accountKey = arg(argv, "--account") ?? display.replace(/^@/, "").toLowerCase();
    if (!accountKey) throw new Error("계정 이름을 읽지 못했어요. --account <key>로 주세요");
    const preferred = (prefs.data as { lemo_preferred_styles?: string[] } | null)?.lemo_preferred_styles ?? [];
    if (prefs.error) console.warn(`[lemo] 선호 스타일을 읽지 못해 비워 둠(0055 미적용일 수 있음): ${prefs.error.message}`);
    if (!dryRun) {
      // 실제 저장 모드는 0055가 있어야 한다. 없으면 AI를 부르기 전에 멈춘다
      const probe = await (service as unknown as SupabaseClient).from("lemo_productions").select("id").limit(1);
      if (probe.error) throw new Error(`lemo_productions 표를 쓸 수 없어요(0055 마이그레이션 미적용?): ${probe.error.message}`);
    }
    job = {
      mode: "plan",
      out,
      account: { accountKey, accountName: display, notes: concept.autoNotes || null, voiceId: concept.autoVoiceId, preferredStyles: preferred },
      facts,
      rules: (ruleRows.data ?? []).map((r) => ({ id: r.id, scope: r.scope as ContentRule["scope"], ruleType: r.rule_type as ContentRule["ruleType"], phrase: r.phrase, matchType: r.match_type as ContentRule["matchType"], reason: r.reason, suggestion: r.suggestion })),
      script: board.scenes.map((s) => s.say),
      hook: { spoken: board.hook.spoken, on_screen: board.hook.on_screen },
      // AI 자동 영상과 같게 장면표의 화면 지시 · 화면 글자 · 자막 줄 · 강조어 · 글자 디자인 · 글꼴 · 끝 화면을 넘긴다
      brief: boardBrief(board, boardFonts(board)),
      sources,
      tone: concept.autoNotes || null,
      // dry-run은 저장하지 않는다(편집 키트도 읽기만)
      service: dryRun ? null : service,
      readService: service,
      record: dryRun ? undefined : { organizationId: plan.organization_id, planId: plan.id, socialAccountId: plan.social_account_id },
    };
  }

  const ledger = new UsageLedger();
  const db = job.record ? (createServiceClient() as unknown as SupabaseClient) : null;
  let rowId: string | null = null;
  if (db && job.record) {
    const { data, error } = await db
      .from("lemo_productions")
      .insert({ organization_id: job.record.organizationId, plan_id: job.record.planId, social_account_id: job.record.socialAccountId, account_key: job.account.accountKey, backend: "lemo-code", status: "RENDERING", started_at: new Date().toISOString() })
      .select("id")
      .single();
    if (error) throw new Error(`lemo_productions 기록 실패: ${error.message}`);
    rowId = (data as { id: string }).id;
  }

  const started = Date.now();
  let outcome: LemoOutcome | null = null;
  let failure: string | null = null;
  try {
    outcome = await runLemoJob(job, ledger);
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }
  const usage = ledger.summarize();
  const review = outcome?.review ?? [];
  const checks = { ...(outcome?.checks ?? {}), review, ...(failure ? { error: failure } : {}) };
  writeJson(out, "usage.json", usage);
  writeJson(out, "checks.json", checks);
  if (outcome?.choice && !existsSync(join(out, "choice.json"))) writeJson(out, "choice.json", { choice: outcome.choice });

  if (db && rowId) {
    const { error } = await db
      .from("lemo_productions")
      .update({
        status: failure ? "FAILED" : outcome?.final ? (review.length ? "NEEDS_REVIEW" : "RENDERED") : "PLANNED",
        backend: outcome?.choice?.backend ?? "lemo-code",
        style: outcome?.choice?.style ?? null,
        render_mode: outcome?.choice?.render_mode ?? null,
        choice: outcome?.choice ?? {},
        production: outcome?.production ?? null,
        characters: outcome?.characters ?? { reused: [], created: [] },
        checks,
        usage,
        // 완성본 업로드는 아직 하지 않는다. 결과 파일은 실행 기록(artifact)의 out 폴더에 있다
        video_path: null,
        error: failure,
        finished_at: new Date().toISOString(),
      })
      .eq("id", rowId);
    if (error) console.error(`[lemo] lemo_productions 결과 기록 실패: ${error.message}`);
  }

  const secs = Math.round((Date.now() - started) / 1000);
  const c = usage.cost.api_rate;
  console.log(`[lemo] ${failure ? "실패" : review.length ? `완성본 있음 · 사람 검수 필요 ${review.length}건` : "완료"} — ${secs}초, 결과 ${out}`);
  console.log(`[lemo] API 단가 환산 $${c.usd.toFixed(4)}${c.complete ? "" : ` (미상 항목: ${c.unknown.join(", ")})`} · 렌더 local ${usage.totals.render_seconds.local}초 / server ${usage.totals.render_seconds.server}초`);
  if (outcome?.checks.final) console.log(`[lemo] 완성본 ${outcome.checks.final.seconds}초 · ${outcome.checks.final.lufs} LUFS · 트루 피크 ${outcome.checks.final.true_peak_db} dBFS`);
  if (failure) throw new Error(failure);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[lemo] 실패:", err instanceof Error ? err.message : err);
    process.exit(1);
  });

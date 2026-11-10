// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions에선 no-op).
import "./load-env";

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadAccountConcept } from "@/lib/agents/concept";
import { loadProductFacts, type ProductFacts } from "@/lib/agents/product-facts";
import type { Storyboard } from "@/lib/agents/storyboard";
import { agentModel } from "@/lib/agents/runner";
import type { SavedStoryboard } from "@/lib/auto-video/make";
import { loadAccountLibrary, prepareCharacters } from "@/lib/lemo/characters";
import { checkFinal, checkSilentRender, type FinalChecks, type RenderChecks } from "@/lib/lemo/checks";
import { composeLemoVideo } from "@/lib/lemo/compose";
import { productionProblems, productionSchema, type AccountContext, type CharacterSpec, type Production, type ProductionChoice, type VoiceLine } from "@/lib/lemo/contract";
import { directProduction } from "@/lib/lemo/direct";
import { buildFilmProject } from "@/lib/lemo/project";
import { lemoDoctor, renderVideo } from "@/lib/lemo/render";
import { chooseProduction } from "@/lib/lemo/select";
import { UsageLedger } from "@/lib/lemo/usage";
import { existingDuration, voiceFromExisting, voiceFromScript } from "@/lib/lemo/voice";
import type { ContentRule } from "@/lib/rules/check";
import { createServiceClient } from "@/lib/supabase/service";

// ─────────────────────────────────────────────────────────────────────────────
// lemo 코드 애니메이션 워커 — 명시적으로 부를 때만 돈다. 기존 AI 자동 영상 워커(make-auto-videos.ts)와 따로다.
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

const FPS = 30;
const SIZE = { w: 1080, h: 1920 };
const COMPARE_DEFAULTS = {
  voice: "D:/ai/ogai-test/story/final/voice.wav",
  timeline: "D:/ai/ogai-test/story/final/timeline.json",
  lines: "D:/ai/ogai-test/story/lines.tsv",
  production: "lib/lemo/fixtures/firstgel-story.production.json",
};

type Service = ReturnType<typeof createServiceClient>;
type Sources = Parameters<typeof chooseProduction>[0]["sources"];

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

interface Job {
  mode: "compare" | "script" | "plan";
  out: string;
  account: AccountContext;
  facts: ProductFacts;
  rules: ContentRule[];
  script: string[];
  hook: { spoken: string; on_screen: string } | null;
  sources: Sources;
  tone: string | null;
  service: Service | null;
  readService?: Service;
  // 비교 시험
  compare?: { voice: string; timeline: string; lines: string; production: string };
  // DB 기록(실제 저장 모드)
  record?: { organizationId: string; planId: string; socialAccountId: string };
}

interface Outcome {
  choice: ProductionChoice | null;
  production: Production | null;
  checks: { doctor?: unknown; contract?: string[]; characters?: string[]; render?: RenderChecks; final?: FinalChecks; warnings?: string[]; error?: string };
  // 완성본은 있지만 사람이 봐야 할 검수 문제(캐릭터 시트 불합격 · 무음 렌더 경고 · 완성본 검사 문제). 있으면 "완료"로 보지 않는다
  review: string[];
  characters: { reused: string[]; created: { id: string; sheet: string | null }[] };
  final: string | null;
  cover: string | null;
}

async function runJob(job: Job, ledger: UsageLedger): Promise<Outcome> {
  const outcome: Outcome = { choice: null, production: null, checks: {}, characters: { reused: [], created: [] }, final: null, cover: null, review: [] };
  const where = process.env.GITHUB_ACTIONS ? "server" : "local";

  // 0. 실행 환경 — 렌더 도구가 없으면 AI를 부르기 전에 멈춘다(돈을 쓰기 전에)
  const doctor = await ledger.time("doctor", () => lemoDoctor());
  outcome.checks.doctor = doctor;
  if (!doctor.ok) throw new Error(`lemo 렌더 환경 문제: ${doctor.problems.join(" / ")}`);

  let production: Production;
  let voice: VoiceLine[];
  let library: CharacterSpec[];

  if (job.mode === "compare") {
    const c = job.compare!;
    // 비교 시험은 같은 대본 · 같은 음성이다. 음성은 새로 만들지 않는다
    voice = await ledger.time("voice", () => voiceFromExisting({ voiceWav: c.voice, timelineJson: c.timeline, linesTsv: c.lines }));
    ledger.asset({ kind: "voice", id: c.voice, reused: true, note: "기존 음성 재사용(비교 시험)" });
    production = productionSchema.parse(JSON.parse(readFileSync(c.production, "utf8")));
    const total = existingDuration(c.timeline);
    if (Math.abs(total - production.duration) > 1 / FPS) console.warn(`[lemo] 기존 timeline 길이 ${total}초와 장면 데이터 길이 ${production.duration}초가 달라요`);
    library = loadAccountLibrary(production.account_key).characters;
    for (const cast of production.cast) ledger.asset({ kind: "character", id: cast.character, reused: true });
    outcome.choice = {
      backend: "lemo-code",
      style: production.style.slug,
      render_mode: null,
      reason: "비교 시험: 같은 대본 · 같은 음성에 고정 장면 데이터(fixtures)로 화면만 lemo로 만든다",
      rejected: [],
      characters: production.cast.map((x) => ({ role: x.role, reuse: x.character, why: "고정 장면 데이터" })),
      cost_class: "low",
    };
    outcome.characters.reused = production.cast.map((x) => x.character);
  } else {
    const lib = loadAccountLibrary(job.account.accountKey);
    // 1. 제작 방식 선택 — 기록으로 남긴다. lemo-code가 아니면 여기서 멈춘다(기존 AI 자동 경로가 맡는다)
    const chosen = await ledger.time("select", () => chooseProduction({ account: job.account, facts: job.facts, script: job.script, library: lib.characters, sources: job.sources }));
    ledger.add(chosen.usage);
    outcome.choice = chosen.choice;
    writeJson(job.out, "choice.json", { choice: chosen.choice, candidates: chosen.candidates });
    if (chosen.choice.backend !== "lemo-code") {
      console.log(`[lemo] 제작 방식 선택: ${chosen.choice.backend} — lemo 경로는 여기서 끝나요(${chosen.choice.reason})`);
      return outcome;
    }
    const style = chosen.choice.style;
    if (!style) throw new Error("lemo-code를 골랐는데 스타일이 비어 있어요");
    // 2. 캐릭터 — 그 계정 라이브러리에서 재사용하거나 새로 만든다
    const prepared = await ledger.time("characters", () =>
      prepareCharacters({ choice: chosen.choice, account: job.account, profile: lib.profile, library: lib.characters, script: job.script, facts: job.facts, workDir: join(job.out, "characters"), style }),
    );
    ledger.add(prepared.usage);
    for (const id of prepared.reused) ledger.asset({ kind: "character", id, reused: true });
    for (const c of prepared.created) ledger.asset({ kind: "character", id: c.spec.id, reused: false, note: c.sheet ?? undefined });
    outcome.characters = { reused: prepared.reused, created: prepared.created.map((c) => ({ id: c.spec.id, sheet: c.sheet ?? null })) };
    outcome.checks.characters = prepared.problems;
    if (prepared.problems.length) {
      console.warn(`[lemo] 캐릭터 준비 경고: ${prepared.problems.join(" / ")}`);
      outcome.review.push(...prepared.problems.map((p) => `캐릭터: ${p}`));
    }
    library = prepared.characters;
    // 3. 음성 확정 — 새 대본은 기존 TTS. 실패하면 던진다(무음 완료 금지)
    const made = await ledger.time("voice", () => voiceFromScript({ lines: job.script, voiceId: job.account.voiceId, workDir: join(job.out, "voice") }));
    ledger.add(made.usage);
    voice = made.voice;
    for (const w of made.warnings) console.warn(`[lemo] 음성: ${w}`);
    // 4. 장면 계획 — 확정된 음성 시각에 맞춘다
    const directed = await ledger.time("direct", () =>
      directProduction({ choice: chosen.choice, account: job.account, profile: lib.profile, characters: library, voice, script: job.script, facts: job.facts, size: SIZE, fps: FPS }),
    );
    ledger.add(directed.usage);
    const attempts: unknown = directed.attempts;
    const tries = typeof attempts === "number" ? attempts : Array.isArray(attempts) ? attempts.length : 1;
    if (tries > 1) ledger.retry({ stage: "direct", attempt: tries, scope: "장면 계획", reason: directed.problems.join(" / ") || "계약 검사 통과까지 다시 씀" });
    production = directed.production;
  }

  outcome.production = production;
  writeJson(job.out, "production.json", production);
  const contract = productionProblems(production, library, voice);
  outcome.checks.contract = contract;
  if (contract.length) throw new Error(`장면 데이터 계약 검사 실패: ${contract.join(" / ")}`);

  // 5. 코드 구성 → 6. 무음 렌더
  const filmDir = await ledger.time("project", () => buildFilmProject({ workDir: join(job.out, "film"), production, library }));
  const silent = join(job.out, "lemo-silent.mp4");
  const t0 = Date.now();
  const rendered = await renderVideo(filmDir, { fps: production.fps, size: production.size, out: silent });
  ledger.render({ stage: "lemo-render", seconds: (Date.now() - t0) / 1000, where, frames: rendered.frames, note: `${production.style.slug} · ${production.size.w}x${production.size.h}@${production.fps}` });

  // 7. 자동 검사 — 길이가 틀리면 음성과 어긋나므로 합성하지 않는다
  const render = await ledger.time("check-render", () => checkSilentRender(rendered.file, production, job.out));
  outcome.checks.render = render;
  if (!render.duration_ok) throw new Error(`무음 렌더 검사 실패: ${render.problems.join(" / ")}`);
  if (!render.ok) {
    console.warn(`[lemo] 무음 렌더 경고: ${render.problems.join(" / ")}`);
    outcome.review.push(...render.problems.map((p) => `무음 렌더: ${p}`));
  }

  // 8. 합성 — 기존 편집 키트. 모션 자막 스킬이 없으면 던진다
  const t1 = Date.now();
  const kit = await composeLemoVideo({
    lemoVideo: rendered.file,
    voice,
    production,
    script: job.script.length ? job.script : voice.map((v) => v.text),
    hook: job.hook,
    facts: job.facts,
    rules: job.rules,
    accountName: job.account.accountName,
    voiceId: job.account.voiceId,
    workDir: job.out,
    service: job.service,
    readService: job.readService,
    tone: job.tone,
  });
  ledger.render({ stage: "kit-compose", seconds: (Date.now() - t1) / 1000, where, frames: null, note: "기존 편집 키트(음성 · 모션 자막 · 음악 · 효과음 · 표지)" });
  ledger.add({ stage: "compose", provider: "openai", model: agentModel(), calls: 1, input: kit.tokens.input, cached_input: 0, cache_write: 0, output: kit.tokens.output, units: {} });
  // 받아쓰기(낱말 시각) — 음성 길이만큼
  if (kit.usedVoice) ledger.add({ stage: "compose-stt", provider: "openai", model: "whisper-1", calls: 1, input: 0, cached_input: 0, cache_write: 0, output: 0, units: { audio_seconds: Number(kit.timeline.duration.toFixed(2)) } });
  if (kit.sounds.music) ledger.asset({ kind: "music", id: kit.sounds.music, reused: true, note: kit.sounds.musicSource ? `${kit.sounds.musicSource.creator} · ${kit.sounds.musicSource.license}` : "편집 키트 대체 곡" });
  for (const s of kit.sounds.sfx) ledger.asset({ kind: "sfx", id: s, reused: true });
  outcome.checks.warnings = kit.warnings;

  const final = join(job.out, "final.mp4");
  const cover = join(job.out, "cover.jpg");
  copyFileSync(kit.final, final);
  copyFileSync(kit.cover, cover);
  outcome.final = final;
  outcome.cover = cover;
  outcome.checks.final = checkFinal(final, production.duration);
  if (!outcome.checks.final.ok) outcome.review.push(...outcome.checks.final.problems.map((p) => `완성본: ${p}`));
  return outcome;
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

  let job: Job;
  const emptySources: Sources = { photos: 0, gifs: 0, archive: 0 };
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
      sources: { ...emptySources, ...((spec.sources ?? {}) as Partial<Sources>) },
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
    const sources: Sources = { photos: Object.keys(saved?.assets?.photos ?? {}).length, gifs: Object.keys(saved?.assets?.gifs ?? {}).length, archive: Object.keys(saved?.assets?.archive ?? {}).length };
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
  let outcome: Outcome | null = null;
  let failure: string | null = null;
  try {
    outcome = await runJob(job, ledger);
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

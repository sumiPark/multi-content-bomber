import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProductFacts } from "@/lib/agents/product-facts";
import { agentModel } from "@/lib/agents/runner";
import type { ContentRule } from "@/lib/rules/check";
import type { KitInput, KitResult } from "@/lib/shoot/video-kit/pipeline";
import type { createServiceClient } from "@/lib/supabase/service";
import { loadAccountLibrary, prepareCharacters } from "./characters";
import { checkFinal, checkSilentRender, type FinalChecks, type RenderChecks } from "./checks";
import { composeLemoVideo } from "./compose";
import { productionProblems, productionSchema, type AccountContext, type CharacterSpec, type Production, type ProductionChoice, type VoiceLine } from "./contract";
import { directProduction } from "./direct";
import { buildFilmProject } from "./project";
import { lemoDoctor, renderVideo } from "./render";
import { chooseProduction } from "./select";
import type { UsageLedger } from "./usage";
import { existingDuration, voiceFromExisting, voiceFromScript } from "./voice";

// lemo 한 편 만들기 — worker/lemo-video.ts(수동 실행)와 worker/make-auto-videos.ts(AI 자동 영상 기본 경로)가 함께 쓴다.
//   선택(select) → 캐릭터(characters) → 음성 확정(voice) → 장면 계획(direct) → 코드 구성(project) → 렌더(render)
//   → 자동 검사(checks) → 합성(compose: 기존 편집 키트, 모션 자막 스킬 필수) → 결과
// 제작 방식 선택이 lemo-code가 아니면 final 없이 돌아온다(호출자가 기존 경로로 만든다).

export const FPS = 30;
export const SIZE = { w: 1080, h: 1920 };

type Service = ReturnType<typeof createServiceClient>;
export type LemoSources = Parameters<typeof chooseProduction>[0]["sources"];

function writeJson(dir: string, name: string, value: unknown): void {
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2));
}

export interface LemoJob {
  mode: "compare" | "script" | "plan";
  out: string;
  account: AccountContext;
  facts: ProductFacts;
  rules: ContentRule[];
  script: string[];
  // 음성으로 읽을 원고(숫자 · 영문을 말하는 대로 바꾼 줄, script와 줄 수가 같다). 없으면 script를 읽는다. 자막은 script로 쓴다
  speech?: string[];
  hook: { spoken: string; on_screen: string } | null;
  sources: LemoSources;
  tone: string | null;
  service: Service | null;
  readService?: Service;
  // 비교 시험
  compare?: { voice: string; timeline: string; lines: string; production: string };
  // AI 자동 영상 경로에서만: 칸 id · 완성본 프레임 검수를 편집 키트에 넘긴다
  planId?: string;
  reviewFinal?: KitInput["reviewFinal"];
  // DB 기록(실제 저장 모드)
  record?: { organizationId: string; planId: string; socialAccountId: string };
}

export interface LemoOutcome {
  choice: ProductionChoice | null;
  production: Production | null;
  checks: { doctor?: unknown; contract?: string[]; characters?: string[]; render?: RenderChecks; final?: FinalChecks; warnings?: string[]; error?: string };
  // 완성본은 있지만 사람이 봐야 할 검수 문제(캐릭터 시트 불합격 · 무음 렌더 경고 · 완성본 검사 문제). 있으면 "완료"로 보지 않는다
  review: string[];
  characters: { reused: string[]; created: { id: string; sheet: string | null }[] };
  final: string | null;
  cover: string | null;
  // 편집 키트 결과(편집 계획 · 시간표 · 품질 검수). 합성까지 가지 않았으면 null
  kit: KitResult | null;
}

export async function runLemoJob(job: LemoJob, ledger: UsageLedger): Promise<LemoOutcome> {
  const outcome: LemoOutcome = { choice: null, production: null, checks: {}, characters: { reused: [], created: [] }, final: null, cover: null, review: [], kit: null };
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
    const made = await ledger.time("voice", () => voiceFromScript({ lines: job.speech ?? job.script, voiceId: job.account.voiceId, workDir: join(job.out, "voice") }));
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
    planId: job.planId,
    reviewFinal: job.reviewFinal,
  });
  outcome.kit = kit;
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

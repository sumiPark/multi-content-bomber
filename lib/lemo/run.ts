import { appendFileSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProductFacts } from "@/lib/agents/product-facts";
import { agentModel } from "@/lib/agents/runner";
import type { ContentRule } from "@/lib/rules/check";
import { captionSkillDir } from "@/lib/shoot/video-kit/caption-skill";
import type { KitInput, KitResult } from "@/lib/shoot/video-kit/pipeline";
import { chosenFonts, downloadVideoFonts, loadSkillFonts } from "@/lib/shoot/video-kit/skill-fonts";
import type { createServiceClient } from "@/lib/supabase/service";
import type { BoardBrief } from "./board-brief";
import { loadAccountLibrary, prepareCharacters } from "./characters";
import { checkFinal, checkSilentRender, type FinalChecks, type RenderChecks } from "./checks";
import { composeLemoVideo } from "./compose";
import { productionProblems, productionSchema, type AccountContext, type CharacterSpec, type Production, type ProductionChoice, type VoiceLine } from "./contract";
import { directProduction } from "./direct";
import { directExplainer } from "./explain";
import { buildFilmProject } from "./project";
import { lemoDoctor, renderVideo } from "./render";
import { chooseNoCharacterStyle, chooseProduction } from "./select";
import type { UsageLedger } from "./usage";
import { existingDuration, voiceFromExisting, voiceFromScript } from "./voice";

// lemo 한 편 만들기 — worker/lemo-video.ts(수동 실행)와 worker/make-auto-videos.ts(AI 자동 영상 기본 경로)가 함께 쓴다.
//   선택(select) → 캐릭터(characters) → 음성 확정(voice) → 장면 계획(direct) → 코드 구성(project) → 렌더(render)
//   → 자동 검사(checks) → 합성(compose: 기존 편집 키트, 모션 자막 스킬 필수) → 결과
// 제작 방식 선택은 lemo-code로 정해져 있다(select.ts lemoOnly). lemo가 실패하면 throw한다.
// AI 자동 영상 호출자(lib/auto-video/lemo.ts)는 사진 · 스톡 컷으로 넘어가지 않고 그 칸을 "다시 만들기 필요"로 둔다(2026-11-13 사용자 결정).
// 조연 캐릭터 그림이 불합격하면 characters.ts가 배역을 다시 정하고(recast) 그 배역 계획으로 장면을 짠다. 상품 배역이 불합격하면 LemoCastError.
// 캐릭터 없이 설명하는 스타일(선택 결과 approach=no-characters — 픽토그램 모션 · 수채 붓)은 캐릭터 단계를 건너뛰고 explain.ts가 장면을 짠다.
//   음성 · 렌더 · 합성(편집 키트 · 모션 자막 스킬)은 캐릭터 영상과 같다. job.noCharacters면 AI 선택 없이 규칙으로 캐릭터 없는 스타일을 고른다(캐릭터 실패 뒤 다시 만들기).

export const FPS = 30;

/** 캐릭터 준비 실패(상품 배역 시트 불합격 · 다시 정한 뒤 남은 캐릭터 없음). 호출자가 다른 실패와 구분해 "캐릭터 없는 방식으로 다시 만들기"를 시도할 수 있다. */
export class LemoCastError extends Error {
  constructor(readonly failed: string[]) {
    super(`캐릭터 준비 실패 — ${failed.join(" / ")}`);
    this.name = "LemoCastError";
  }
}
/** 캐릭터 없는 방식으로 다시 만들려는데 고를 수 있는 캐릭터 없는 스타일이 없음(엔진 manifest characters: false가 없음). */
export class LemoNoExplainStyleError extends Error {
  constructor() {
    super("캐릭터 없이 설명하는 lemo 스타일 중 고를 수 있는 것이 없어요(엔진 manifest characters: false)");
    this.name = "LemoNoExplainStyleError";
  }
}
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
  // 장면표에서 추린 값(board-brief.ts): 장면별 화면 지시 · 화면 글자 · 자막 줄 · 강조어 · 글자 디자인 · 글꼴 · 끝 화면. 장면표 없이 만드는 실행은 비운다
  brief?: BoardBrief | null;
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
  // 캐릭터 없는 방식으로 다시 만들기(lib/auto-video/lemo.ts remakeWithoutCharacters): AI 선택 대신 규칙으로 캐릭터 없는 스타일을 고른다. why는 선택 이유 앞에 붙는다
  noCharacters?: { why: string };
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

// 화면 글자를 자막과 같은 스킬 글꼴(강조어 글꼴)로 쓰는 스타일. 다른 스타일의 화면 손글씨 소품은 엔진 글꼴(Gaegu)을 그대로 쓴다
const SKILL_FONT_STYLES = new Set(["pictogram-motion"]);
// 엔진 스타일이 먼저 찾는 글꼴 이름(engine/styles/pictogram-motion/style.js). 없으면 엔진 기본 글꼴로 나온다
const SCENE_FONT_FAMILY = "MCB Scene";

/**
 * 장면표가 고른 강조어 글꼴(없으면 스킬 기본 짝)을 받아 렌더 폴더 film/fonts에 넣고 fonts.css에 등록한다.
 * 글꼴 파일은 재배포 금지라 작업 폴더에만 둔다. 돌려준 fonts를 합성에 넘겨 자막도 같은 글꼴로 맞춘다. 던지지 않는다.
 */
async function addSceneFont(
  filmDir: string,
  workDir: string,
  fonts: { key_font: string; small_font: string } | null,
): Promise<{ fonts: { key_font: string; small_font: string } | null; warning: string | null }> {
  const dir = captionSkillDir();
  if (!dir) return { fonts, warning: "자막 모션 스킬이 없어 화면 글자는 대체 글꼴로 만들었어요" };
  try {
    const picked = chosenFonts(loadSkillFonts(dir), fonts ?? {});
    const got = await downloadVideoFonts(picked, join(workDir, "scene-font"));
    const key = got.files.find((f) => f.name.startsWith("video-key"));
    if (!key) throw new Error("강조어 글꼴 파일이 없어요");
    copyFileSync(key.from, join(filmDir, "fonts", key.name));
    // 굵기 범위를 열어 두어 스타일이 800으로 불러도 가짜 굵게 없이 이 파일(가장 굵은 굵기)을 쓴다
    appendFileSync(join(filmDir, "fonts", "fonts.css"), `\n@font-face { font-family: '${SCENE_FONT_FAMILY}'; font-weight: 100 900; src: url(${key.name}); font-display: block; }\n`);
    return { fonts: { key_font: picked.key.name, small_font: picked.small.name }, warning: null };
  } catch (e) {
    return { fonts, warning: `고른 글꼴을 받지 못해 화면 글자는 대체 글꼴로 만들었어요. (${e instanceof Error ? e.message : e})`.slice(0, 300) };
  }
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
    //    캐릭터 없는 방식으로 다시 만들 때는 AI를 부르지 않고 규칙으로 고른다
    const forced = job.noCharacters
      ? chooseNoCharacterStyle({ account: job.account, facts: job.facts, script: job.script, library: lib.characters, sources: job.sources, why: job.noCharacters.why })
      : null;
    if (job.noCharacters && !forced) throw new LemoNoExplainStyleError();
    let chosen: Pick<Awaited<ReturnType<typeof chooseProduction>>, "choice" | "candidates">;
    if (forced) chosen = forced;
    else {
      const picked = await ledger.time("select", () => chooseProduction({ account: job.account, facts: job.facts, script: job.script, library: lib.characters, sources: job.sources }));
      ledger.add(picked.usage);
      chosen = picked;
    }
    outcome.choice = chosen.choice;
    writeJson(job.out, "choice.json", { choice: chosen.choice, candidates: chosen.candidates });
    if (chosen.choice.backend !== "lemo-code") {
      console.log(`[lemo] 제작 방식 선택: ${chosen.choice.backend} — lemo 경로는 여기서 끝나요(${chosen.choice.reason})`);
      return outcome;
    }
    const style = chosen.choice.style;
    if (!style) throw new Error("lemo-code를 골랐는데 스타일이 비어 있어요");
    if (chosen.choice.approach === "no-characters") {
      // 캐릭터 없이 설명하는 스타일: 캐릭터 단계 없이 음성 → 장면 계획(explain.ts). 배역 · 캐릭터 라이브러리는 쓰지 않는다
      library = [];
      const made = await ledger.time("voice", () => voiceFromScript({ lines: job.speech ?? job.script, voiceId: job.account.voiceId, workDir: join(job.out, "voice") }));
      ledger.add(made.usage);
      voice = made.voice;
      for (const w of made.warnings) console.warn(`[lemo] 음성: ${w}`);
      const directed = await ledger.time("direct", () =>
        directExplainer({ choice: chosen.choice, account: job.account, profile: lib.profile, voice, script: job.script, facts: job.facts, brief: job.brief, size: SIZE, fps: FPS }),
      );
      ledger.add(directed.usage);
      if (directed.attempts > 1) ledger.retry({ stage: "direct", attempt: directed.attempts, scope: "장면 계획(캐릭터 없음)", reason: directed.problems.join(" / ") || "계약 검사 통과까지 다시 씀" });
      if (directed.problems.length) outcome.review.push(...directed.problems.map((p) => `연출: ${p}`));
      // 상품 그림의 모양 · 색은 글 자료로 추정한 값이라 사람이 확인한다(캐릭터 영상의 새 상품 캐릭터와 같은 규칙)
      outcome.review.push(...directed.review);
      production = directed.production;
    } else {
      // 2. 캐릭터 — 그 계정 라이브러리에서 재사용하거나 새로 만든다. 조연 시트가 끝내 불합격하면 배역을 다시 정한다
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
      // 배역을 다시 정했으면 그 배역 계획과 기록을 선택 결과에 남긴다(제작 기록 · 장면 계획이 같은 배역을 본다)
      const choice: ProductionChoice = { ...chosen.choice, characters: prepared.roles, ...(prepared.recast.length ? { recast: prepared.recast } : {}) };
      outcome.choice = choice;
      if (prepared.recast.length) writeJson(job.out, "choice.json", { choice, candidates: chosen.candidates });
      // 상품 배역의 합격한 시트가 없거나 남은 캐릭터가 없으면 여기서 멈춘다(사용량은 위에서 장부에 넣었다). AI 자동 영상은 그 칸을 "다시 만들기 필요"로 둔다
      if (prepared.failed.length) throw new LemoCastError(prepared.failed);
      library = prepared.characters;
      // 3. 음성 확정 — 새 대본은 기존 TTS. 실패하면 던진다(무음 완료 금지)
      const made = await ledger.time("voice", () => voiceFromScript({ lines: job.speech ?? job.script, voiceId: job.account.voiceId, workDir: join(job.out, "voice") }));
      ledger.add(made.usage);
      voice = made.voice;
      for (const w of made.warnings) console.warn(`[lemo] 음성: ${w}`);
      // 4. 장면 계획 — 확정된 음성 시각에 맞춘다
      const directed = await ledger.time("direct", () =>
        directProduction({ choice, account: job.account, profile: lib.profile, characters: library, voice, script: job.script, facts: job.facts, brief: job.brief, size: SIZE, fps: FPS }),
      );
      ledger.add(directed.usage);
      const attempts: unknown = directed.attempts;
      const tries = typeof attempts === "number" ? attempts : Array.isArray(attempts) ? attempts.length : 1;
      if (tries > 1) ledger.retry({ stage: "direct", attempt: tries, scope: "장면 계획", reason: directed.problems.join(" / ") || "계약 검사 통과까지 다시 씀" });
      // 다시 써도 남은 문제(자막 겹침, 상품 캐릭터 미등장 등)는 사람이 확인하게 남긴다
      if (directed.problems.length) outcome.review.push(...directed.problems.map((p) => `연출: ${p}`));
      production = directed.production;
    }
  }

  outcome.production = production;
  writeJson(job.out, "production.json", production);
  const contract = productionProblems(production, library, voice);
  outcome.checks.contract = contract;
  if (contract.length) throw new Error(`장면 데이터 계약 검사 실패: ${contract.join(" / ")}`);

  // 5. 코드 구성 → 6. 무음 렌더
  const filmDir = await ledger.time("project", () => buildFilmProject({ workDir: join(job.out, "film"), production, library }));
  // 화면 글자가 큰 스타일(픽토그램)은 화면 글자도 자막과 같은 스킬 글꼴로 쓴다. 못 받으면 엔진 글꼴로 만들고 경고를 남긴다
  let fonts = job.brief?.fonts ?? null;
  if (SKILL_FONT_STYLES.has(production.style.slug)) {
    const scene = await ledger.time("scene-font", () => addSceneFont(filmDir, job.out, fonts));
    fonts = scene.fonts;
    if (scene.warning) {
      console.warn(`[lemo] ${scene.warning}`);
      outcome.review.push(`글꼴: ${scene.warning}`);
    }
  }
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
    brief: job.brief,
    fonts,
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

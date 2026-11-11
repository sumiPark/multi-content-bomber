import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import profilesFile from "./styles.json";
import type { AccountContext, CharacterSpec, RenderMode } from "./contract";
import type { ProductFacts } from "@/lib/agents/product-facts";

// lemo 스타일 카탈로그 — 우리 쪽 스타일 프로필(styles.json)과 후보 좁히기 규칙.
// 영상마다 66종 STYLE.md를 전부 읽지 않는다. 규칙으로 3~5개로 좁힌 뒤, 그 후보의 STYLE.md에서 필요한 절만 발췌해 AI에게 준다.
// 엔진 manifest(lib/lemo/engine/manifest.json)는 다른 작업자가 만든다. 여기서는 런타임에 읽기만 하고 내용을 하드코딩하지 않는다.

export type StoryKind = "story" | "explainer" | "howto" | "data" | "product" | "list" | "mood";
export type Mood = "warm" | "cute" | "playful" | "calm" | "premium" | "clean" | "trust" | "retro" | "natural" | "dramatic" | "tech";
export type CastKind = "human" | "object" | "animal" | "none";
export type CostClass = "low" | "mid" | "high";

export interface StyleProfile {
  slug: string;
  name: string;
  render_mode: RenderMode;
  webgl: boolean;
  runner_speed: "fast" | "mid" | "slow";
  cost: CostClass;
  kinds: StoryKind[];
  moods: Mood[];
  cast: CastKind[];
  // 캐릭터 연기 적합도 0~3
  acting: number;
  // 실제 영상 · 데이터 · 설계 파일이 있어야 성립 — lemo-code 경로는 이런 자료를 넣지 않는다
  needs_material: boolean;
  // 판매 영상에 맞지 않는 분위기(공포 등)
  avoid: boolean;
  implemented: boolean;
  note: string;
}

export interface StyleCandidate {
  slug: string;
  name: string;
  render_mode: RenderMode;
  webgl: boolean;
  runner_speed: StyleProfile["runner_speed"];
  cost: CostClass;
  // 규칙 점수(가격은 넣지 않는다 — 같은 점수대에서 순서만 가른다)
  score: number;
  implemented: boolean;
  // 고를 수 있는지. 엔진 모듈이 없으면 false
  selectable: boolean;
  reasons: string[];
  blockers: string[];
}

export interface StyleContext {
  account: AccountContext;
  facts: ProductFacts | null;
  script: string[];
  sources?: { photos: number; gifs: number; archive: number };
  library?: CharacterSpec[];
}

const PROFILES: StyleProfile[] = (profilesFile as { styles: StyleProfile[] }).styles;
const BY_SLUG = new Map(PROFILES.map((p) => [p.slug, p]));

export function styleProfiles(): StyleProfile[] {
  return PROFILES;
}

export function styleProfile(slug: string): StyleProfile | undefined {
  return BY_SLUG.get(slug);
}

/** lemo-opuscar 라이브러리 폴더(STYLE.md를 읽는 곳). README의 실행 환경과 같다. */
export function lemoOpuscarHome(): string {
  return process.env.LEMO_OPUSCAR_HOME || "D:/ai/lemo-firstgel-test/_vendor/lemo-opuscar";
}

/** lib/lemo 폴더. 워커 · 서버 모두 저장소 루트에서 돈다(lib/shoot/video-kit와 같은 방식). */
export function lemoRoot(): string {
  return join(process.cwd(), "lib", "lemo");
}

// ── 엔진 manifest ─────────────────────────────────────────────────────────────

const manifestSchema = z.object({
  styles: z.record(
    z.string(),
    z
      .object({
        render_mode: z.string(),
        webgl: z.boolean(),
        transitions: z.array(z.string()),
        fx: z.array(z.string()),
        backgrounds: z.array(z.object({ kind: z.string(), params: z.record(z.string(), z.unknown()).default({}) }).loose()),
      })
      .loose(),
  ),
  props: z.array(z.unknown()).default([]),
  parametric: z
    .object({
      shapes: z.array(z.string()),
      expressions: z.array(z.string()),
      actions: z.array(z.string()),
    })
    .loose(),
});
export type EngineManifest = z.infer<typeof manifestSchema>;

// LEMO_ENGINE_DIR: 엔진 폴더를 바꿔 끼울 때(시험용 manifest 등). 기본은 lib/lemo/engine
export function manifestPath(engineDir = process.env.LEMO_ENGINE_DIR || join(lemoRoot(), "engine")): string {
  return join(engineDir, "manifest.json");
}

/** 엔진 manifest를 읽는다. 없거나 형식이 다르면 정확한 이유로 throw — 추측한 값으로 이어 가지 않는다. */
export function loadEngineManifest(engineDir?: string): EngineManifest {
  const path = manifestPath(engineDir);
  if (!existsSync(path)) {
    throw new Error(`lemo 엔진 manifest가 없어요: ${path} — 엔진 작업(lib/lemo/engine)이 끝나야 캐릭터 · 장면을 만들 수 있어요`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`lemo 엔진 manifest를 읽지 못했어요(${path}): ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`lemo 엔진 manifest 형식이 계약과 달라요(${path}): ${parsed.error.issues.slice(0, 4).map((i) => `${i.path.join(".")}: ${i.message}`).join(" / ")}`);
  }
  return parsed.data;
}

/** manifest.props는 이름 문자열 또는 {kind|name|id} 객체일 수 있다 — 이름만 모은다. */
export function manifestPropNames(m: EngineManifest): string[] {
  const out: string[] = [];
  for (const p of m.props) {
    if (typeof p === "string") out.push(p);
    else if (p && typeof p === "object") {
      const o = p as Record<string, unknown>;
      const name = o.kind ?? o.name ?? o.id;
      if (typeof name === "string") out.push(name);
    }
  }
  return [...new Set(out)];
}

/** 엔진에 스타일 모듈이 있는지. manifest가 있으면 그것을 따르고, 없으면 styles.json 값을 쓴다. */
function implementedSet(): { set: Set<string>; fromManifest: boolean } {
  try {
    const m = loadEngineManifest();
    return { set: new Set(Object.keys(m.styles)), fromManifest: true };
  } catch {
    return { set: new Set(PROFILES.filter((p) => p.implemented).map((p) => p.slug)), fromManifest: false };
  }
}

// ── 대본 · 계정 읽기(규칙) ────────────────────────────────────────────────────

const MOOD_WORDS: Record<Mood, RegExp> = {
  warm: /따뜻|다정|포근|편안|정겨/,
  cute: /귀여|아기자기|깜찍|앙증/,
  playful: /유쾌|재미|웃긴|웃음|밈|장난|발랄|경쾌|친근/,
  calm: /차분|잔잔|담백|조용|느긋/,
  premium: /고급|프리미엄|세련|우아|품격/,
  clean: /깔끔|미니멀|심플|정돈|단정/,
  trust: /전문|신뢰|정확|근거|과학|믿을/,
  retro: /레트로|복고|빈티지|옛날/,
  natural: /자연|산지|농가|신선|제철|농장|과수원/,
  dramatic: /강렬|극적|긴장|드라마/,
  tech: /기술|테크|미래|디지털/,
};

const MOOD_LABEL: Record<Mood, string> = {
  warm: "따뜻함",
  cute: "귀여움",
  playful: "유쾌함",
  calm: "차분함",
  premium: "고급스러움",
  clean: "깔끔함",
  trust: "신뢰감",
  retro: "복고",
  natural: "자연스러움",
  dramatic: "극적임",
  tech: "기술감",
};

const KIND_LABEL: Record<StoryKind, string> = {
  story: "캐릭터 이야기",
  explainer: "상식 · 원리 설명",
  howto: "순서 · 사용법",
  data: "숫자 · 비교",
  product: "제품 보여 주기",
  list: "목록형",
  mood: "분위기",
};

// 상품 종류별 기본 분위기 — 계정 설정보다 약하게 반영한다
const KIND_MOODS: Record<string, Mood[]> = {
  COSMETIC: ["clean", "warm", "premium"],
  FRUIT: ["natural", "warm", "playful"],
  FOOD: ["warm", "playful", "natural"],
  HEALTH_FOOD: ["trust", "clean", "calm"],
  CLOTHING: ["premium", "clean"],
};

export interface ScriptNeeds {
  kinds: Record<StoryKind, number>;
  accountMoods: Mood[];
  productMoods: Mood[];
  wantsHuman: boolean;
  wantsCharacter: boolean;
  notes: string[];
}

function countMatches(text: string, re: RegExp): number {
  return (text.match(new RegExp(re.source, "g")) ?? []).length;
}

/** 대본 · 계정 설정 · 상품에서 필요한 이야기 방식과 분위기를 규칙으로 집계한다. AI 호출 없음. */
export function analyzeNeeds(ctx: StyleContext): ScriptNeeds {
  const text = ctx.script.join("\n");
  const notes: string[] = [];

  // 이름 붙은 캐릭터: "방울이가 · 방울이는"처럼 같은 이름이 두 번 이상
  const names = new Map<string, number>();
  for (const m of text.matchAll(/([가-힣]{1,4}이)(?:가|는|를|도|랑|와|의|들)(?=[\s,.!?])/g)) names.set(m[1], (names.get(m[1]) ?? 0) + 1);
  const named = [...names.entries()].filter(([, n]) => n >= 2).map(([k]) => k);
  const personify = countMatches(text, /친구|주인공|손을 잡|손 잡|인사|만나요|했대요|됐대요|대요[.!?\s]|울었|웃었|날아가|도망|안아/);
  const quotes = countMatches(text, /[“”"「」]/) / 2;
  const we = /저희/.test(text) ? 1 : 0;
  const story = Math.min(1, (named.length ? 0.6 : 0) + personify * 0.12 + quotes * 0.1 + we * 0.3);
  if (named.length) notes.push(`이름 붙은 등장인물(${named.join(", ")})`);

  const explainer = Math.min(1, countMatches(text, /왜|이유|차이|성분|원료|품종|산지|비결|원리|때문|알고 계셨|상식|고르는|구별|보관|무엇|어떻게|사실은/) * 0.15);
  const howto = Math.min(1, countMatches(text, /순서|방법|단계|먼저|다음에|사용법|따라|바르|씻|자르|섞|넣어/) * 0.15);
  const data = Math.min(1, countMatches(text, /\d+(?:\.\d+)?\s?(?:%|g|kg|mg|도|브릭스|brix|종|가지|배|시간|분|일|개월|년|번)/i) * 0.25);
  const productName = ctx.facts?.name?.split(/\s+/)[0];
  const product = Math.min(1, (productName && productName.length >= 2 ? countMatches(text, new RegExp(productName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))) * 0.2 : 0) + ((ctx.sources?.photos ?? 0) >= 4 ? 0.3 : 0));
  const kinds: Record<StoryKind, number> = { story, explainer, howto, data, product, list: Math.min(1, countMatches(text, /첫째|둘째|셋째|하나는|두 번째|세 번째/) * 0.3), mood: 0.2 };

  const accountText = `${ctx.account.notes ?? ""}`;
  const accountMoods = (Object.keys(MOOD_WORDS) as Mood[]).filter((m) => MOOD_WORDS[m].test(accountText));
  const productMoods = ctx.facts ? (KIND_MOODS[ctx.facts.kind] ?? []) : [];
  const wantsHuman = /사람 중심|사람이 나오|인물|얼굴|일상|브이로그|사람/.test(accountText);
  const wantsCharacter = story >= 0.5 || (ctx.library?.length ?? 0) > 0;
  if (accountMoods.length) notes.push(`계정 설정 분위기: ${accountMoods.map((m) => MOOD_LABEL[m]).join(", ")}`);
  if (wantsHuman) notes.push("계정 설정에 사람 중심 방향이 있음");
  return { kinds, accountMoods, productMoods, wantsHuman, wantsCharacter, notes };
}

const PASS_SCORE = 3;
const COST_ORDER: Record<CostClass, number> = { low: 0, mid: 1, high: 2 };

function scoreStyle(p: StyleProfile, needs: ScriptNeeds, preferred: Set<string>): { score: number; reasons: string[]; blockers: string[] } {
  const reasons: string[] = [];
  const blockers: string[] = [];
  // 이야기 방식: 스타일이 잘하는 방식들의 필요도 합(최대 1.5)
  const kindHits = p.kinds.filter((k) => needs.kinds[k] >= 0.3).sort((a, b) => needs.kinds[b] - needs.kinds[a]);
  const kindFit = Math.min(1.5, p.kinds.reduce((s, k) => s + needs.kinds[k], 0));
  let score = kindFit * 3;
  if (kindHits.length) reasons.push(`대본 방식과 맞음: ${kindHits.map((k) => KIND_LABEL[k]).join(", ")}`);

  // 캐릭터 연기
  const story = needs.kinds.story;
  if (story >= 0.5) {
    score += (p.acting - 1.5) * 1.2 * story;
    if (p.acting >= 2) reasons.push(`캐릭터 연기 적합도 ${p.acting}/3`);
    if (p.acting === 0) blockers.push("캐릭터 연기를 거의 못 하는 스타일");
    if (p.cast.includes("none")) score -= 1.5;
  }
  if (needs.wantsHuman) {
    if (p.cast.includes("human")) {
      score += 1;
      reasons.push("사람 등장인물을 그릴 수 있음");
    } else score -= 0.5;
  }

  // 분위기: 계정 설정 1점씩(최대 2), 상품 종류 기본 0.5점씩(최대 1)
  const accHits = needs.accountMoods.filter((m) => p.moods.includes(m)).slice(0, 2);
  const prodHits = needs.productMoods.filter((m) => p.moods.includes(m)).slice(0, 2);
  score += accHits.length + prodHits.length * 0.5;
  if (accHits.length) reasons.push(`계정 분위기와 맞음: ${accHits.map((m) => MOOD_LABEL[m]).join(", ")}`);
  if (prodHits.length) reasons.push(`상품 종류의 기본 분위기와 맞음: ${prodHits.map((m) => MOOD_LABEL[m]).join(", ")}`);

  // 계정 선호는 가산점일 뿐 — 맞지 않는 스타일을 끌어올리지 못하게 1점만
  if (preferred.has(p.slug)) {
    score += 1;
    reasons.push("계정 선호 스타일(가산점)");
  }
  return { score: Math.round(score * 100) / 100, reasons, blockers };
}

/**
 * 규칙으로 후보를 3~5개로 좁힌다.
 * - 실제 영상 · 데이터 자료가 필요한 스타일, 판매 영상에 맞지 않는 스타일은 처음부터 뺀다.
 * - 점수는 대본 방식 · 캐릭터 연기 · 분위기 · 계정 선호(가산점)만 본다. 가격은 비슷한 점수(0.25 이내)에서 순서만 가른다.
 * - 기준 점수를 넘은 스타일이 3개보다 적으면 다음 점수로 채우되 "기준 점수 미달"을 단다.
 * - 엔진 모듈이 없는 스타일도 후보로 보이되 selectable=false와 막는 이유를 단다.
 *   기준을 넘은 구현 스타일이 목록에 없으면 마지막 자리를 그것으로 바꾼다(맞지 않는 구현 스타일은 넣지 않는다).
 * - lemoOnly(기본 — AI 자동 영상은 lemo로 만든다, 2026-11-11 사용자 결정): 구현된 스타일은 기준 점수에 못 미쳐도
 *   전부 목록에 넣고 고를 수 있게 둔다. 기존 사진 · 스톡 방식으로 넘기지 않기 위해서다. 점수 미달은 막는 점이 아니라 맞는 점 옆에 사실대로 적는다.
 */
export function shortlistStyles(ctx: StyleContext, opts: { lemoOnly?: boolean } = {}): StyleCandidate[] {
  const list = shortlistByScore(ctx);
  if (opts.lemoOnly === false) return list;
  const below = `기준 점수(${PASS_SCORE}) 미달`;
  for (const c of [...list, ...shortlistByScore(ctx, true)]) {
    if (!c.implemented) continue;
    const have = list.find((x) => x.slug === c.slug);
    const target = have ?? c;
    if (!have) list.push(target);
    if (!target.selectable) {
      target.selectable = true;
      target.blockers = target.blockers.filter((b) => !b.startsWith(below));
    }
    if (target.score < PASS_SCORE && !target.reasons.some((r) => r.startsWith(below))) {
      target.reasons.push(`${below} — lemo로 만들기로 해서 구현된 스타일은 늘 고를 수 있음`);
    }
  }
  return list;
}

function shortlistByScore(ctx: StyleContext, all = false): StyleCandidate[] {
  const needs = analyzeNeeds(ctx);
  const preferred = new Set(ctx.account.preferredStyles);
  const impl = implementedSet();
  const scored = PROFILES.filter((p) => !p.needs_material && !p.avoid).map((p) => {
    const s = scoreStyle(p, needs, preferred);
    const implemented = impl.set.has(p.slug);
    const blockers = [...s.blockers];
    if (!implemented) blockers.push("엔진 스타일 모듈 없음 — 고르려면 엔진 작업이 먼저 필요");
    const c: StyleCandidate = {
      slug: p.slug,
      name: p.name,
      render_mode: p.render_mode,
      webgl: p.webgl,
      runner_speed: p.runner_speed,
      cost: p.cost,
      score: s.score,
      implemented,
      selectable: implemented,
      reasons: s.reasons,
      blockers,
    };
    return c;
  });
  scored.sort((a, b) => (Math.abs(a.score - b.score) < 0.25 ? COST_ORDER[a.cost] - COST_ORDER[b.cost] : b.score - a.score));
  if (all) return scored;

  const passed = scored.filter((c) => c.score >= PASS_SCORE);
  const list = passed.slice(0, 5);
  for (const c of scored) {
    if (list.length >= 3) break;
    if (list.includes(c)) continue;
    c.blockers.push(`기준 점수(${PASS_SCORE}) 미달 — 비교용으로만 보여 줌`);
    c.selectable = false;
    list.push(c);
  }
  if (!list.some((c) => c.implemented && c.selectable)) {
    const bestImpl = passed.find((c) => c.implemented);
    if (bestImpl) {
      if (list.length >= 5) list[list.length - 1] = bestImpl;
      else list.push(bestImpl);
    }
  }
  return list;
}

// ── STYLE.md 발췌 ─────────────────────────────────────────────────────────────

const notesCache = new Map<string, string>();

function sections(md: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = md.split(/^## /m);
  for (const part of parts.slice(1)) {
    const m = part.match(/^(\d+)\./);
    if (m) out.set(m[1], part.slice(part.indexOf("\n") + 1).trim());
  }
  return out;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * 후보 스타일의 STYLE.md에서 고르는 데 필요한 절만 발췌한다(결과 캐시).
 * 한 줄 소개, 1절 첫 문단(무엇이고 무엇이 아닌지), 2절의 캐릭터 항목, 5절 움직임 앞 두 항목, 8절 고유 동작 이름.
 * STYLE.md를 못 읽으면 styles.json 한 줄 설명과 못 읽은 사실을 돌려준다.
 */
export function styleNotes(slug: string, maxChars = 1400): string {
  const key = `${slug}:${maxChars}`;
  const hit = notesCache.get(key);
  if (hit) return hit;
  const profile = BY_SLUG.get(slug);
  const path = join(lemoOpuscarHome(), "styles", slug, "STYLE.md");
  let out: string;
  if (!existsSync(path)) {
    out = `${profile?.note ?? slug} (STYLE.md 못 읽음: ${path})`;
  } else {
    const md = readFileSync(path, "utf8");
    const sec = sections(md);
    const tagline = md.match(/^> (.+)$/m)?.[1] ?? "";
    const essence = (sec.get("1") ?? "").split(/\n\s*\n/)[0] ?? "";
    const characters = (sec.get("2") ?? "").split("\n").find((l) => /^- \*\*Characters?/i.test(l)) ?? "";
    const motion = (sec.get("5") ?? "").split("\n").filter((l) => l.startsWith("- ")).slice(0, 2);
    const moves = [...(sec.get("8") ?? "").matchAll(/^- \*\*([^*]+?)\.?\*\*/gm)].map((m) => m[1]);
    const parts = [
      `한 줄: ${clip(tagline, 220)}`,
      essence && `본질: ${clip(essence, 420)}`,
      characters && `캐릭터: ${clip(characters.replace(/^- /, ""), 300)}`,
      motion.length ? `움직임: ${clip(motion.map((l) => l.replace(/^- /, "")).join(" / "), 320)}` : "",
      moves.length ? `고유 동작: ${moves.join(", ")}` : "",
    ].filter(Boolean);
    out = clip(parts.join("\n"), maxChars);
    // clip이 줄바꿈을 지우므로 항목 구분을 다시 넣는다
    out = out.replace(/ (본질|캐릭터|움직임|고유 동작): /g, "\n$1: ");
  }
  notesCache.set(key, out);
  return out;
}

export { KIND_LABEL as STORY_KIND_LABEL, MOOD_LABEL };

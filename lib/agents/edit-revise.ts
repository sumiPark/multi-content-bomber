import { z } from "zod";
import kitFile from "@/.claude/skills/ig-edit-ko/kit.json";
import { conceptBlock } from "@/lib/agents/concept";
import type { EditBeat, EditGraphic, EditPlan } from "@/lib/agents/edit-plan";
import { graphicSchema, sfxNames } from "@/lib/agents/edit-plan-parts";
import type { ProductFacts } from "@/lib/agents/product-facts";
import { runAgent, type AgentResult } from "@/lib/agents/runner";
import { checkText, type ContentRule } from "@/lib/rules/check";
import type { CaptionDesign } from "@/lib/shoot/video-kit/caption-skill";
import { lookSchema, normalizeLook, type Look } from "@/lib/shoot/video-kit/caption-style";
import { applyHumanText } from "@/lib/shoot/video-kit/human-text";
import type { PickedMusic } from "@/lib/shoot/video-kit/music";
import type { createServiceClient } from "@/lib/supabase/service";

// 완성본 고치기 — 관리자가 적은 "고칠 내용"을 저장된 편집 계획(EditPlan)에서 바꿀 곳만 답하게 한다(직접 촬영, 2026-11-12 사용자 결정).
// AI는 바꿀 곳만 내고, 코드(applyRevision)가 계획 사본에 적용한다. 요청하지 않은 부분은 코드가 건드리지 않는다.
// 앱(Vercel 함수)에서 바로 실행하므로 스킬 호출 없이 한 번에 답하고, 촬영본 프레임은 보지 않는다.
// 촬영본을 다시 봐야 하는 요청은 footage로 돌려주고, 워커의 편집 에이전트(edit-plan.ts의 revise)가 프레임을 보고 처리한다.
// 이 파일은 앱에서도 불러 쓰므로 스킬 폴더를 읽는 모듈(ko-skills) · FFmpeg를 쓰는 모듈(pipeline)을 불러오지 않는다. 규칙은 kit.json을 직접 불러온다.

type Service = ReturnType<typeof createServiceClient>;

/** 워커가 저장한 계획 — 고른 음악 · 자막 디자인이 붙어 있다(pipeline.ts renderKitEdit의 반환값). */
export type SavedEditPlan = EditPlan & {
  pickedMusic?: PickedMusic;
  captionDesign?: CaptionDesign;
  // 장면을 빼거나 순서를 바꿔 자막 번호가 달라졌다 — 워커가 자막 디자인의 줄별 값만 다시 정한다(모션 · 모양 · 글꼴은 그대로)
  redoCaptionLines?: boolean;
};

/** 사람이 정해 둔 글. 워커가 다시 편집할 때 계획 위에 덮어쓰는 값이라(applyHumanText) 미리 보기도 같은 값을 쓴다. */
export interface RevisePins {
  // 이 영상에 사람이 넣은 후킹 · 표지(script.human)
  humanHook?: string | null;
  humanThumbnail?: string | null;
  // 계정에 정해 둔 고정 후킹 · 끝 문구(script.fixed)
  fixedHook?: string | null;
  fixedEnding?: string | null;
}

const kit = kitFile;

// ─── AI의 답: 바꿀 곳만 ──────────────────────────────────────────────────────

const lookShape = lookSchema.shape;
const lookPatchSchema = z
  .object({
    align: lookShape.align.nullable(),
    treatment: lookShape.treatment.nullable(),
    text_color: lookShape.text_color.nullable(),
    accent_color: lookShape.accent_color.nullable(),
    box_color: lookShape.box_color.nullable(),
    size: lookShape.size.nullable(),
    emphasis_scale: lookShape.emphasis_scale.nullable(),
    emphasis: lookShape.emphasis.nullable(),
    layout: lookShape.layout.nullable(),
    reveal: lookShape.reveal.nullable(),
    entrance: lookShape.entrance.nullable(),
    tilt: lookShape.tilt.nullable(),
    punch: lookShape.punch.nullable(),
    music_query: lookShape.music_query.nullable(),
    music_intent: lookShape.music_intent.nullable(),
    music: lookShape.music.nullable(),
  })
  .describe("글자 디자인 · 음악 값. 요청한 칸만 값을 넣고 나머지는 null");

const beatPatchSchema = z.object({
  no: z.number().int().describe("지금 계획의 장면 번호(1부터)"),
  remove: z.boolean().describe("이 장면을 빼면 true. true면 나머지 칸은 null"),
  tts: z.string().nullable().describe("새 읽는 말. 그대로면 null"),
  captions: z.array(z.string()).nullable().describe("새 자막 묶음 전체. 그대로면 null"),
  emphasis: z.array(z.string()).nullable().describe("자막에서 강조할 핵심어 전체. 그대로면 null"),
  big: z.boolean().nullable().describe("자막을 큰 강조 글자로 보여 줄지. 그대로면 null"),
  graphics: z.array(graphicSchema).nullable().describe("이 장면의 그래픽 전체(그대로 둘 것도 옮겨 적는다). 그대로면 null"),
  sfx: z
    .array(z.object({ name: z.enum(sfxNames), at_word: z.string(), at: z.number() }))
    .nullable()
    .describe("이 장면의 효과음 전체(그대로 둘 것도 옮겨 적는다). 그대로면 null"),
  cuts: z
    .array(z.object({ clip: z.number().int(), in: z.number(), out: z.number(), what: z.string() }))
    .nullable()
    .describe("이 장면의 컷 전체. 지금 계획에 있는 컷 구간 안에서만 좁히기 · 빼기 · 순서 바꾸기. 그대로면 null"),
});

export const editRevisionSchema = z.object({
  hook: z.object({
    on_screen: z.string().nullable().describe("새 후킹 글자. 그대로면 null"),
    highlight: z.string().nullable().describe("후킹 글자에서 강조할 낱말. 그대로면 null"),
    spoken: z.string().nullable().describe("새 후킹 말(1번 장면의 읽는 말). 그대로면 null"),
  }),
  thumbnail: z.object({
    title: z.string().nullable().describe("새 표지 글자. 그대로면 null"),
    highlight: z.string().nullable().describe("표지 글자에서 강조할 낱말. 그대로면 null"),
    sub: z.string().nullable().describe("표지의 작은 글자. 없애려면 빈 문자열, 그대로면 null"),
  }),
  beats: z.array(beatPatchSchema).describe("바꾸는 장면만. 없으면 빈 배열"),
  order: z.array(z.number().int()).nullable().describe("장면 순서를 바꿀 때만: 남는 장면의 지금 번호를 새 순서대로 모두. 그대로면 null"),
  repick_music: z.boolean().describe("배경 음악을 다시 고르게 할지"),
  repick_caption_design: z.boolean().describe("자막 모양 · 움직임 · 글꼴을 다시 고르게 할지"),
  look: lookPatchSchema,
  footage: z.array(z.string()).describe("촬영본을 다시 봐야 반영할 수 있는 요청. 무엇을 다시 고를지 요청마다 한 문장. 없으면 빈 배열"),
  cannot: z
    .array(z.object({ request: z.string().describe("반영하지 못한 요청"), reason: z.string().describe("이유와 대신 할 수 있는 방법") }))
    .describe("이번에 반영할 수 없는 요청. 없으면 빈 배열"),
  notes: z.array(z.string()).describe("관리자가 알아야 할 것: 요청한 말을 고쳐 쓴 이유, 따옴표 글자의 규칙 위반 경고. 없으면 빈 배열"),
});
export type EditRevision = z.infer<typeof editRevisionSchema>;
type BeatPatch = EditRevision["beats"][number];

// ─── 따옴표 글자 ─────────────────────────────────────────────────────────────

const QUOTED = /["“”]([^"“”\n]+)["“”]|['‘’]([^'‘’\n]+)['‘’]|「([^」\n]+)」|『([^』\n]+)』/g;

/** 고칠 내용에서 따옴표(" " “ ” ' ' ‘ ’ 「 」 『 』)로 적은 글자. AI가 다듬지 않고 글자 그대로 넣어야 하는 글이다. */
export function quotedTexts(request: string): string[] {
  const out: string[] = [];
  for (const m of request.matchAll(QUOTED)) {
    const text = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

// 띄어쓰기 · 문장부호 · 기호를 뺀 글자. 이것이 같으면 같은 글을 다듬은 것으로 본다
const bare = (s: string) => s.normalize("NFC").replace(/[\s\p{P}\p{S}]+/gu, "");

/** AI가 낸 글이 따옴표 글자와 띄어쓰기 · 문장부호만 다르면 따옴표 글자로 되돌린다. */
export function restoreQuoted(text: string, quoted: string[]): string {
  const b = bare(text);
  if (!b) return text;
  return quoted.find((q) => bare(q) === b) ?? text;
}

const GRAPHIC_TEXT_KEYS = ["text", "small", "sub", "note", "chip", "left", "right"] as const;

function mapGraphicTexts(g: EditGraphic, fn: (text: string) => string): EditGraphic {
  const out: EditGraphic = { ...g, items: g.items.map(fn) };
  for (const k of GRAPHIC_TEXT_KEYS) out[k] = fn(g[k]);
  return out;
}

function restoreRevision(rev: EditRevision, quoted: string[]): EditRevision {
  if (!quoted.length) return rev;
  const fix = (t: string) => restoreQuoted(t, quoted);
  const opt = (t: string | null) => (t == null ? null : fix(t));
  return {
    ...rev,
    hook: { ...rev.hook, on_screen: opt(rev.hook.on_screen), spoken: opt(rev.hook.spoken) },
    thumbnail: { ...rev.thumbnail, title: opt(rev.thumbnail.title), sub: opt(rev.thumbnail.sub) },
    beats: rev.beats.map((b) => ({
      ...b,
      tts: opt(b.tts),
      captions: b.captions?.map(fix) ?? null,
      graphics: b.graphics?.map((g) => mapGraphicTexts(g, fix)) ?? null,
    })),
  };
}

/** 계획에 들어 있는 글 전부(후킹 · 표지 · 읽는 말 · 자막 · 그래픽 글자). */
function planTexts(plan: EditPlan): string[] {
  return [
    plan.hook.on_screen,
    plan.hook.spoken,
    plan.thumbnail.title,
    plan.thumbnail.sub,
    ...plan.beats.flatMap((b) => [b.tts, ...b.captions, ...b.graphics.flatMap((g) => [...GRAPHIC_TEXT_KEYS.map((k) => g[k]), ...g.items])]),
  ].filter((t) => !!t?.trim());
}

/**
 * 다시 세운 계획(워커의 revise)에서도 따옴표 글자를 보장한다. 지난 계획에 이미 있던 글은 건드리지 않는다
 * (요청하지 않은 글의 문장부호가 바뀌지 않게).
 */
export function restoreQuotedInPlan<T extends EditPlan>(plan: T, quoted: string[], previous?: EditPlan | null): T {
  if (!quoted.length) return plan;
  const keep = new Set(previous ? planTexts(previous) : []);
  const fix = (t: string) => (keep.has(t) ? t : restoreQuoted(t, quoted));
  return {
    ...plan,
    hook: { ...plan.hook, on_screen: fix(plan.hook.on_screen), spoken: fix(plan.hook.spoken) },
    thumbnail: { ...plan.thumbnail, title: fix(plan.thumbnail.title), sub: fix(plan.thumbnail.sub) },
    beats: plan.beats.map((b) => ({ ...b, tts: fix(b.tts), captions: b.captions.map(fix), graphics: b.graphics.map((g) => mapGraphicTexts(g, fix)) })),
  };
}

// ─── 계획에 적용 ─────────────────────────────────────────────────────────────

export interface AppliedRevision {
  // 고친 계획. 사람이 정해 둔 글(후킹 · 표지 · 끝 문구)까지 덮어쓴 값이라 워커가 만드는 결과와 같다
  plan: SavedEditPlan;
  // 지금 계획의 장면(0부터)이 고친 계획의 몇 번째가 되는지. 뺀 장면은 null
  sceneMap: (number | null)[];
  // 코드가 검증에서 버린 변경과 이유
  rejected: { request: string; reason: string }[];
  // 워커가 다시 고른다(저장된 계획에서 pickedMusic · captionDesign을 지워 둔다)
  repickMusic: boolean;
  repickDesign: boolean;
  // 다시 편집할 때 script.human에 저장할 글. null이면 저장하지 않는다
  humanHook: string | null;
  humanThumbnail: string | null;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const round = (v: number) => Math.round(v * 1000) / 1000;

// 컷 구간은 지금 컷 범위 안에서만 고친다. 소수점 반올림 차이는 봐준다
const CUT_SLACK = 0.05;
// sanitizePlan이 보장하는 컷 최소 길이와 같다
const MIN_CUT = 0.2;

const LOOK_KEYS = ["align", "treatment", "text_color", "accent_color", "box_color", "size", "emphasis_scale", "emphasis", "layout", "reveal", "entrance", "tilt", "punch", "music_query", "music_intent", "music"] as const;
type LookKey = (typeof LOOK_KEYS)[number];
const MUSIC_KEYS: LookKey[] = ["music_query", "music_intent", "music"];
const COLOR_KEYS: LookKey[] = ["text_color", "accent_color", "box_color"];
const LOOK_LABEL: Record<LookKey, string> = {
  align: "정렬",
  treatment: "글자 처리",
  text_color: "글자색",
  accent_color: "강조색",
  box_color: "바탕색",
  size: "글자 크기",
  emphasis_scale: "강조 크기",
  emphasis: "강조 방식",
  layout: "배치",
  reveal: "나오는 방식",
  entrance: "움직임",
  tilt: "기울기",
  punch: "화면 당김",
  music_query: "음악 검색어",
  music_intent: "음악 분위기",
  music: "대체 곡",
};

/** 긴 글을 낱말 단위로 max자 안팎의 자막 묶음으로 나눈다(AI가 읽는 말만 바꾸고 자막을 내지 않았을 때). */
function wrapCaption(text: string, max: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    if (line && (line + " " + word).length > max) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

function checkCuts(cuts: EditBeat["cuts"], originals: EditBeat["cuts"], live: boolean): EditBeat["cuts"] | string {
  if (!cuts.length) return "컷을 모두 뺄 수는 없어요.";
  if (live && cuts.length !== 1) return "촬영본의 말을 그대로 쓰는 장면은 컷을 하나만 쓸 수 있어요.";
  const out: EditBeat["cuts"] = [];
  for (const c of cuts) {
    const o = Number.isFinite(c.in) && Number.isFinite(c.out) ? originals.find((x) => x.clip === c.clip && c.in >= x.in - CUT_SLACK && c.out <= x.out + CUT_SLACK) : undefined;
    const from = o ? Math.max(o.in, c.in) : 0;
    const to = o ? Math.min(o.out, c.out) : 0;
    if (!o || to - from < MIN_CUT) return "지금 쓰는 컷 범위를 벗어나서 그대로 뒀어요. 컷은 지금 구간 안에서 좁히기 · 빼기 · 순서 바꾸기만 바로 고칠 수 있어요.";
    out.push({ clip: o.clip, in: round(from), out: round(to), what: c.what.trim() || o.what });
  }
  return out;
}

/**
 * AI가 답한 "바꿀 곳"을 계획 사본에 적용한다. 답에 없는 부분은 그대로 둔다.
 * 컷은 지금 컷 범위 안에서 좁히기 · 빼기 · 순서 바꾸기만 받고, 벗어나면 그 변경만 버리고 이유를 남긴다.
 * 마지막에 사람이 정해 둔 글을 워커와 같은 함수(applyHumanText)로 덮어써, 미리 보는 내용이 실제 편집과 같게 한다.
 */
export function applyRevision(plan: SavedEditPlan, raw: EditRevision, opts: { pins?: RevisePins; quoted?: string[] } = {}): AppliedRevision {
  const quoted = opts.quoted ?? [];
  const pins = opts.pins ?? {};
  const rev = restoreRevision(raw, quoted);
  const out = clone(plan);
  const rejected: AppliedRevision["rejected"] = [];
  const n = plan.beats.length;
  const originals = plan.beats.flatMap((b) => b.cuts);
  const captionMax = plan.caption_style === "sentence" ? 28 : 16;

  // 1. 장면별 변경 — 같은 장면을 두 번 답했으면 뒤의 것을 쓴다
  const patches = new Map<number, BeatPatch>();
  for (const p of rev.beats) {
    if (!Number.isInteger(p.no) || p.no < 1 || p.no > n) rejected.push({ request: `${p.no}번 장면`, reason: "그 번호의 장면이 없어요." });
    else patches.set(p.no - 1, p);
  }
  const removed = new Set<number>();
  const setTts = (beat: EditBeat, tts: string, captionsGiven: boolean) => {
    if (tts === beat.tts) return;
    beat.tts = tts;
    // 읽는 말만 바뀌고 자막이 그대로면 말과 자막이 달라진다 — 새 말로 자막을 다시 나눈다
    if (!captionsGiven && beat.captions.length) beat.captions = wrapCaption(tts, captionMax);
  };
  for (const [i, p] of patches) {
    const beat = out.beats[i];
    const name = `${i + 1}번 장면`;
    if (p.remove) {
      removed.add(i);
      continue;
    }
    const live = beat.mode === "live";
    if (p.tts != null) {
      const tts = p.tts.trim();
      if (live) rejected.push({ request: `${name} 읽는 말`, reason: "촬영본의 말을 그대로 쓰는 장면이라 말을 바꿀 수 없어요." });
      else if (!tts) rejected.push({ request: `${name} 읽는 말`, reason: "읽는 말을 비울 수는 없어요. 장면을 빼려면 빼 달라고 적어 주세요." });
      else setTts(beat, tts, p.captions != null);
    }
    if (p.captions != null) {
      if (live) rejected.push({ request: `${name} 자막`, reason: "촬영본의 말을 받아 적은 자막이라 바꿀 수 없어요." });
      else beat.captions = p.captions.map((c) => c.trim()).filter(Boolean);
    }
    if (p.emphasis != null) beat.emphasis = p.emphasis.map((e) => e.trim()).filter(Boolean);
    if (p.big != null) beat.big = p.big;
    if (p.graphics != null) beat.graphics = p.graphics.map((g) => ({ ...g }));
    if (p.sfx != null) beat.sfx = p.sfx.map((s) => ({ ...s }));
    if (p.cuts != null) {
      const checked = checkCuts(p.cuts, originals, live);
      if (typeof checked === "string") rejected.push({ request: `${name} 컷`, reason: checked });
      else beat.cuts = checked;
    }
  }

  // 2. 장면 빼기 · 순서
  if (removed.size >= n) {
    rejected.push({ request: "장면 빼기", reason: "장면을 모두 뺄 수는 없어요." });
    removed.clear();
  }
  let order = [...Array(n).keys()].filter((i) => !removed.has(i));
  if (rev.order) {
    const want = rev.order.map((no) => no - 1).filter((i) => !removed.has(i));
    const valid = want.length === order.length && new Set(want).size === want.length && want.every((i) => order.includes(i));
    if (valid) order = want;
    else rejected.push({ request: "장면 순서", reason: "남는 장면을 모두 한 번씩 적은 순서가 아니어서 순서는 그대로 뒀어요." });
  }
  const reordered = order.some((i, j) => j > 0 && order[j - 1] > i);
  const sceneMap = Array.from({ length: n }, (_, i) => {
    const j = order.indexOf(i);
    return j < 0 ? null : j;
  });
  out.beats = order.map((i) => out.beats[i]);
  // 장면 번호가 바뀌면 AI 이미지가 붙는 장면 번호도 맞춘다. 뺀 장면의 그림은 함께 뺀다
  if (plan.visuals) out.visuals = plan.visuals.flatMap((v) => (sceneMap[v.beat] == null ? [] : [{ ...v, beat: sceneMap[v.beat]! }]));

  // 3. 후킹 — 후킹 말은 첫 장면의 읽는 말이다
  const first = out.beats[0];
  const firstPatch = patches.get(order[0]);
  if (rev.hook.on_screen != null) {
    const text = rev.hook.on_screen.trim();
    if (text) out.hook.on_screen = text;
    else rejected.push({ request: "후킹 글자", reason: "후킹 글자를 비울 수는 없어요." });
  }
  if (rev.hook.highlight != null) out.hook.highlight = rev.hook.highlight.trim();
  if ((rev.hook.on_screen != null || rev.hook.highlight != null) && !out.hook.on_screen.includes(out.hook.highlight)) out.hook.highlight = "";
  if (rev.hook.spoken != null) {
    const spoken = rev.hook.spoken.trim();
    if (!spoken) rejected.push({ request: "후킹 말", reason: "후킹 말을 비울 수는 없어요." });
    else if (first.mode === "live") rejected.push({ request: "후킹 말", reason: "첫 장면이 촬영본의 말을 그대로 쓰는 장면이라 바꿀 수 없어요." });
    else setTts(first, spoken, firstPatch?.captions != null);
  }
  if (first.mode === "tts" && first.tts !== plan.beats[0].tts) out.hook.spoken = first.tts;
  // 첫 장면 자막이 후킹 글자와 같으면 같은 글이 화면에 두 번 나온다 — AI가 후킹을 바꾸며 자막에도 적었으면 비운다
  if (firstPatch?.captions != null && bare(first.captions.join("")) === bare(out.hook.on_screen)) first.captions = [];
  // 첫 장면에는 후킹 글자가 나와 원 · 화살표 말고는 넣지 않는다(워커도 같은 규칙으로 뺀다)
  const firstGraphics = first.graphics.filter((g) => g.type === "ring" || g.type === "arrow");
  if (firstGraphics.length !== first.graphics.length) {
    if (firstPatch?.graphics != null) rejected.push({ request: "첫 장면 화면 문구", reason: "첫 장면에는 후킹 글자가 나와서 다른 화면 문구를 넣을 수 없어요." });
    first.graphics = firstGraphics;
  }

  // 4. 표지
  if (rev.thumbnail.title != null) {
    const title = rev.thumbnail.title.trim();
    if (title) out.thumbnail.title = title;
    else rejected.push({ request: "표지 글자", reason: "표지 글자를 비울 수는 없어요." });
  }
  if (rev.thumbnail.highlight != null) out.thumbnail.highlight = rev.thumbnail.highlight.trim();
  if ((rev.thumbnail.title != null || rev.thumbnail.highlight != null) && !out.thumbnail.title.includes(out.thumbnail.highlight)) out.thumbnail.highlight = "";
  if (rev.thumbnail.sub != null) out.thumbnail.sub = rev.thumbnail.sub.trim();

  // 5. 글자 디자인 · 음악 값
  const patch: Record<string, string | number | boolean> = {};
  for (const key of LOOK_KEYS) {
    const given = rev.look[key];
    if (given == null) continue;
    let value: string | number | boolean = typeof given === "string" ? given.trim() : given;
    if (COLOR_KEYS.includes(key)) {
      if (!/^#[0-9a-fA-F]{6}$/.test(String(value))) {
        rejected.push({ request: LOOK_LABEL[key], reason: "색은 #RRGGBB 값으로만 바꿀 수 있어서 그대로 뒀어요." });
        continue;
      }
      value = String(value).toUpperCase();
    }
    // 대체 곡은 목록에 있는 곡만
    if (key === "music" && !kit.music_library.some((m) => m.file === value)) continue;
    patch[key] = value;
  }
  if (Object.keys(patch).length) out.look = normalizeLook({ ...plan.look, ...patch } as Partial<Look>);
  const lookChanged = (key: LookKey) => !!plan.look && out.look[key] !== plan.look[key];
  const repickMusic = rev.repick_music || MUSIC_KEYS.some(lookChanged);
  const repickDesign = rev.repick_caption_design;
  if (repickMusic) delete out.pickedMusic;
  if (repickDesign) delete out.captionDesign;

  // 6. 사람이 정해 둔 글 — 워커가 다시 편집할 때 덮어쓰는 값과 같게 맞춘다
  const pinnedHook = pins.humanHook?.trim() || pins.fixedHook?.trim() || "";
  // 후킹 · 표지 글자가 바뀌었는데 예전 값이 고정돼 있으면 워커가 예전 값으로 되돌린다 — 새 글자를 사람이 정한 글로 저장한다.
  // 따옴표로 적은 글자도 사람이 정한 글이다
  const humanHook = out.hook.on_screen !== plan.hook.on_screen && (pinnedHook || quoted.includes(out.hook.on_screen)) ? out.hook.on_screen : null;
  const humanThumbnail = out.thumbnail.title !== plan.thumbnail.title && (pins.humanThumbnail?.trim() || quoted.includes(out.thumbnail.title)) ? out.thumbnail.title : null;
  const hookText = (humanHook ?? pins.humanHook)?.trim() || pins.fixedHook?.trim() || "";
  if (hookText && (rev.hook.spoken != null || firstPatch?.tts != null) && first.mode === "tts" && first.tts !== hookText) {
    rejected.push({ request: "후킹 말", reason: "후킹이 정해져 있어서 후킹 말은 후킹 글자와 같은 글로 읽어요. 말만 따로 바꿀 수는 없어요." });
  }
  const ending = pins.fixedEnding?.trim();
  const last = out.beats[out.beats.length - 1];
  const lastPatch = patches.get(order[order.length - 1]);
  if (ending && out.beats.length > 1 && last.mode === "tts" && lastPatch && ((lastPatch.tts != null && last.tts !== ending) || (lastPatch.captions != null && last.captions.join(" ") !== ending))) {
    rejected.push({ request: "마지막 말", reason: "마지막 말은 계정에 정해 둔 끝 문구로 고정돼 있어서 그대로 뒀어요." });
  }
  const pinned = applyHumanText(out, {
    humanHook: humanHook ?? pins.humanHook,
    humanThumbnail: humanThumbnail ?? pins.humanThumbnail,
    fixedHook: pins.fixedHook,
    fixedEnding: pins.fixedEnding,
  }) as SavedEditPlan;

  // 7. 자막 번호가 달라졌으면 지난 자막 디자인의 줄별 값이 다른 자막에 붙는다 — 워커가 줄별 값만 다시 정하게 표시한다
  const captionCountChanged = order.some((i, j) => plan.beats[i].captions.length !== pinned.beats[j].captions.length);
  if (pinned.captionDesign && (removed.size > 0 || reordered || captionCountChanged)) pinned.redoCaptionLines = true;

  return { plan: pinned, sceneMap, rejected, repickMusic, repickDesign, humanHook, humanThumbnail };
}

// ─── 전 → 후 목록 ────────────────────────────────────────────────────────────

export interface RevisionChange {
  label: string;
  before: string;
  after: string;
}

const NONE = "없음";
const oneLine = (s: string) => s.replace(/\s*\n+\s*/g, " / ").trim();
const shown = (s: string) => oneLine(s) || NONE;

const GRAPHIC_LABEL: Record<EditGraphic["type"], string> = {
  badge: "큰 낱말",
  title: "제목",
  chip: "표시 줄",
  notice: "안내 카드",
  stat: "숫자",
  split: "비교",
  steps: "단계",
  ring: "원 표시",
  arrow: "화살표",
  end_card: "끝 화면",
};
const SFX_LABEL: Record<(typeof sfxNames)[number], string> = { pop: "팝", click: "딸깍", rustle: "사각", whoosh: "휙", plug: "끼우는 소리", tick: "초침", ding: "딩" };
const LOOK_VALUE: Record<string, string> = {
  center: "가운데",
  left: "왼쪽",
  stroke: "외곽선",
  box: "띠",
  pill: "말풍선",
  shade: "그림자",
  color: "글자색",
  fill: "색 바탕",
  underline: "밑줄",
  inline: "한 흐름",
  key_line: "핵심어 따로",
  line: "한 번에",
  word: "낱말씩",
  pop: "튀어나옴",
  slam: "세게",
  rise: "올라옴",
  wipe: "닦아 내듯",
  fade: "서서히",
  true: "켬",
  false: "끔",
};

function graphicsText(list: EditGraphic[]): string {
  if (!list.length) return NONE;
  return list
    .map((g) => {
      const words = [g.chip, g.small, g.text, g.sub, g.note, [g.number, g.unit].filter(Boolean).join(""), [g.left, g.right].filter(Boolean).join(" · "), ...g.items].map((t) => t.trim()).filter(Boolean);
      return `${GRAPHIC_LABEL[g.type] ?? g.type}${words.length ? ` “${words.join(" · ")}”` : ""}`;
    })
    .join(", ");
}

function sfxText(list: EditBeat["sfx"]): string {
  if (!list.length) return NONE;
  return list.map((s) => `${SFX_LABEL[s.name] ?? s.name}${s.at_word.trim() ? `(“${s.at_word.trim()}”에서)` : ""}`).join(", ");
}

function cutsText(list: EditBeat["cuts"]): string {
  if (!list.length) return NONE;
  return list.map((c) => `${c.clip}번 촬영본 ${c.in.toFixed(1)}~${c.out.toFixed(1)}초`).join(", ");
}

const emphasisText = (b: EditBeat) => [b.emphasis.join(", "), b.big ? "크게" : ""].filter(Boolean).join(" · ") || NONE;

/**
 * 사람이 확인할 전 → 후 목록. 장면 번호는 지금 완성본의 번호(1부터)다.
 * 후킹 → 표지 → 장면 순서 → 장면별(읽는 말 · 자막 · 강조 · 화면 문구 · 효과음 · 컷, 빼는 장면) → 글자 디자인 → 음악 → 자막 모양 차례다.
 */
export function revisionChanges(before: SavedEditPlan, applied: AppliedRevision): RevisionChange[] {
  const after = applied.plan;
  const out: RevisionChange[] = [];
  const push = (label: string, a: string, b: string) => {
    if (shown(a) !== shown(b)) out.push({ label, before: shown(a), after: shown(b) });
  };
  push("후킹 글자", before.hook.on_screen, after.hook.on_screen);
  push("후킹 강조 낱말", before.hook.highlight, after.hook.highlight);
  push("후킹 말", before.hook.spoken, after.hook.spoken);
  const hookSpokenChanged = shown(before.hook.spoken) !== shown(after.hook.spoken);
  push("표지 글자", before.thumbnail.title, after.thumbnail.title);
  push("표지 강조 낱말", before.thumbnail.highlight, after.thumbnail.highlight);
  push("표지 작은 글자", before.thumbnail.sub, after.thumbnail.sub);

  const kept = applied.sceneMap.flatMap((j, i) => (j == null ? [] : [{ i, j }]));
  const newOrder = [...kept].sort((a, b) => a.j - b.j).map((k) => k.i + 1);
  push("장면 순서", kept.map((k) => k.i + 1).join(" → "), newOrder.join(" → "));

  before.beats.forEach((b, i) => {
    const name = `${i + 1}번 장면`;
    const j = applied.sceneMap[i];
    if (j == null) {
      out.push({ label: name, before: b.mode === "live" ? "촬영본의 말을 쓰는 장면" : shown(b.tts), after: "빼요" });
      return;
    }
    const a = after.beats[j];
    // 첫 장면의 읽는 말은 후킹 말과 같은 글이라 두 번 보여 주지 않는다
    if (!(i === 0 && j === 0 && hookSpokenChanged && a.tts === after.hook.spoken)) push(`${name} 읽는 말`, b.tts, a.tts);
    push(`${name} 자막`, b.captions.join(" / "), a.captions.join(" / "));
    push(`${name} 강조`, emphasisText(b), emphasisText(a));
    push(`${name} 화면 문구`, graphicsText(b.graphics), graphicsText(a.graphics));
    push(`${name} 효과음`, sfxText(b.sfx), sfxText(a.sfx));
    push(`${name} 컷`, cutsText(b.cuts), cutsText(a.cuts));
  });

  const lookKeys = before.look ? LOOK_KEYS.filter((k) => !MUSIC_KEYS.includes(k) && before.look[k] !== after.look[k]) : [];
  if (lookKeys.length) {
    const text = (l: Look) => lookKeys.map((k) => `${LOOK_LABEL[k]} ${LOOK_VALUE[String(l[k])] ?? String(l[k])}`).join(" · ");
    out.push({ label: "글자 디자인", before: text(before.look), after: text(after.look) });
  }
  if (applied.repickMusic) {
    const intent = after.look?.music_intent?.trim();
    const asked = !!intent && intent !== before.look?.music_intent?.trim();
    out.push({ label: "배경 음악", before: before.pickedMusic?.name || "지금 음악", after: asked ? `다시 골라요 (${intent})` : "다시 골라요" });
  }
  if (applied.repickDesign) {
    const fonts = [before.captionDesign?.key_font, before.captionDesign?.small_font].filter(Boolean).join(" · ");
    out.push({ label: "자막 모양 · 글꼴", before: fonts || "지금 모양", after: "다시 골라요" });
  }
  return out;
}

/**
 * 새로 들어간 글이 광고 문구 규칙(금지 표현)에 어긋나는지 코드로 다시 본다. AI가 고쳐 쓰지 못했거나 따옴표 글자라 그대로 넣은 경우의 경고다.
 * 다시 편집한 뒤에는 워커의 점검(checkScript)이 한 번 더 확인해 받기 화면에 보여 준다.
 */
export function ruleNotes(
  before: EditPlan,
  after: EditPlan,
  ctx: { facts: Pick<ProductFacts, "kind" | "approvedClaims" | "healthFunctional" | "certifiedFunctions">; rules: ContentRule[]; quoted?: string[] },
): string[] {
  const old = new Set(planTexts(before));
  const banned = ctx.rules.filter((r) => r.ruleType === "BANNED");
  const notes: string[] = [];
  for (const text of new Set(planTexts(after))) {
    if (old.has(text)) continue;
    for (const hit of checkText(text, ctx.facts.kind, banned, ctx.facts.approvedClaims, { healthFunctional: ctx.facts.healthFunctional, certifiedFunctions: ctx.facts.certifiedFunctions })) {
      const why = hit.rule.reason?.trim() ? ` (${hit.rule.reason.trim()})` : "";
      const kept = ctx.quoted?.includes(text) ? " 따옴표로 적은 글이라 그대로 넣었어요." : "";
      notes.push(`“${oneLine(text)}”에 광고 문구 규칙에 어긋나는 표현이 있어요: ${hit.matched ?? hit.rule.phrase}${why}.${kept} 다시 편집한 뒤 점검에서 한 번 더 확인해요.`);
    }
  }
  return [...new Set(notes)];
}

// ─── 에이전트 ────────────────────────────────────────────────────────────────

export interface EditReviseContext {
  // null이면 실행 기록을 남기지 않는다
  service: Service | null;
  readService?: Service;
  planId?: string;
  accountName: string;
  facts: ProductFacts;
  rules: ContentRule[];
  plan: SavedEditPlan;
  // 관리자가 적은 고칠 내용
  request: string;
  pins?: RevisePins;
  // 계정의 말투 · 분위기(촬영 설정)
  tone?: string | null;
}

const bullets = (lines: string[]) => lines.map((l) => `- ${l}`).join("\n");

/** AI에게 보여 주는 지금 계획 — 장면 번호(1부터)를 붙인 간결한 보기. */
export function planView(plan: SavedEditPlan): string {
  const compact = (g: EditGraphic) => Object.fromEntries(Object.entries(g).filter(([k, v]) => k === "type" || (Array.isArray(v) ? v.length > 0 : v !== "" && v !== 0)));
  const imageOf = new Map((plan.visuals ?? []).map((v) => [v.beat, v.subject]));
  const scenes = plan.beats.map((b, i) =>
    `${i + 1}. ${JSON.stringify({
      mode: b.mode,
      tts: b.tts,
      captions: b.captions,
      emphasis: b.emphasis,
      big: !!b.big,
      cuts: b.cuts,
      graphics: b.graphics.map(compact),
      sfx: b.sfx,
      ...(imageOf.has(i) ? { ai_image: imageOf.get(i) } : {}),
    })}`,
  );
  const lookView = plan.look ? Object.fromEntries(LOOK_KEYS.map((k) => [k, plan.look[k]])) : {};
  const music = plan.pickedMusic ? `"${plan.pickedMusic.name}"${plan.pickedMusic.query ? ` (검색어 "${plan.pickedMusic.query}")` : " (대체 곡)"}` : "저장된 곡 없음";
  const design = plan.captionDesign
    ? `대표 모션 ${plan.captionDesign.key_fx} · 글꼴 ${plan.captionDesign.key_font} + ${plan.captionDesign.small_font}${plan.captionDesign.key_look ? ` · 예능 모양 ${plan.captionDesign.key_look}` : ""}`
    : "기본 자막";
  return `자막 방식: ${plan.caption_style === "sentence" ? "sentence (말한 문장을 그대로 보여 준다)" : "keyword (핵심어를 크게 보여 준다)"}
후킹: ${JSON.stringify({ on_screen: plan.hook.on_screen, highlight: plan.hook.highlight, spoken: plan.hook.spoken })}
표지: ${JSON.stringify({ title: plan.thumbnail.title, highlight: plan.thumbnail.highlight, sub: plan.thumbnail.sub })}
장면 ${plan.beats.length}개:
${scenes.join("\n")}
글자 디자인 · 음악 값(look): ${JSON.stringify(lookView)}
배경 음악: ${music}
자막 모양: ${design}`;
}

function systemPrompt(ctx: EditReviseContext): string {
  const f = ctx.facts;
  const { sourceText: _source, rawName: _listing, ...facts } = f;
  void _source;
  void _listing;
  const pins = ctx.pins ?? {};
  const fixedHook = pins.humanHook?.trim() || pins.fixedHook?.trim();
  const fixedEnding = pins.fixedEnding?.trim();
  const banned = ctx.rules.filter((r) => r.ruleType === "BANNED" && (r.scope === "ALL" || r.scope === f.kind));
  return `너는 인스타그램 @${ctx.accountName}의 릴스 편집자다. 이미 만든 완성본의 편집 계획이 있고, 관리자가 "고칠 내용"을 적었다. 계획 전체를 다시 쓰지 않고 바꿀 곳만 답한다. 코드가 그 답을 계획에 적용하고, 음성과 영상은 그 뒤에 다시 만든다.
상품: ${f.shop} ${f.kindLabel} "${f.name}"
너는 촬영본을 볼 수 없다. 계획에 적힌 글과 컷 설명만 보고 답한다.

답하는 법:
- 요청한 것만 바꾼다. 요청하지 않은 글 · 장면 · 컷 · 그래픽 · 효과음 · 글자 디자인은 바꾸지 않는다. 바꾸지 않는 칸은 null로 두고(배열 칸도 null), beats에는 바꾸는 장면만 넣는다.
- 장면 번호는 아래 계획의 번호(1부터)다. 관리자가 장면을 내용으로 가리키면(예: "뚜껑 여는 장면") 읽는 말과 컷 설명으로 찾는다. 어느 장면인지 정할 수 없으면 바꾸지 말고 cannot에 적는다.
- 후킹 말은 1번 장면의 읽는 말이다. 후킹 말을 바꾸려면 hook.spoken에만 쓴다(1번 장면의 tts는 코드가 맞춘다). 후킹을 바꿔도 1번 장면의 captions는 건드리지 않는다(후킹 글자가 화면에 나온다).
- 후킹 · 표지 글자를 바꿀 때 지금 강조 낱말이 새 글자에 그대로 있으면 highlight는 null로 둔다. 없으면 새 글자에서 낱말 하나만 고른다.
- 읽는 말(tts)을 바꾸면 그 장면의 자막(captions)도 새 말에 맞게 함께 낸다. 자막만 바꾸라는 요청이면 tts는 null로 둔다. 새 자막에 없는 강조어가 남으면 emphasis도 함께 낸다.
- 자막을 짧게 해 달라는 요청은 읽는 말은 그대로 두고 자막 글의 낱말을 줄여 뜻만 남긴다. 자막 방식이 sentence여도 요청을 따른다. 글은 그대로 둔 채 묶음만 다시 나누거나 합치는 것으로 답하지 않는다.
- 화면 문구는 그 장면의 그래픽(graphics) 글자다. 그래픽이나 효과음을 넣고 · 빼고 · 고치면 그 장면의 graphics · sfx 배열 전체를 낸다. 그대로 둘 항목은 지금 값 그대로 옮겨 적고, 쓰지 않는 칸은 빈 문자열 · 0 · 빈 배열로 둔다.
- 1번 장면에는 후킹 글자가 나온다. ring · arrow 말고 다른 그래픽을 넣지 않는다.
- 영상 길이는 읽는 말의 길이로 정해진다(읽는 글자 약 7자가 1초). 길이를 줄이라는 요청은 장면을 빼거나(remove) 읽는 말을 줄여서 맞춘다. 컷 구간만 좁혀서는 길이가 줄지 않는다.
- 읽는 말을 빈 문자열로 둘 수 없다. 장면을 없애려면 remove를 true로 한다.
- 장면 순서를 바꾸면 order에 남는 장면의 지금 번호를 새 순서대로 모두 적는다. 1번 자리에 오는 장면이 후킹 장면이 된다.
- 컷(cuts)은 지금 계획에 있는 컷 구간 안에서만 고친다: 구간 좁히기, 컷 빼기, 컷 순서 바꾸기. 고치면 그 장면의 cuts 배열 전체를 낸다. 계획에 없는 구간이나 다른 촬영본은 쓸 수 없다.
- 촬영본을 다시 봐야 반영할 수 있는 요청은 고치지 말고 footage에 넣는다: 다른 장면 · 다른 구간을 써 달라는 요청("제품이 더 잘 보이는 장면으로", "손이 안 나오는 컷으로"), 길이를 늘리거나 장면을 더 넣어 달라는 요청, 표지에 쓸 장면을 바꿔 달라는 요청. 무엇을 다시 고를지 요청마다 한 문장으로 쓴다.
- 배경 음악을 바꾸라는 요청은 repick_music을 true로 한다. 원하는 분위기를 말했으면 look.music_query(영어 2~4낱말, 악기 · 분위기)와 look.music_intent도 고친다. music_intent에는 원하는 분위기만 짧게 쓴다(예: 잔잔하고 차분한 피아노 분위기). "기존보다" 같은 비교나 "골라요" 같은 서술은 쓰지 않는다.
- 자막 모양 · 움직임 · 글꼴을 바꾸라는 요청은 repick_caption_design을 true로 한다. 색 · 크기 · 정렬 · 글자 처리처럼 값을 말했으면 look의 해당 칸도 고친다. 색은 #RRGGBB로 쓴다.
- 이번에 반영할 수 없는 요청은 고치지 말고 cannot에 요청과 이유를 적는다: 목소리 종류 바꾸기, 화면 색 보정 · 밝기 조절, 촬영본에 없는 장면 넣기(이유에 "촬영본 다시 올리기"로 새 촬영본을 올리면 된다고 안내한다), 캡션 고치기(캡션은 카드의 캡션 칸에서 바로 고친다).
- footage · cannot에 적은 요청은 계획에서 고치지 않는다. 그 요청 때문에 다른 칸을 바꾸지도 않는다.${fixedHook ? `
- 후킹은 사람이 정한 글 "${fixedHook}"로 고정돼 있다. 관리자가 후킹을 바꾸라고 하면 hook.on_screen을 고친다. 그러면 후킹 말과 1번 장면의 읽는 말도 같은 글이 된다. 후킹 말만 따로 바꿔 달라는 요청은 cannot에 적는다.` : `
- 관리자가 후킹 글자를 따옴표로 정하면 그 글이 후킹 말과 1번 장면의 읽는 말로도 쓰인다.`}${fixedEnding ? `
- 마지막 장면의 읽는 말은 계정에 정해 둔 끝 문구 "${fixedEnding}"로 고정돼 있다. 마지막 말을 바꾸라는 요청은 cannot에 적는다.` : ""}

따옴표 규칙:
- 고칠 내용에서 따옴표(" " “ ” ' ' 「 」)로 적은 글자는 다듬지 않고 글자 그대로 넣는다. 맞춤법 · 띄어쓰기 · 문장부호도 고치지 않는다.
- 따옴표 글자가 아래 규칙에 어긋나도 그대로 넣고, notes에 어떤 규칙에 어긋나는지 경고를 남긴다.

사실 · 광고 문구 규칙 (따옴표로 적지 않은 글에 적용한다):
- 사실(숫자 · 성분 · 효과 · 구성 · 사용법)은 아래 상품 정보에만 근거한다. 없는 내용은 쓰지 않는다. uncertainties에 있는 것은 쓰지 않는다.
- 요청이 광고 문구 규칙에 어긋나거나 상품 정보에 근거가 없는 효능 · 사실을 넣으라는 것이면, 뜻을 살려 맞는 말로 고쳐 쓰고 무엇을 왜 고쳤는지 notes에 남긴다. 상품 정보에 근거가 전혀 없어 맞는 말로 고쳐 쓸 수 없으면 넣지 않고 cannot에 요청과 이유를 적는다.
- 건강기능식품 기능성 표현은 approvedClaims 문장 그대로만 쓴다. 비어 있으면 기능성 · 건강 효과를 쓰지 않는다.${f.kind === "COSMETIC" ? "\n- 화장품: 치료 · 재생 · 염증 같은 표현을 쓰지 않고, 효과를 단정하지 않는다. 미백 · 주름 개선 · 자외선 차단은 certifiedFunctions에 있는 것만 쓴다." : ""}
- 체험담처럼 들리는 말("써 봤는데", "제가 해 보니")을 지어내지 않는다. 최고 · 유일 · 100% 같은 단정을 쓰지 않는다.
- 재고 · 품절 · 배송은 쓰지 않는다. 특가 · 할인 · 금액은 관리자가 고칠 내용에 적은 표현과 숫자 그대로만 쓰고, 적지 않은 할인율 · 금액 · 기간 · "오늘만" 같은 조건은 만들지 않는다.${banned.length ? `
금지 표현 (REGEX는 정규식이다):
${banned.map((r) => `- ${r.matchType === "REGEX" ? "REGEX " : ""}${r.phrase}${r.reason ? ` — ${r.reason}` : ""}${r.suggestion ? ` → ${r.suggestion}` : ""}`).join("\n")}` : ""}

글쓰기 기준:
- 영상에 들어가는 글(읽는 말 · 자막 · 그래픽 글자)은 지금 계획의 말투를 따른다.
- footage · cannot · notes는 관리자가 화면에서 읽는 글이다. 해요체로 짧게 쓴다. 비트 · tts · look 같은 내부 용어와 칸 이름을 쓰지 않고 장면 · 읽는 말 · 자막 · 화면 문구 · 효과음 · 컷이라고 쓴다.
- 숫자와 데이터를 설명할 때 구어를 쓰지 않는다: 세요 → 집계해요, (AI가 이미지 · 영상을) 읽어요 → 분석해요, (AI가 설정을) 읽어요 → 참고해요, 터졌다 → 성과가 높다, 뺐어요(집계 범위) → 제외했어요, 쌓여요 → 누적돼요, 돌아요 → 실행돼요, 규칙에 걸려요 → 규칙에 어긋나요.
- notes에는 요청한 말을 고쳐 쓴 이유와 사실 · 광고 문구 규칙 경고만 쓴다. 관리자가 정한 글이 아래 후킹 · 표지 · 자막 규칙(길이 · 구성)에 맞지 않는다는 평가는 쓰지 않는다.

아래 후킹 · 표지 · 자막 · 음성 · 그래픽 · 효과음 규칙은 네가 새로 쓰는 글과 새로 넣는 항목의 기준이다. 관리자의 요청이 이 규칙과 다르면 요청을 따른다(사실 · 광고 문구 규칙은 요청보다 먼저다).

후킹 규칙:
${bullets(kit.hook_rules)}

표지 규칙:
${bullets(kit.thumbnail_rules)}

자막 규칙:
${bullets(kit.caption_rules)}

음성 규칙:
${bullets(kit.tts_rules)}

그래픽 틀 (이것만 쓴다. 쓰지 않는 칸은 빈 문자열, 숫자는 0):
${JSON.stringify(kit.graphics)}
${bullets(kit.graphics_rules)}

효과음 (이것만 쓴다):
${JSON.stringify(Object.fromEntries(Object.entries(kit.sfx).map(([k, v]) => [k, v.use])))}
${bullets(kit.sfx_rules)}

음악 검색이 안 될 때 쓸 곡(look.music):
${JSON.stringify(kit.music_library.map((m) => ({ file: m.file, mood: m.mood })))}

상품 정보:
${JSON.stringify(facts)}${conceptBlock("이 계정의 말투 · 분위기", ctx.tone, "새로 쓰는 말과 글의 말투를 이것에 맞춘다.")}`;
}

/** 에이전트에게 보내는 지시문과 요청 글. */
export function revisionPrompt(ctx: EditReviseContext): { system: string; user: string } {
  return { system: systemPrompt(ctx), user: `지금 편집 계획:\n${planView(ctx.plan)}\n\n고칠 내용:\n"""\n${ctx.request.trim()}\n"""` };
}

/** 고칠 내용을 저장된 계획의 "바꿀 곳"으로 옮긴다. 스킬 호출 없이 한 번에 답한다(앱에서 실행, Vercel 함수 60초 제한). */
export async function writeEditRevision(ctx: EditReviseContext): Promise<AgentResult<EditRevision>> {
  return runAgent({
    agent: "edit",
    ...revisionPrompt(ctx),
    skills: [],
    outputSchema: editRevisionSchema,
    outputName: "edit_revision",
    maxSteps: 1,
    service: ctx.service,
    readService: ctx.readService,
    planId: ctx.planId ?? null,
    input: { product: ctx.facts.name, revise: ctx.request },
  });
}

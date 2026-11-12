import { z } from "zod";
import { loadEngineManifest, manifestPropNames, styleNotes, type EngineManifest } from "./catalog";
import { productCharacter, productionProblems, productionSchema, type AccountContext, type AiUsage, type CharacterSpec, type Production, type ProductionChoice, type Scene, type VoiceLine } from "./contract";
import { accountBlock, assertAccountLibrary, CLAIM_RULES, factsBlock, lemoParse } from "./select";
import type { AccountProfile } from "./characters";
import { allowedScreenTexts, boardScreenLines, isBoardText, type BoardBrief } from "./board-brief";
import type { ProductFacts } from "@/lib/agents/product-facts";
import { ZONE_BOX, ZONE_FRAME_HEIGHT } from "@/lib/shoot/video-kit/caption-style";
import type OpenAI from "openai";

// 장면 연출 — 영상마다 새로 설계한 production.json(contract.ts productionSchema)을 만든다.
// 시각은 AI에게 맡기지 않는다: 어떤 음성 줄을 한 장면으로 묶을지만 AI가 정하고, 장면 시작 · 끝은 확정된 음성(VoiceLine)에서 코드가 계산한다.
// 장면 안의 시각(표정 바뀜 · 등장 · 퇴장 · 효과 · 효과음)도 AI는 장면 길이 대비 비율(0~1)로 쓰고 코드가 초로 바꾼다.
//   expr_at · enter_at · exit_at · fx[].t는 장면 시작 기준 초, sfx[].t는 영상 기준 초다.
// 결과는 productionSchema.parse + productionProblems + 이 파일의 추가 검사로 보고, 문제를 되먹여 최대 2번 다시 쓴다. 남은 문제는 그대로 돌려준다.

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** 기존 편집 키트 효과음(ig-edit-ko kit.json sfx)만. */
export const LEMO_SFX = ["pop", "click", "rustle", "whoosh", "plug", "tick", "ding"] as const;
const CONTRACT_TRANSITIONS = ["cut", "fade", "wipe", "page-turn", "match"] as const;

// 장면 경계: 다음 줄 음성보다 조금 먼저 그림을 바꾸고, 마지막 줄 뒤에는 여유를 둔다
const LEAD = 0.15;
const TAIL = 0.6;
// 모션 자막 자리(화면 높이 비율) — 이 안에 얼굴 · 몸 · 소품을 두지 않는다.
// 수치는 실제 자막이 놓이는 편집 키트의 자리(caption-style.ts ZONE_BOX)에서 가져온다. 여기서 따로 정하지 않는다
const zoneSpan = (place: "top" | "lower"): [number, number] => [ZONE_BOX[place].top / ZONE_FRAME_HEIGHT, (ZONE_BOX[place].top + ZONE_BOX[place].height) / ZONE_FRAME_HEIGHT];
export const CAPTION_ZONE: Record<"top" | "lower", [number, number]> = { top: zoneSpan("top"), lower: zoneSpan("lower") };
// 자막 자리 높이 가운데 이 비율 넘게 몸 · 소품이 들어오면 겹친 것으로 본다. 글자는 자리 가운데에 놓여 가장자리는 조금 닿아도 된다
const ZONE_OVERLAP = 0.2;
// 화면 글자 소품(엔진 props.js word). 장면표가 정한 글자만 쓴다
const WORD_PROP = "word";
// 소품의 세로 반 크기 어림(1080 폭 기준 px, scale 1). 엔진 manifest에 크기가 없어 공용 소품(양동이 · 구름)과 글자 높이로 잡는다
const PROP_HALF = 75;
const WORD_HALF = 35;

/** 화면 세로 구간 a~b가 자막 자리를 얼마나 차지하는지(자리 높이 대비 0~1). */
function zoneShare(a: number, b: number, zone: [number, number]): number {
  return Math.max(0, Math.min(Math.max(a, b), zone[1]) - Math.max(Math.min(a, b), zone[0])) / (zone[1] - zone[0]);
}

/** 소품 state '글자' 또는 '글자@초'에서 글자와 시각을 나눈다(엔진 geom.js parseState와 같은 규칙). */
function wordState(state: string | null): { text: string; at: number | null } {
  const raw = (state ?? "").trim();
  const i = raw.lastIndexOf("@");
  const at = i >= 0 ? Number.parseFloat(raw.slice(i + 1)) : Number.NaN;
  return Number.isFinite(at) ? { text: raw.slice(0, i).trim(), at } : { text: raw, at: null };
}

/** 엔진 manifest의 소품 층(bg · obj · fx). 계정 소품처럼 적혀 있지 않은 것은 없다. */
function propLayers(manifest: EngineManifest): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of manifest.props) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const name = o.kind ?? o.name ?? o.id;
    if (typeof name === "string" && typeof o.layer === "string") out.set(name, o.layer);
  }
  return out;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r2 = (n: number) => Math.round(n * 100) / 100;

function enumOrString(values: string[], emptyNote: string) {
  const uniq = [...new Set(values)];
  return uniq.length ? z.enum(uniq as [string, ...string[]]) : z.string().describe(emptyNote);
}

function aiSchema(characters: CharacterSpec[], styleEntry: EngineManifest["styles"][string], props: string[]) {
  const point = z.object({ x: z.number(), y: z.number() });
  const camKey = z.object({ x: z.number(), y: z.number(), zoom: z.number(), rot: z.number() });
  const place = z.object({ x: z.number().describe("발 x 0~1"), y: z.number().describe("발 y 0~1"), scale: z.number(), facing: z.enum(["left", "right", "front"]) });
  const exprs = [...new Set(characters.flatMap((c) => c.expressions))];
  const acts = [...new Set(["idle", ...characters.flatMap((c) => c.actions)])];
  const transitions = CONTRACT_TRANSITIONS.filter((t) => t === "cut" || styleEntry.transitions.includes(t));
  return z.object({
    design: z.string().describe("연출 설계 요약: 등장인물과 역할, 감정 변화, 꺾이는 지점, 대표 장면(스타일 고유 동작), 처음 3초 후킹, 끝 장면"),
    cast: z.array(z.object({ id: z.string().describe("배역 id(영문 소문자)"), character: z.enum(characters.map((c) => c.id) as [string, ...string[]]), role: z.string() })),
    backgrounds: z.array(
      z.object({
        id: z.string(),
        kind: enumOrString(styleEntry.backgrounds.map((b) => b.kind), "배경 모듈 목록이 비어 있음"),
        params: z.array(z.object({ key: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) })),
      }),
    ),
    scenes: z.array(
      z.object({
        from_beat: z.number().int().describe("이 장면이 맡는 첫 음성 줄 번호"),
        to_beat: z.number().int().describe("이 장면이 맡는 마지막 음성 줄 번호(한 줄이면 from_beat와 같다)"),
        purpose: z.string().describe("이 장면이 이야기에서 하는 일: 목적 · 행동 · 상대에 대한 반응"),
        background: z.string().describe("backgrounds[].id"),
        camera: z.object({ from: camKey, to: camKey, ease: z.enum(["linear", "in", "out", "inout"]) }),
        actors: z.array(
          z.object({
            cast: z.string().describe("cast[].id"),
            from: place,
            to: place.nullable(),
            expr: z.enum(exprs as [string, ...string[]]),
            expr_to: z.enum(exprs as [string, ...string[]]).nullable(),
            expr_at: z.number().nullable().describe("expr_to로 바뀌는 때. 장면 길이 대비 0~1"),
            action: z.enum(acts as [string, ...string[]]),
            look_cast: z.string().nullable().describe("바라보는 배역 id, 없으면 null"),
            look_point: point.nullable().describe("바라보는 화면 좌표, 없으면 null"),
            enter_at: z.number().nullable().describe("장면 중간 등장 때(0~1), 처음부터 있으면 null"),
            exit_at: z.number().nullable().describe("장면 중간 퇴장 때(0~1), 끝까지 있으면 null"),
          }),
        ),
        props: z.array(z.object({ kind: enumOrString(props, "소품 목록이 비어 있음 — 빈 배열로"), at: point, scale: z.number(), state: z.string().nullable() })),
        fx: z.array(z.object({ kind: enumOrString(styleEntry.fx, "효과 목록이 비어 있음 — 빈 배열로"), at_frac: z.number().describe("장면 길이 대비 0~1"), at: point.nullable() })),
        transition_in: z.enum(transitions as [string, ...string[]]),
        caption_place: z.enum(["top", "lower"]),
        sfx: z.array(z.object({ name: z.enum(LEMO_SFX), at_frac: z.number().describe("장면 길이 대비 0~1") })),
      }),
    ),
  });
}
type AiProduction = z.infer<ReturnType<typeof aiSchema>>;

/** 음성 줄 묶음 → 장면 시작 · 끝. 첫 장면 0초, 장면 사이 빈틈 없음, 마지막 = 마지막 줄 끝 + 여유. */
function sceneTimes(voice: VoiceLine[], groups: { from: number; to: number }[]): { start: number; end: number }[] {
  const idx = new Map(voice.map((v, i) => [v.beat, i]));
  const bounds = groups.map((g, k) => {
    if (k === 0) return 0;
    const i = idx.get(g.from)!;
    const line = voice[i];
    const prev = voice[i - 1];
    return r3(Math.min(line.start, Math.max(prev.end, line.start - LEAD)));
  });
  const last = voice[voice.length - 1];
  const end = r3(last.end + TAIL);
  return groups.map((_, k) => ({ start: bounds[k], end: k + 1 < bounds.length ? bounds[k + 1] : end }));
}

function coverageProblems(voice: VoiceLine[], scenes: AiProduction["scenes"]): string[] {
  const out: string[] = [];
  const beats = voice.map((v) => v.beat);
  const pos = new Map(beats.map((b, i) => [b, i]));
  let next = 0;
  scenes.forEach((s, k) => {
    const a = pos.get(s.from_beat);
    const b = pos.get(s.to_beat);
    if (a === undefined || b === undefined) {
      out.push(`장면 ${k + 1}: 없는 음성 줄 번호(${s.from_beat}~${s.to_beat})`);
      return;
    }
    if (b < a) out.push(`장면 ${k + 1}: to_beat가 from_beat보다 앞이에요`);
    if (a !== next) out.push(`장면 ${k + 1}: ${beats[next] ?? "끝"}번 줄부터 이어져야 하는데 ${s.from_beat}번에서 시작해요(빠지거나 겹친 줄)`);
    next = Math.max(next, b + 1);
  });
  if (next < beats.length) out.push(`${beats[next]}번 줄부터 끝까지 맡은 장면이 없어요`);
  return out;
}

const inRange = (n: number, lo: number, hi: number) => n >= lo && n <= hi;

function extraProblems(
  ai: AiProduction,
  p: Production,
  characters: CharacterSpec[],
  styleEntry: EngineManifest["styles"][string],
  props: string[],
  // layers: 소품 층(배경 층 소품은 자막 뒤에 있어도 된다). brief: 장면표(있으면 화면 글자를 장면표 글자로만 쓰는지 본다)
  opts: { layers: Map<string, string>; brief: BoardBrief | null },
): string[] {
  const out: string[] = [];
  const castIds = new Set<string>();
  for (const c of ai.cast) {
    if (castIds.has(c.id)) out.push(`배역 id ${c.id}가 두 번 있어요`);
    castIds.add(c.id);
  }
  const bgKinds = new Map(styleEntry.backgrounds.map((b) => [b.kind, b]));
  const bgIds = new Set<string>();
  for (const b of ai.backgrounds) {
    if (bgIds.has(b.id)) out.push(`배경 id ${b.id}가 두 번 있어요`);
    bgIds.add(b.id);
    const known = bgKinds.get(b.kind);
    if (!known) out.push(`배경 ${b.id}: ${b.kind}는 이 스타일 배경 모듈이 아니에요(${[...bgKinds.keys()].join(", ")})`);
    else {
      const keys = Object.keys(known.params ?? {});
      if (keys.length) for (const kv of b.params) if (!keys.includes(kv.key)) out.push(`배경 ${b.id}: ${kv.key}는 ${b.kind} 조절값이 아니에요(${keys.join(", ")})`);
    }
  }
  const charOf = new Map(p.cast.map((c) => [c.id, characters.find((x) => x.id === c.character)]));
  const fxSet = new Set(styleEntry.fx);
  const propSet = new Set(props);
  const sfxPer = p.sfx.length / Math.max(1, p.duration);
  if (sfxPer > 0.8) out.push(`효과음이 너무 많아요(${p.sfx.length}개 / ${p.duration.toFixed(1)}초). 보이는 움직임에만, 15초에 6~10개 안팎`);

  ai.scenes.forEach((s, k) => {
    const sc = p.scenes[k];
    if (!sc) return;
    const tag = sc.id;
    for (const c of [s.camera.from, s.camera.to]) if (!inRange(c.zoom, 0.5, 3) || !inRange(c.x, -0.5, 1.5) || !inRange(c.y, -0.5, 1.5)) out.push(`${tag}: 카메라 값이 범위 밖이에요(x,y −0.5~1.5, zoom 0.5~3)`);
    for (const f of s.fx) {
      if (!fxSet.has(f.kind)) out.push(`${tag}: 효과 ${f.kind}는 이 스타일이 모르는 효과예요`);
      if (!inRange(f.at_frac, 0, 1)) out.push(`${tag}: 효과 at_frac ${f.at_frac}가 0~1 밖이에요`);
    }
    const zone = CAPTION_ZONE[s.caption_place];
    const zoneText = `${s.caption_place}, 화면 y ${zone[0].toFixed(2)}~${zone[1].toFixed(2)}`;
    for (const pr of s.props) {
      if (!propSet.has(pr.kind)) out.push(`${tag}: 소품 ${pr.kind}는 엔진 · 캐릭터 소품 목록에 없어요`);
      const isWord = pr.kind === WORD_PROP;
      if (isWord && opts.brief) {
        // 화면 글자는 장면표가 그 장면에 정한 글자만 쓴다(점검을 통과한 글자다)
        const word = wordState(pr.state);
        const allowed = allowedScreenTexts(opts.brief, s.from_beat, s.to_beat);
        if (!word.text) out.push(`${tag}: word 소품에 쓸 글자(state)가 없어요`);
        else if (!isBoardText(word.text, allowed)) out.push(`${tag}: 화면 글자 "${word.text}"는 장면표가 이 장면에 정한 글자가 아니에요(쓸 수 있는 글자: ${allowed.length ? allowed.map((t) => `"${t}"`).join(" · ") : "없음 — word 소품을 빼요"})`);
        if (word.at !== null && word.at >= sc.end - sc.start) out.push(`${tag}: 화면 글자 "${word.text}"가 나오는 시각(${word.at}초)이 장면 길이(${(sc.end - sc.start).toFixed(1)}초)를 넘어요`);
      }
      // 소품이 자막 자리에 들어가는지 — 해 · 구름 같은 배경 층 · 효과 층 소품은 자막 뒤에 있어도 되고, 화면 글자와 물건은 안 된다
      const layer = opts.layers.get(pr.kind) ?? "obj";
      if (!isWord && (layer === "bg" || layer === "fx")) continue;
      const half = ((isWord ? WORD_HALF : PROP_HALF) * pr.scale * (p.size.w / 1080)) / p.size.h;
      for (const cam of [s.camera.from, s.camera.to]) {
        const sy = (pr.at.y - cam.y) * cam.zoom + 0.5;
        const sx = (pr.at.x - cam.x) * cam.zoom + 0.5;
        if (sx < -0.1 || sx > 1.1) continue;
        if ((sy >= zone[0] && sy <= zone[1]) || zoneShare(sy - half * cam.zoom, sy + half * cam.zoom, zone) > ZONE_OVERLAP) {
          out.push(`${tag}: ${isWord ? `화면 글자 "${wordState(pr.state).text}"` : `소품 ${pr.kind}`}(화면 y ${sy.toFixed(2)})가 자막 자리(${zoneText})에 들어가요. 자리 밖으로 옮기거나 caption_place를 바꿔요`);
          break;
        }
      }
    }
    for (const x of s.sfx) if (!inRange(x.at_frac, 0, 1)) out.push(`${tag}: 효과음 at_frac ${x.at_frac}가 0~1 밖이에요`);
    for (const a of s.actors) {
      for (const v of [a.expr_at, a.enter_at, a.exit_at]) if (v !== null && !inRange(v, 0, 1)) out.push(`${tag}: ${a.cast}의 시각 비율 ${v}가 0~1 밖이에요`);
      if (a.expr_to && a.expr_at === null) out.push(`${tag}: ${a.cast}는 expr_to가 있는데 expr_at이 없어요`);
      if (a.look_cast && !castIds.has(a.look_cast)) out.push(`${tag}: ${a.cast}가 보는 ${a.look_cast}는 배역이 아니에요`);
      for (const pl of [a.from, a.to]) if (pl && (!inRange(pl.scale, 0.2, 3) || !inRange(pl.x, -0.3, 1.3) || !inRange(pl.y, -0.3, 1.5))) out.push(`${tag}: ${a.cast} 위치 · 크기가 범위 밖이에요`);
      // 얼굴 · 몸이 자막 자리에 들어가는지 — 카메라 시작 · 끝 두 시점에서 화면 좌표로 본다
      const spec = charOf.get(a.cast);
      if (!spec) continue;
      const checks: [typeof a.from, typeof s.camera.from][] = [
        [a.from, s.camera.from],
        [a.to ?? a.from, s.camera.to],
      ];
      for (const [pl, cam] of checks) {
        const hFrac = (spec.body.height * pl.scale * (p.size.w / 1080)) / p.size.h;
        const screenY = (y: number) => (y - cam.y) * cam.zoom + 0.5;
        const sy = screenY(pl.y - hFrac * (1 - spec.body.head_ratio / 2));
        const sx = (pl.x - cam.x) * cam.zoom + 0.5;
        if (sy >= zone[0] && sy <= zone[1]) {
          out.push(`${tag}: ${a.cast} 얼굴(화면 y ${sy.toFixed(2)})이 자막 자리(${zoneText})에 들어가요. 반대쪽으로 옮기거나 caption_place를 바꿔요`);
          break;
        }
        // 몸(머리 끝 ~ 발). 자막은 가로를 거의 다 쓰므로 가로로 화면 안에 있으면 세로 겹침만 본다
        const head = screenY(pl.y - hFrac);
        const feet = screenY(pl.y);
        const share = zoneShare(head, feet, zone);
        if (sx > -0.1 && sx < 1.1 && share > ZONE_OVERLAP) {
          out.push(`${tag}: ${a.cast} 몸(화면 y ${head.toFixed(2)}~${feet.toFixed(2)})이 자막 자리(${zoneText})를 ${Math.round(share * 100)}% 가려요. 캐릭터 위치 · 크기나 카메라를 바꿔 자리 밖에 두거나 caption_place를 반대쪽으로 바꿔요`);
          break;
        }
        if (a.enter_at === null && a.exit_at === null && (sy < 0 || sy > 1 || sx < 0 || sx > 1)) {
          out.push(`${tag}: ${a.cast} 얼굴이 화면 밖(x ${sx.toFixed(2)}, y ${sy.toFixed(2)})이에요`);
          break;
        }
      }
    }
  });
  return out;
}

function buildProduction(
  ai: AiProduction,
  ctx: { voice: VoiceLine[]; choice: ProductionChoice; account: AccountContext; profile: AccountProfile; size: { w: number; h: number }; fps: number; style: string },
): Production {
  const times = sceneTimes(ctx.voice, ai.scenes.map((s) => ({ from: s.from_beat, to: s.to_beat })));
  const sfx: Production["sfx"] = [];
  const scenes: Scene[] = ai.scenes.map((s, k) => {
    const { start, end } = times[k];
    const d = end - start;
    const sec = (f: number | null) => (f === null ? null : r2(f * d));
    for (const x of s.sfx) sfx.push({ t: r3(start + x.at_frac * d), name: x.name });
    return {
      id: `s${String(k + 1).padStart(2, "0")}`,
      beat: s.from_beat,
      start,
      end,
      purpose: s.purpose,
      background: s.background,
      camera: s.camera,
      actors: s.actors.map((a) => ({
        cast: a.cast,
        from: a.from,
        to: a.to,
        expr: a.expr,
        expr_to: a.expr_to,
        expr_at: sec(a.expr_at),
        action: a.action,
        look: a.look_cast ?? a.look_point ?? null,
        enter_at: sec(a.enter_at),
        exit_at: sec(a.exit_at),
      })),
      props: s.props,
      fx: s.fx.map((f) => ({ kind: f.kind, t: r2(f.at_frac * d), at: f.at })),
      transition_in: s.transition_in as Scene["transition_in"],
      caption_place: s.caption_place,
    };
  });
  const duration = scenes.length ? scenes[scenes.length - 1].end : 0;
  return productionSchema.parse({
    version: 1,
    size: ctx.size,
    fps: ctx.fps,
    duration,
    account_key: ctx.account.accountKey,
    series: ctx.profile.series,
    style: { slug: ctx.style, params: ctx.profile.styleParams[ctx.style] ?? {} },
    brand: ctx.profile.brand,
    cast: ai.cast,
    backgrounds: ai.backgrounds.map((b) => ({ id: b.id, kind: b.kind, params: Object.fromEntries(b.params.map((kv) => [kv.key, kv.value])) })),
    scenes,
    sfx: sfx.sort((a, b) => a.t - b.t),
  });
}

// board: 장면표가 정한 화면을 받았는지. 받았으면 그 화면을 따르는 법과 화면 글자(word 소품) 쓰는 법을 넣는다
function systemPrompt(style: string, styleEntry: EngineManifest["styles"][string], props: string[], characters: CharacterSpec[], size: { w: number; h: number }, board: boolean): string {
  const pct = (z: [number, number]) => `${Math.round(z[0] * 100)}~${Math.round(z[1] * 100)}%`;
  const canWrite = board && props.includes(WORD_PROP);
  const textRule = canWrite
    ? `- 나레이션 자막과 첫 장면의 후킹 큰 글자는 편집 키트가 얹으니 화면에 그리지 않는다. 화면 글자는 아래 "장면표가 정한 화면"에 화면 글자 · 끝 화면이 적힌 줄의 장면에서만, 거기 적힌 글자만 ${WORD_PROP} 소품으로 쓴다. state에 쓸 글자를 넣고("글자@초"로 쓰면 장면 시작 그 초부터 한 글자씩 써진다. 초는 그 장면 길이보다 짧아야 한다), at은 글자 가운데 위치, scale 1이면 한 글자 높이가 화면 폭의 약 5%다. 소품 하나에 10자 이내로 쓰고 길면 나눈다. 말의 문장을 글자로 옮기지 않는다.`
    : "- 화면에 글자를 그리지 않는다(나레이션 자막은 편집 키트가 얹는다).";
  const boardRules = board
    ? `

장면표를 따르는 법(아래 "장면표가 정한 화면"):
- 장면표는 이 영상의 말과 화면을 함께 정한 계획이다. 줄마다 적힌 "보이는 것"과 설명 화면 · 그래픽의 내용을, 그 줄을 맡은 장면이 보여 줘야 한다. 캐릭터가 가만히 서 있기만 하는 장면으로 바꾸지 않는다.
- 장면표는 사진 · 스톡 영상 · 코드 도식 기준으로 쓰였다. 사진이나 영상 자체를 흉내 내지 말고, 그 화면이 전하려는 내용(무엇을 보여 주는지, 무엇과 무엇이 다른지, 어떤 순서 · 숫자인지)을 캐릭터의 행동 · 소품 · 배치 · 카메라로 옮긴다.
- 제품 사진 · 자사 촬영 · 움직이는 이미지 줄은 상품이 화면에 보여야 한다. 배역에 상품을 그린 캐릭터가 있으면 그 캐릭터를 그 장면에 세운다.
- 비교 화면 · 둘 비교 그래픽: 두 쪽을 화면 좌우로 나눠 서로 다른 행동으로 보여 주고${canWrite ? ", 각 쪽의 이름 · 값을 그 쪽 가까이에 화면 글자로 쓴다" : ""}.
- 순서 · 목록 화면: 항목이 말에 맞춰 하나씩 나타나게 한다.${canWrite ? " 숫자 화면 · 큰 글자 화면: 그 숫자 · 낱말을 화면 글자로 크게 쓴다." : ""}
- 끝 화면: 마지막 줄의 장면은 처음 장면과 이어지게 마무리한다.${canWrite ? " 끝 화면 문구가 있으면 화면 글자로 보여 준다." : ""}`
    : "";
  const charLines = characters
    .map((c) => {
      const hFrac = (c.body.height * (size.w / 1080)) / size.h;
      return `- ${c.id} "${c.name}" (${c.body.shape}): ${c.description}\n  scale 1일 때 키 = 화면 높이의 ${hFrac.toFixed(2)}, 머리 : 키 ${c.body.head_ratio}\n  표정: ${c.expressions.join(", ")}\n  동작: idle, ${c.actions.join(", ")}${c.props.length ? `\n  소품: ${c.props.join(", ")}` : ""}`;
    })
    .join("\n");
  return `너는 인스타 릴스(세로 ${size.w}×${size.h}) 코드 애니메이션 연출가다. 확정된 음성 대본에 맞춰 이 영상만의 장면 계획을 새로 설계한다. 다른 영상의 구성을 되풀이하지 않는다.

먼저 design에 설계를 쓴다: 등장인물과 역할, 감정 변화, 꺾이는 지점, 처음 3초 후킹 장면, 스타일 고유 동작을 쓸 대표 장면 하나(감정이 가장 높은 곳), 처음과 이어지는 끝 장면.
그다음 scenes를 쓴다:
- 음성 줄을 순서대로 빠짐없이 장면에 나눈다. from_beat~to_beat로 이어지는 줄을 한 장면에 묶을 수 있다. 장면 시각은 코드가 음성에서 계산하니 쓰지 않는다. 장면 안의 때는 장면 길이 대비 0~1 비율로만 쓴다.
- 이야기형이면 장면마다 누가 무엇을 원하고(목적), 무엇을 하고(행동), 상대에게 어떻게 반응하는지가 보이게 한다. 감정은 expr → expr_to로 바뀌게 하고, 표정이 바뀌기 전 준비 동작 · 동작 · 여운이 이어지게 한다. 같은 포즈로 미끄러지듯 이동만 하지 않는다.
- 설명형이면 한 장면에 한 생각만 보여 주고, 캐릭터는 그 생각을 몸으로 보여 주는 역할을 한다.
- 카메라는 영상 전체에서 네 가지 이상 움직임(밀어 들어가기 · 빠지기 · 팬 · 틸트 · 따라가기 · 고정)을 쓰고, 움직일 때마다 이유가 있어야 한다. 빠른 구간과 숨 돌리는 구간을 섞는다.
- 중요한 순간에는 주인공이 화면 높이의 3분의 1 이상이 되게 크게 잡는다. 화면 가장자리에 붙이지 않는다. 같은 색 위에 같은 색을 두지 않는다.
- 배역 계획에 [상품 배역]으로 표시된 캐릭터가 있으면, 상품을 소개하거나 상품 이름 · 특징 · 쓰는 법을 말하는 줄의 장면에 그 캐릭터를 세운다. 상품을 다른 소품(양동이 등)으로 대신 보여 주지 않는다.
- caption_place는 그 장면에 모션 자막(첫 장면은 후킹 큰 글자도)이 들어갈 자리다. 자막 자리(화면 위에서부터 높이 기준): top = ${pct(CAPTION_ZONE.top)}, lower = ${pct(CAPTION_ZONE.lower)} 구간이고, 자막은 화면 가로를 거의 다 쓴다. 그 장면의 캐릭터 얼굴 · 몸 · 물건 소품 · 화면 글자는 이 띠 밖에 둔다(해 · 구름 같은 배경 소품은 띠 안에 있어도 된다). 캐릭터가 바닥에 서 있으면 보통 top이 맞고, lower는 캐릭터와 소품이 그 띠보다 위에 있을 때 쓴다. 띠를 피할 수 없으면 카메라나 캐릭터 크기 · 위치를 바꾼다. 후킹 큰 글자는 첫 줄이 끝날 때까지(2초 안팎) 첫 장면의 자리에 떠 있다.
- 좌표: 위치는 0~1 페이지 좌표(가로 · 세로), 캐릭터 위치는 발 기준이다. 화면 좌표 = (위치 − 카메라 중심) × zoom + 0.5. 얼굴 높이 ≈ 발 y − 키 × (1 − 머리비율 / 2), 머리 끝 ≈ 발 y − 키. 화면에서 키는 zoom만큼 커진다.
- 표정 · 동작은 그 캐릭터 목록에 있는 것만 쓴다. 배경 kind · 효과 · 전환 · 소품도 아래 목록에 있는 것만 쓴다.
- sfx는 보이는 움직임(등장 · 착지 · 뚜껑 · 넘김 · 답이 나오는 순간)에만 맞춘다. 장면마다 넣지 않는다. 15초에 6~10개 안팎.
${textRule}
- purpose에는 그 장면이 이야기에서 하는 일만 쓴다. 표현 기준을 지켰다는 메모는 쓰지 않는다(지키기만 한다).${boardRules}

이 영상의 스타일(${style}):
${styleNotes(style, 2000)}

엔진이 아는 것:
- 배경 모듈: ${JSON.stringify(styleEntry.backgrounds).slice(0, 2000)}
- 효과(fx): ${styleEntry.fx.join(", ") || "없음 — fx는 빈 배열"}
- 전환: ${["cut", ...styleEntry.transitions.filter((t) => t !== "cut")].join(", ")} (계약에 있는 cut · fade · wipe · page-turn · match 중에서만)
- 소품: ${props.join(", ") || "없음 — props는 빈 배열"}
- 효과음: ${LEMO_SFX.join(", ")}

캐릭터(이 계정 것만):
${charLines}

${CLAIM_RULES}
- 상품 자료에 없는 효능을 그림 · 행동으로 주장하지 않는다(예: 근거 없이 피부가 '치료'되는 장면).`;
}

/** 장면 데이터의 화면 글자(word 소품)와 그 장면이 시작하는 음성 줄 번호. 완성본 글자 점검에 쓴다. */
export function screenWords(p: Production): { beat: number; text: string }[] {
  return p.scenes.flatMap((s) => s.props.filter((pr) => pr.kind === WORD_PROP).map((pr) => ({ beat: s.beat, text: wordState(pr.state).text }))).filter((w) => w.text);
}

/** 장면표가 그 장면에 정한 글자가 아닌 화면 글자를 뺀다. */
function dropForeignWords(p: Production, brief: BoardBrief): { production: Production; dropped: string[] } {
  const dropped: string[] = [];
  const scenes = p.scenes.map((s, k) => {
    const to = k + 1 < p.scenes.length ? p.scenes[k + 1].beat - 1 : brief.scenes.length - 1;
    const allowed = allowedScreenTexts(brief, s.beat, Math.max(s.beat, to));
    const props = s.props.filter((pr) => {
      if (pr.kind !== WORD_PROP) return true;
      const text = wordState(pr.state).text;
      const ok = !!text && isBoardText(text, allowed);
      if (!ok) dropped.push(`${s.id}: 장면표에 없는 화면 글자 "${text}"를 뺐어요`);
      return ok;
    });
    return props.length === s.props.length ? s : { ...s, props };
  });
  return { production: dropped.length ? { ...p, scenes } : p, dropped };
}

/**
 * 장면 계획을 쓴다. 시각은 voice에서 코드가 채우고, AI는 장면 내용만 쓴다.
 * 문제가 있으면 문제 목록을 되먹여 최대 2번 다시 쓰고, 문제가 가장 적은 결과와 남은 문제를 돌려준다.
 */
export async function directProduction(input: {
  choice: ProductionChoice;
  account: AccountContext;
  profile: AccountProfile;
  characters: CharacterSpec[];
  voice: VoiceLine[];
  script: string[];
  facts: ProductFacts | null;
  // 장면표에서 추린 화면 지시(board-brief.ts). 있으면 장면표가 정한 화면 · 화면 글자 · 끝 화면을 따른다. 없으면(수동 대본 실행) 음성 줄만 보고 짠다
  brief?: BoardBrief | null;
  size?: { w: number; h: number };
  fps?: number;
}): Promise<{ production: Production; usage: AiUsage[]; attempts: number; problems: string[] }> {
  const { choice, account, profile, characters } = input;
  if (choice.backend !== "lemo-code" || !choice.style) throw new Error("directProduction: lemo-code 선택(스타일 포함)만 장면 계획을 써요");
  assertAccountLibrary(account.accountKey, characters, "directProduction");
  if (!characters.length) throw new Error("directProduction: 캐릭터가 없어요(prepareCharacters 결과를 넘겨야 해요)");
  if (!input.voice.length) throw new Error("directProduction: 확정된 음성 줄이 없어요");
  const voice = [...input.voice].sort((a, b) => a.start - b.start);
  if (new Set(voice.map((v) => v.beat)).size !== voice.length) throw new Error("directProduction: 음성 줄 번호(beat)가 겹쳐요");

  const style = choice.style;
  const manifest = loadEngineManifest();
  const styleEntry = manifest.styles[style];
  if (!styleEntry) throw new Error(`directProduction: 엔진 manifest에 ${style} 스타일 모듈이 없어요(있는 것: ${Object.keys(manifest.styles).join(", ")})`);
  const props = [...new Set([...manifestPropNames(manifest), ...characters.flatMap((c) => c.props)])];
  const size = input.size ?? { w: 1080, h: 1920 };
  const fps = input.fps ?? 24;
  const schema = aiSchema(characters, styleEntry, props);
  const layers = propLayers(manifest);
  // 장면표의 장면 번호 = 음성 줄 번호여야 화면 지시를 줄에 붙일 수 있다. 어긋나면 장면표 없이 짠다
  let brief = input.brief ?? null;
  if (brief && (brief.scenes.length !== voice.length || voice.some((v, i) => v.beat !== i))) {
    console.warn(`[lemo] 장면표 ${brief.scenes.length}장면과 음성 ${voice.length}줄이 맞지 않아 장면표 화면 지시 없이 장면을 짜요`);
    brief = null;
  }

  // 상품 배역(select.ts withProductRole)이 어느 캐릭터인지 알려 준다 — 상품을 보여 줄 수단은 이 캐릭터뿐이다
  const product = productCharacter(choice, characters, input.facts?.id ?? null);
  const roleLines = choice.characters.map((c) => `- ${c.role}${c.product && product ? ` [상품 배역 = ${product.id}]` : ""}: ${c.reuse ?? "새로 만든 캐릭터"} — ${c.why}`).join("\n");
  const user = `${accountBlock(account)}

${factsBlock(input.facts)}

제작 방식 선택 이유: ${choice.reason}
배역 계획:
${roleLines}

확정된 음성(줄 번호 · 말하는 구간 · 문장):
${voice.map((v) => `${v.beat}. [${v.start.toFixed(2)}–${v.end.toFixed(2)}초, ${(v.end - v.start).toFixed(1)}초] ${v.text}`).join("\n")}
영상 길이: ${(voice[voice.length - 1].end + TAIL).toFixed(2)}초${input.script.length && input.script.length !== voice.length ? `\n(원래 대본 ${input.script.length}줄 — 음성 줄을 기준으로 한다)` : ""}${brief ? `\n\n장면표가 정한 화면(번호 = 음성 줄 번호):\n${boardScreenLines(brief)}` : ""}`;

  const messages: Message[] = [
    { role: "system", content: systemPrompt(style, styleEntry, props, characters, size, !!brief) },
    { role: "user", content: user },
  ];
  const usage: AiUsage[] = [];
  let best: { production: Production; problems: string[] } | null = null;
  let attempts = 0;
  for (; attempts < 3; ) {
    attempts++;
    const r = await lemoParse({ stage: "lemo.direct", schema, name: "production_plan", messages, maxTokens: 9000 });
    usage.push(r.usage);
    const ai = r.parsed;
    let problems = coverageProblems(voice, ai.scenes);
    let production: Production | null = null;
    if (!problems.length) {
      try {
        production = buildProduction(ai, { voice, choice, account, profile, size, fps, style });
        problems = [...productionProblems(production, characters, voice), ...extraProblems(ai, production, characters, styleEntry, props, { layers, brief })];
        // 상품 캐릭터가 한 장면에도 안 나오면 다시 쓰게 한다
        const shown = product ? new Set(production.cast.filter((c) => c.character === product.id).map((c) => c.id)) : null;
        if (product && shown && !production.scenes.some((s) => s.actors.some((a) => shown.has(a.cast)))) {
          problems.push(`상품 캐릭터 ${product.id}가 어느 장면에도 나오지 않아요. cast에 넣고, 상품을 소개하는 줄의 장면에 세워 주세요`);
        }
      } catch (e) {
        problems = [`계약 형식 검사 실패: ${e instanceof Error ? e.message.slice(0, 600) : String(e)}`];
      }
    }
    if (production && (!best || problems.length < best.problems.length)) best = { production, problems };
    if (production && !problems.length) break;
    if (attempts < 3) messages.push({ role: "assistant", content: r.content }, { role: "user", content: `검사에서 문제가 나왔어요. 설계 의도는 유지하고 문제만 고쳐서 전체를 다시 답해 주세요:\n${problems.map((p) => `- ${p}`).join("\n")}` });
    else if (!best) throw new Error(`directProduction: 세 번 모두 장면을 음성 줄에 맞추지 못했어요 — ${problems.join(" / ")}`);
  }
  if (!best) throw new Error("directProduction: 결과 없음");
  // 다시 써도 남은 장면표 밖 화면 글자는 그리지 않는다. 화면에 나가는 글자는 점검을 통과한 장면표 글자뿐이어야 한다
  const kept = brief ? dropForeignWords(best.production, brief) : { production: best.production, dropped: [] };
  for (const d of kept.dropped) console.warn(`[lemo] ${d}`);
  return { production: kept.production, usage, attempts, problems: best.problems };
}

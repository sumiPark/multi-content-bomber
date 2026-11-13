import { z } from "zod";
import type OpenAI from "openai";
import type { ProductFacts } from "@/lib/agents/product-facts";
import { boardScreenLines, type BoardBrief } from "./board-brief";
import { loadEngineManifest, styleNotes, type EngineManifest } from "./catalog";
import { productLookBlock, type AccountProfile } from "./characters";
import { productionProblems, productionSchema, type AccountContext, type AiUsage, type Production, type ProductionChoice, type VoiceLine } from "./contract";
import { buildProduction, CAPTION_ZONE, coverageProblems, dropForeignWords, extraProblems, LEMO_SFX, propLayers, TAIL, WORD_PROP, wordState, type AiProduction } from "./direct";
import { accountBlock, CLAIM_RULES, factsBlock, lemoParse } from "./select";

// 캐릭터 없이 설명하는 lemo 스타일(manifest의 characters: false — 픽토그램 모션 · 수채 붓)의 장면 계획.
// 캐릭터 영상(direct.ts)과 같은 파이프라인을 탄다: 확정된 음성 시각으로 코드가 장면 시작 · 끝을 계산하고(sceneTimes), 장면표의 화면 지시 · 화면 글자를 따르며,
// 같은 계약 검사(productionProblems) · 자막 자리 검사(extraProblems) · 장면표 밖 글자 빼기(dropForeignWords)를 쓴다. 결과는 같은 production.json이다(cast · actors는 비어 있다).
// 화면은 배우 대신 그 스타일 전용 소품으로 만든다: 상품(product) · 아이콘(icon) · 화살표(arrow) · 목록 점(bullet) · 화면 글자(word).
// 상품은 실제 사진을 쓰지 않고 상품 글 자료로 정한 용기 · 생김새 · 색(product_look → style.params product_*)으로 비슷한 결로 그린다. 글자 · 로고 없음(캐릭터 영상의 상품 배역과 같은 규칙).

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export const EXPLAIN_PRODUCT_SHAPES = ["bottle", "tube", "jar", "box", "pouch", "fruit", "blob"] as const;
export const EXPLAIN_FRUITS = ["apple", "citrus", "persimmon", "pear", "berry", "grape"] as const;
const ARROW_DIRS = ["right", "left", "up", "down"];
const CONTRACT_TRANSITIONS = ["cut", "fade", "wipe", "page-turn", "match"] as const;
const HEX = /^#[0-9a-f]{6}$/i;
type StyleEntry = EngineManifest["styles"][string];

/** 그 스타일이 캐릭터 없이 설명하는 스타일인지(엔진 manifest의 characters: false). */
export function isExplainStyle(m: EngineManifest, slug: string): boolean {
  return m.styles[slug]?.characters === false;
}

/** 스타일 전용 소품 이름(manifest styles[slug].props). */
export function stylePropNames(entry: StyleEntry): string[] {
  return (entry.props ?? []).flatMap((p) => {
    const o = p && typeof p === "object" ? (p as Record<string, unknown>) : null;
    return typeof o?.kind === "string" ? [o.kind] : [];
  });
}

/** 아이콘 이름 → 뜻(manifest icons, "_about" 제외). */
export function iconNames(m: EngineManifest): Record<string, string> {
  return Object.fromEntries(Object.entries(m.icons).filter(([k]) => !k.startsWith("_")));
}

function enumOf(values: string[]) {
  return z.enum([...new Set(values)] as [string, ...string[]]);
}

export function planSchema(entry: StyleEntry, props: string[]) {
  const point = z.object({ x: z.number(), y: z.number() });
  const camKey = z.object({ x: z.number(), y: z.number(), zoom: z.number(), rot: z.number() });
  const transitions = CONTRACT_TRANSITIONS.filter((t) => t === "cut" || entry.transitions.includes(t));
  return z.object({
    design: z.string().describe("설계 요약: 대본의 생각 흐름을 장면별로 어떤 그림 · 도형 · 글자로 보여 줄지, 처음 3초 후킹 화면, 상품이 나오는 장면, 끝 화면"),
    product_look: z
      .object({
        shape: z.enum(EXPLAIN_PRODUCT_SHAPES),
        fruit: z.enum(EXPLAIN_FRUITS).nullable().describe("shape=fruit일 때만, 아니면 null"),
        body: z.string().describe("몸 색 #rrggbb"),
        cap: z.string().describe("뚜껑 · 꼭지 · 잎 색 #rrggbb"),
        band: z.string().describe("글자 없는 띠 색 #rrggbb"),
        why: z.string().describe("이 모양 · 색으로 정한 근거(상품 자료의 어느 말인지, 없으면 '자료 없음 — 흔한 용기 · 브랜드 색')"),
      })
      .nullable()
      .describe("상품 자료가 있으면 그 상품을 그릴 모양 · 색, 없으면 null"),
    backgrounds: z.array(z.object({ id: z.string(), kind: enumOf(entry.backgrounds.map((b) => b.kind)), params: z.array(z.object({ key: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) })) })),
    scenes: z.array(
      z.object({
        from_beat: z.number().int().describe("이 장면이 맡는 첫 음성 줄 번호"),
        to_beat: z.number().int().describe("이 장면이 맡는 마지막 음성 줄 번호(한 줄이면 from_beat와 같다)"),
        purpose: z.string().describe("이 장면이 보여 주는 생각 하나"),
        background: z.string().describe("backgrounds[].id"),
        camera: z.object({ from: camKey, to: camKey, ease: z.enum(["linear", "in", "out", "inout"]) }),
        props: z.array(z.object({ kind: enumOf(props), at: point, scale: z.number(), state: z.string().nullable() })),
        fx: z.array(z.object({ kind: entry.fx.length ? enumOf(entry.fx) : z.string(), at_frac: z.number().describe("장면 길이 대비 0~1"), at: point.nullable() })),
        transition_in: enumOf(transitions),
        caption_place: z.enum(["top", "lower"]),
        sfx: z.array(z.object({ name: z.enum(LEMO_SFX), at_frac: z.number().describe("장면 길이 대비 0~1") })),
      }),
    ),
  });
}
export type ExplainPlan = z.infer<ReturnType<typeof planSchema>>;

/** 장면 계획을 캐릭터 영상과 같은 모양(cast · actors 빈 배열)으로 — direct.ts의 변환 · 검사를 그대로 쓰기 위해서다. */
function asAiProduction(plan: ExplainPlan): AiProduction {
  return {
    design: plan.design,
    cast: [],
    backgrounds: plan.backgrounds,
    scenes: plan.scenes.map((s) => ({ ...s, actors: [] })),
  };
}

function lookParams(look: ExplainPlan["product_look"]): Record<string, string> {
  if (!look) return {};
  return {
    product_shape: look.shape,
    ...(look.shape === "fruit" && look.fruit ? { product_fruit: look.fruit } : {}),
    ...(HEX.test(look.body) ? { product_body: look.body } : {}),
    ...(HEX.test(look.cap) ? { product_cap: look.cap } : {}),
    ...(HEX.test(look.band) ? { product_band: look.band } : {}),
  };
}

/** 장면 계획 → production.json. 시각은 음성에서 코드가 계산하고(direct.ts buildProduction), 상품 모양 · 색은 style.params에 넣는다. */
export function planToProduction(
  plan: ExplainPlan,
  ctx: { voice: VoiceLine[]; choice: ProductionChoice; account: AccountContext; profile: AccountProfile; size: { w: number; h: number }; fps: number; style: string },
): Production {
  const p = buildProduction(asAiProduction(plan), ctx);
  return productionSchema.parse({ ...p, style: { ...p.style, params: { ...p.style.params, ...lookParams(plan.product_look) } } });
}

/** 캐릭터 없는 장면 계획만의 검사(계약 · 자막 자리 검사는 direct.ts 것을 함께 쓴다). */
export function explainProblems(
  plan: ExplainPlan,
  p: Production,
  opts: { manifest: EngineManifest; entry: StyleEntry; props: string[]; voice: VoiceLine[]; brief: BoardBrief | null; facts: ProductFacts | null },
): string[] {
  const out = [...productionProblems(p, [], opts.voice), ...extraProblems(asAiProduction(plan), p, [], opts.entry, opts.props, { layers: propLayers(opts.manifest), brief: opts.brief })];
  const icons = iconNames(opts.manifest);
  let productShown = false;
  plan.scenes.forEach((s, k) => {
    const sc = p.scenes[k];
    if (!sc) return;
    const len = sc.end - sc.start;
    const tag = sc.id;
    if (!s.props.some((pr) => pr.kind !== WORD_PROP)) out.push(`${tag}: 그림(상품 · 아이콘 · 화살표 · 목록 점)이 하나도 없어요. 이 장면의 생각을 그림으로 보여 줘요`);
    for (const pr of s.props) {
      const { text: name, at } = wordState(pr.state);
      if (at !== null && (at < 0 || at >= len)) out.push(`${tag}: ${pr.kind} "${pr.state}"의 시각(${at}초)이 장면 길이(${len.toFixed(1)}초) 밖이에요`);
      if (!(pr.scale > 0.15 && pr.scale <= 4)) out.push(`${tag}: ${pr.kind} scale ${pr.scale}가 범위(0.15~4) 밖이에요`);
      if (pr.at.x < -0.1 || pr.at.x > 1.1 || pr.at.y < -0.1 || pr.at.y > 1.1) out.push(`${tag}: ${pr.kind} 위치(${pr.at.x}, ${pr.at.y})가 화면 밖이에요`);
      if (pr.kind === "icon" && !icons[name]) out.push(`${tag}: 아이콘 "${name}"은 없어요(${Object.keys(icons).join(", ")})`);
      if (pr.kind === "arrow" && !ARROW_DIRS.includes(name)) out.push(`${tag}: 화살표 방향 "${name}"은 ${ARROW_DIRS.join(" · ")} 중 하나여야 해요`);
      if ((pr.kind === "bullet" || pr.kind === "product") && name && !["on", "in"].includes(name)) out.push(`${tag}: ${pr.kind} state는 비우거나 "${pr.kind === "bullet" ? "on" : "in"}@초"로 써요("${pr.state}")`);
      if (pr.kind === "product") {
        if (!opts.facts) out.push(`${tag}: 상품 자료가 없는 영상이라 product 소품을 쓰지 않아요`);
        productShown = true;
      }
    }
  });
  if (opts.facts && !productShown) out.push(`상품(${opts.facts.name})이 어느 장면에도 나오지 않아요. 상품을 소개하는 줄의 장면에 product 소품을 크게 두어요`);
  const look = plan.product_look;
  if (opts.facts && !look) out.push("상품 자료가 있는데 product_look이 비어 있어요");
  if (look) {
    for (const [k, v] of [["body", look.body], ["cap", look.cap], ["band", look.band]] as const) if (!HEX.test(v)) out.push(`product_look.${k} "${v}"는 #rrggbb 색이 아니에요`);
    if (look.shape === "fruit" && !look.fruit) out.push("product_look.shape가 fruit인데 fruit 종류가 비어 있어요");
  }
  return out;
}

function systemPrompt(style: string, entry: StyleEntry, props: string[], icons: Record<string, string>, size: { w: number; h: number }, board: boolean, product: boolean): string {
  const pct = (z: [number, number]) => `${Math.round(z[0] * 100)}~${Math.round(z[1] * 100)}%`;
  const canWrite = board && props.includes(WORD_PROP);
  const propDesc = (entry.props ?? [])
    .map((p) => p as { kind?: string; states?: Record<string, string> })
    .filter((p) => p.kind && props.includes(p.kind))
    .map((p) => `- ${p.kind}: ${Object.entries(p.states ?? {}).map(([k, v]) => `"${k}" = ${v}`).join(" / ")}`)
    .join("\n");
  return `너는 인스타 릴스(세로 ${size.w}×${size.h}) 코드 애니메이션 연출가다. 이 영상은 얼굴 달린 캐릭터 없이 그림 · 도형 · 글자로 설명한다. 확정된 음성 대본에 맞춰 이 영상만의 장면 계획을 새로 설계한다.

먼저 design에 설계를 쓴다: 대본의 생각 흐름(무엇 → 왜 → 그래서)을 장면마다 어떤 그림으로 보여 줄지, 처음 3초 후킹 화면, ${product ? "상품이 크게 나오는 장면, " : ""}끝 화면.
그다음 scenes를 쓴다:
- 음성 줄을 순서대로 빠짐없이 장면에 나눈다. from_beat~to_beat로 이어지는 줄을 한 장면에 묶을 수 있다. 장면 시각은 코드가 음성에서 계산하니 쓰지 않는다. fx · sfx의 때는 장면 길이 대비 0~1 비율로 쓴다.
- 한 장면에 생각 하나. 그 줄이 말하는 것을 아이콘 · 화살표 · 목록 점${product ? " · 상품" : ""}${canWrite ? " · 화면 글자" : ""}의 배치로 보여 준다. 장면마다 그림(글자가 아닌 소품)이 적어도 하나 있어야 한다. 그림 없이 빈 바탕만 두지 않는다.
- 소품 state의 "@초"는 장면 시작 기준 초다(장면 길이보다 짧게). 말에 맞춰 하나씩 나타나게 하고, 처음부터 있어야 하는 것은 @초 없이 쓴다. 한 장면에 소품은 2~6개.
- 원인 → 결과 · 순서는 화살표로 잇고, 둘 비교는 split 배경으로 좌우를 나눠 각 쪽에 그림을 둔다. 목록은 목록 점과 아이콘을 세로로 줄 세운다.
- 그림 · 상품과 바탕은 밝기가 달라 흑백으로 봐도 구분되게 고른다(예: 주황 · 노랑 상품은 navy · teal · ink 같은 어두운 바탕, 어두운 상품은 밝은 바탕).
- 중요한 그림은 크게(scale 2~3.5, 화면 높이의 4분의 1 안팎). 화면 가장자리에 붙이지 않는다(x 0.12~0.88). 그림끼리 겹치지 않게 떨어뜨린다(scale 1 = 높이 150px, 화면 높이 ${size.h}px).
- 카메라는 스타일 규칙을 따른다(픽토그램은 거의 고정 · 격자 따라 이동, 수채는 고정 또는 천천히 밀어 들어가기 · 팬). 카메라 값은 x · y 0~1, zoom 0.8~1.4 안에서.
- ${product ? "상품(product)은 실제 사진이 아니라 product_look에 정한 모양 · 색으로 비슷한 결로 그린 그림이다. 글자 · 로고 · 상표는 그리지 않는다. 상품을 소개하거나 상품 이름 · 특징 · 쓰는 법을 말하는 줄의 장면에 product를 크게(scale 2.5 안팎) 둔다. product_look은 상품 자료의 용기 · 포장 · 색 단서로 정하고, 단서가 없으면 이 종류 상품에 흔한 용기와 계정 브랜드 색으로 정한다." : "상품 자료가 없는 영상이라 product 소품을 쓰지 않고 product_look은 null이다."}
- caption_place는 그 장면에 모션 자막(첫 장면은 후킹 큰 글자도)이 들어갈 자리다. 자막 자리(화면 위에서부터 높이 기준): top = ${pct(CAPTION_ZONE.top)}, lower = ${pct(CAPTION_ZONE.lower)} 구간이고 자막은 화면 가로를 거의 다 쓴다. 그 장면의 소품(그림 · 화면 글자)은 이 띠 밖에 둔다. top이면 소품을 화면 y 0.34~0.56에, lower면 0.12~0.54에 두는 것이 안전하다. 후킹 큰 글자는 첫 줄이 끝날 때까지(2초 안팎) 첫 장면의 자리에 떠 있다.
- 좌표: 소품 at은 0~1 페이지 좌표의 가운데 점. 화면 좌표 = (위치 − 카메라 중심) × zoom + 0.5.
- ${canWrite ? `나레이션 자막과 후킹 큰 글자는 편집 키트가 얹으니 그리지 않는다. 화면 글자는 아래 "장면표가 정한 화면"에 화면 글자 · 끝 화면이 적힌 줄의 장면에서만, 거기 적힌 글자만 ${WORD_PROP} 소품으로 쓴다(state에 글자, "글자@초"면 그때부터 나타남). 소품 하나에 10자 이내, scale 1.2~2. 말의 문장을 글자로 옮기지 않는다.` : "화면에 글자를 그리지 않는다(나레이션 자막은 편집 키트가 얹는다)."}
- sfx는 보이는 움직임(그림이 나타남 · 화살표 · 답이 나오는 순간)에만. 15초에 6~10개 안팎.
- purpose에는 그 장면이 보여 주는 생각만 쓴다.${board ? `

장면표를 따르는 법(아래 "장면표가 정한 화면"):
- 장면표는 이 영상의 말과 화면을 함께 정한 계획이다. 줄마다 적힌 "보이는 것"과 설명 화면 · 그래픽의 내용을 그 줄을 맡은 장면이 보여 줘야 한다.
- 장면표는 사진 · 스톡 영상 · 코드 도식 기준으로 쓰였다. 사진 · 영상을 흉내 내지 말고, 전하려는 내용(무엇을, 무엇과 무엇이 다른지, 어떤 순서 · 숫자인지)을 아이콘 · 화살표 · 배치${product ? " · 상품 그림" : ""}으로 옮긴다.${product ? "\n- 제품 사진 · 자사 촬영 · 움직이는 이미지 줄은 상품이 화면에 보여야 한다(product)." : ""}
- 끝 화면: 마지막 줄의 장면은 처음 장면과 이어지게 마무리한다.${canWrite ? " 끝 화면 문구가 있으면 화면 글자로 보여 준다." : ""}` : ""}

이 영상의 스타일(${style}):
${styleNotes(style, 2000)}

엔진이 아는 것(이 밖의 값은 쓰지 않는다):
- 배경 모듈: ${JSON.stringify(entry.backgrounds).slice(0, 2200)}
- 소품:
${propDesc}
- 아이콘 이름(icon state): ${Object.entries(icons).map(([k, v]) => `${k}(${v})`).join(", ")}
- 효과(fx): ${entry.fx.join(", ") || "없음 — fx는 빈 배열"}
- 전환: ${["cut", ...entry.transitions.filter((t) => t !== "cut")].join(", ")}
- 효과음: ${LEMO_SFX.join(", ")}

${CLAIM_RULES}
- 상품 자료에 없는 효능을 그림으로 주장하지 않는다(예: 근거 없이 무언가가 '치료'되는 그림, 의약품처럼 보이는 모양).`;
}

/**
 * 캐릭터 없는 스타일의 장면 계획을 쓴다. 시각은 voice에서 코드가 채우고 AI는 장면 내용만 쓴다.
 * 문제가 있으면 문제 목록을 되먹여 최대 2번 다시 쓰고, 문제가 가장 적은 결과와 남은 문제를 돌려준다(direct.ts directProduction과 같은 방식).
 */
export async function directExplainer(input: {
  choice: ProductionChoice;
  account: AccountContext;
  profile: AccountProfile;
  voice: VoiceLine[];
  script: string[];
  facts: ProductFacts | null;
  brief?: BoardBrief | null;
  size?: { w: number; h: number };
  fps?: number;
}): Promise<{ production: Production; usage: AiUsage[]; attempts: number; problems: string[]; review: string[] }> {
  const { choice, account, profile } = input;
  if (choice.backend !== "lemo-code" || !choice.style) throw new Error("directExplainer: lemo-code 선택(스타일 포함)만 장면 계획을 써요");
  if (!input.voice.length) throw new Error("directExplainer: 확정된 음성 줄이 없어요");
  const voice = [...input.voice].sort((a, b) => a.start - b.start);
  if (new Set(voice.map((v) => v.beat)).size !== voice.length) throw new Error("directExplainer: 음성 줄 번호(beat)가 겹쳐요");
  const style = choice.style;
  const manifest = loadEngineManifest();
  const entry = manifest.styles[style];
  if (!entry) throw new Error(`directExplainer: 엔진 manifest에 ${style} 스타일 모듈이 없어요(있는 것: ${Object.keys(manifest.styles).join(", ")})`);
  if (!isExplainStyle(manifest, style)) throw new Error(`directExplainer: ${style}는 캐릭터 없이 설명하는 스타일이 아니에요(manifest characters: false가 아님)`);
  const size = input.size ?? { w: 1080, h: 1920 };
  const fps = input.fps ?? 30;
  let brief = input.brief ?? null;
  if (brief && (brief.scenes.length !== voice.length || voice.some((v, i) => v.beat !== i))) {
    console.warn(`[lemo] 장면표 ${brief.scenes.length}장면과 음성 ${voice.length}줄이 맞지 않아 장면표 화면 지시 없이 장면을 짜요`);
    brief = null;
  }
  // 화면 글자는 장면표가 있을 때만, 상품 그림은 상품 자료가 있을 때만
  const props = stylePropNames(entry).filter((k) => (k !== WORD_PROP || !!brief) && (k !== "product" || !!input.facts));
  const icons = iconNames(manifest);
  const schema = planSchema(entry, props);

  const user = `${accountBlock(account)}

${factsBlock(input.facts)}${input.facts ? `\n\n${productLookBlock(input.facts).replace("[상품 배역]이 그릴 상품", "화면에 그릴 상품")}` : ""}

계정 브랜드 색: ${profile.brand.palette.join(", ")} / 잉크 ${profile.brand.ink} / 종이 ${profile.brand.paper}
제작 방식 선택 이유: ${choice.reason}

확정된 음성(줄 번호 · 말하는 구간 · 문장):
${voice.map((v) => `${v.beat}. [${v.start.toFixed(2)}–${v.end.toFixed(2)}초, ${(v.end - v.start).toFixed(1)}초] ${v.text}`).join("\n")}
영상 길이: ${(voice[voice.length - 1].end + TAIL).toFixed(2)}초${input.script.length && input.script.length !== voice.length ? `\n(원래 대본 ${input.script.length}줄 — 음성 줄을 기준으로 한다)` : ""}${brief ? `\n\n장면표가 정한 화면(번호 = 음성 줄 번호):\n${boardScreenLines(brief)}` : ""}`;

  const messages: Message[] = [
    { role: "system", content: systemPrompt(style, entry, props, icons, size, !!brief, !!input.facts) },
    { role: "user", content: user },
  ];
  const usage: AiUsage[] = [];
  let best: { production: Production; problems: string[]; plan: ExplainPlan } | null = null;
  let attempts = 0;
  for (; attempts < 3; ) {
    attempts++;
    const r = await lemoParse({ stage: "lemo.explain", schema, name: "explain_plan", messages, maxTokens: 9000 });
    usage.push(r.usage);
    const plan = r.parsed;
    let problems = coverageProblems(voice, asAiProduction(plan).scenes);
    let production: Production | null = null;
    if (!problems.length) {
      try {
        production = planToProduction(plan, { voice, choice, account, profile, size, fps, style });
        problems = explainProblems(plan, production, { manifest, entry, props, voice, brief, facts: input.facts });
      } catch (e) {
        problems = [`계약 형식 검사 실패: ${e instanceof Error ? e.message.slice(0, 600) : String(e)}`];
      }
    }
    if (production && (!best || problems.length < best.problems.length)) best = { production, problems, plan };
    if (production && !problems.length) break;
    if (attempts < 3) messages.push({ role: "assistant", content: r.content }, { role: "user", content: `검사에서 문제가 나왔어요. 설계 의도는 유지하고 문제만 고쳐서 전체를 다시 답해 주세요:\n${problems.map((p) => `- ${p}`).join("\n")}` });
    else if (!best) throw new Error(`directExplainer: 세 번 모두 장면을 음성 줄에 맞추지 못했어요 — ${problems.join(" / ")}`);
  }
  if (!best) throw new Error("directExplainer: 결과 없음");
  const kept = brief ? dropForeignWords(best.production, brief) : { production: best.production, dropped: [] };
  for (const d of kept.dropped) console.warn(`[lemo] ${d}`);
  // 상품 그림은 글 자료로 추정한 모양 · 색이다 — 캐릭터 영상의 새 상품 캐릭터와 같이 사람이 확인하게 남긴다
  const look = best.plan.product_look;
  const review = look && input.facts ? [`상품 그림: ${input.facts.name}의 용기 · 색을 상품 글 자료로 추정해 그렸어요(${look.shape}${look.fruit ? `/${look.fruit}` : ""}, ${look.body} — ${look.why.slice(0, 80)}). 상품 사진은 참고하지 않았으니 실제 상품과 비슷한지 확인해 주세요`] : [];
  return { production: kept.production, usage, attempts, problems: best.problems, review };
}


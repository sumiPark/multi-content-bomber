import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { z } from "zod";
import { imageDataUrl } from "@/lib/shoot/video-kit/tools";
import { lemoRoot, loadEngineManifest, manifestPropNames, styleNotes, type EngineManifest } from "./catalog";
import { characterSpecSchema, type AccountContext, type AiUsage, type CharacterSpec, type Production, type ProductionChoice } from "./contract";
import { buildSheetProject } from "./project";
import { renderStills } from "./render";
import { accountBlock, assertAccountLibrary, CLAIM_RULES, factsBlock, lemoParse, librarySummary } from "./select";
import type { ProductFacts } from "@/lib/agents/product-facts";
import type OpenAI from "openai";

// 캐릭터 준비 — 계정 라이브러리(lib/lemo/library/accounts/<account_key>/)만 읽고, 맞는 캐릭터가 없으면
// 그 계정 이름공간으로 parametric 리그용 명세를 새로 만든다. 새 캐릭터는 작업 폴더에만 쓰고(라이브러리 저장은 사람이 확인한 뒤 따로),
// 시트를 실제 엔진으로 렌더해 비전 검수를 거친다. 불합격은 한 번 다시 만들고, 그래도 안 되면 problems에 남긴다.
// 라이브러리 폴더 · account.json · rig.js는 사람이 확인한 뒤 따로 저장한다. 여기서는 읽기만 한다.

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type Brand = Production["brand"];

// ── 계정 프로필 · 라이브러리 ───────────────────────────────────────────────────

const DEFAULT_BRAND: Brand = { palette: ["#3b3330", "#f4efe3", "#e9a3a0", "#8cb8d8", "#f2c96b"], ink: "#3b3330", paper: "#f4efe3" };
const scalar = z.union([z.string(), z.number(), z.boolean()]);

// account.json 형식은 엔진 작업자와 맞춰 가는 중이라 모르는 칸은 남겨 두고, 아는 칸만 읽는다
const accountProfileSchema = z
  .object({
    account_key: z.string().optional(),
    name: z.string().nullable().optional(),
    // 한 계정에 시리즈가 여럿일 수 있다: 글자 하나 또는 [{ id, name, characters }]
    series: z.union([z.string(), z.array(z.object({ id: z.string() }).loose())]).nullable().optional(),
    brand: z.object({ palette: z.array(z.string()), ink: z.string(), paper: z.string() }).optional(),
    preferred_styles: z.array(z.string()).optional(),
    preferredStyles: z.array(z.string()).optional(),
    notes: z.string().nullable().optional(),
    mood: z.string().nullable().optional(),
    style_params: z.record(z.string(), z.record(z.string(), scalar)).optional(),
  })
  .loose();

export interface AccountProfile {
  accountKey: string;
  name: string | null;
  series: string | null;
  brand: Brand;
  preferredStyles: string[];
  notes: string | null;
  // 스타일별 조절값(종이색 등) — production.style.params에 그대로 들어간다
  styleParams: Record<string, Record<string, string | number | boolean>>;
  // account.json이 있었는지(없으면 기본 프로필)
  fromFile: boolean;
}

const KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

function defaultProfile(accountKey: string): AccountProfile {
  return { accountKey, name: null, series: null, brand: DEFAULT_BRAND, preferredStyles: [], notes: null, styleParams: {}, fromFile: false };
}

/**
 * 그 계정 폴더만 읽는다. 폴더가 없으면 빈 라이브러리와 기본 프로필.
 * 명세의 account_key가 폴더와 다르면 throw — 다른 계정 캐릭터가 섞여 있으면 조용히 쓰지 않는다.
 */
export function loadAccountLibrary(accountKey: string, root?: string): { profile: AccountProfile; characters: CharacterSpec[]; dirOf: Map<string, string> } {
  if (!KEY_RE.test(accountKey)) throw new Error(`계정 키 형식이 아니에요: ${accountKey}`);
  const dir = join(root ?? join(lemoRoot(), "library"), "accounts", accountKey);
  const dirOf = new Map<string, string>();
  if (!existsSync(dir)) return { profile: defaultProfile(accountKey), characters: [], dirOf };

  let profile = defaultProfile(accountKey);
  const accountFile = join(dir, "account.json");
  if (existsSync(accountFile)) {
    const parsed = accountProfileSchema.safeParse(JSON.parse(readFileSync(accountFile, "utf8")));
    if (!parsed.success) throw new Error(`${accountFile} 형식 오류: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join(" / ")}`);
    const a = parsed.data;
    if (a.account_key && a.account_key !== accountKey) throw new Error(`${accountFile}의 account_key(${a.account_key})가 폴더(${accountKey})와 달라요`);
    profile = {
      accountKey,
      name: a.name ?? null,
      // 시리즈가 하나면 새 캐릭터도 그 시리즈로, 여럿이면 정하지 않는다(대본마다 다르므로)
      series: Array.isArray(a.series) ? (a.series.length === 1 ? a.series[0].id : null) : (a.series ?? null),
      brand: a.brand ?? DEFAULT_BRAND,
      preferredStyles: a.preferred_styles ?? a.preferredStyles ?? [],
      notes: a.notes ?? a.mood ?? null,
      styleParams: a.style_params ?? {},
      fromFile: true,
    };
  }

  const characters: CharacterSpec[] = [];
  const charRoot = join(dir, "characters");
  if (existsSync(charRoot)) {
    for (const name of readdirSync(charRoot, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const specFile = join(charRoot, name.name, "spec.json");
      if (!existsSync(specFile)) continue;
      const parsed = characterSpecSchema.safeParse(JSON.parse(readFileSync(specFile, "utf8")));
      if (!parsed.success) throw new Error(`${specFile} 형식 오류: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join(" / ")}`);
      const spec = parsed.data;
      if (spec.account_key !== accountKey) throw new Error(`${specFile}는 ${spec.account_key} 계정 캐릭터라 ${accountKey} 라이브러리에 둘 수 없어요`);
      if (dirOf.has(spec.id)) throw new Error(`${accountKey} 라이브러리에 캐릭터 id ${spec.id}가 두 번 있어요`);
      characters.push(spec);
      dirOf.set(spec.id, join(charRoot, name.name));
    }
  }
  return { profile, characters, dirOf };
}

// ── 시트 렌더 도구 ────────────────────────────────────────────────────────────

interface SheetTools {
  buildSheetProject: (opts: { workDir: string; accountKey: string; character: CharacterSpec; characterDir?: string; style: string; brand: Brand }) => string;
  renderStills: (filmDir: string, times: number[], outDir: string, query?: Record<string, string>) => Promise<{ files: string[]; seconds: number }>;
}

async function sheetTools(): Promise<SheetTools> {
  return { buildSheetProject, renderStills };
}

// ── 새 캐릭터 설계 ────────────────────────────────────────────────────────────

const CONTRACT_SHAPES = ["drop", "blob", "bottle", "fruit", "human", "animal"] as const;

function enumOf(values: string[], what: string) {
  const uniq = [...new Set(values)];
  if (!uniq.length) throw new Error(`lemo 엔진 manifest의 ${what}가 비어 있어요`);
  return z.enum(uniq as [string, ...string[]]);
}

function designSchema(m: EngineManifest) {
  const shapes = CONTRACT_SHAPES.filter((s) => m.parametric.shapes.includes(s));
  if (!shapes.length) throw new Error(`manifest parametric.shapes(${m.parametric.shapes.join(", ")})에 계약의 몸 모양(${CONTRACT_SHAPES.join(", ")})이 하나도 없어요`);
  const props = manifestPropNames(m);
  return z.object({
    characters: z.array(
      z.object({
        role: z.string().describe("요청 배역 이름 그대로"),
        slug: z.string().describe("영문 소문자 · 숫자 · 하이픈 2~24자. 이 계정 안에서 구분되는 이름"),
        name: z.string().describe("화면 밖에서 부르는 한국어 이름"),
        description: z.string().describe("생김새(형태 · 색 · 눈 · 팔다리 · 특징)와 성격 두세 문장. 시트 검수 기준이 된다"),
        shape: z.enum(shapes as [string, ...string[]]),
        height: z.number().describe("1080 폭 기준 기본 키(px). 보통 360~720"),
        head_ratio: z.number().describe("머리 : 키. 아이 같은 비율은 0.4 안팎, 사람은 0.2~0.3"),
        colors: z.object({
          body: z.string().describe("#rrggbb"),
          line: z.string().describe("#rrggbb"),
          accent: z.string().describe("#rrggbb"),
          cheek: z.string().nullable().describe("#rrggbb 또는 null"),
        }),
        features: z.array(z.object({ key: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) })).describe("리그 특징값(manifest에 있는 키만)"),
        expressions: z.array(enumOf(m.parametric.expressions, "parametric.expressions")).describe("대본에 필요한 표정 전부. 3개 이상"),
        actions: z.array(enumOf(m.parametric.actions, "parametric.actions")).describe("대본에 필요한 동작 전부"),
        views: z.array(z.enum(["front", "q", "side"])),
        props: props.length ? z.array(z.enum(props as [string, ...string[]])) : z.array(z.string()).describe("엔진 소품 목록이 비어 있어 빈 배열"),
        why: z.string().describe("이 대본 · 계정에 이 생김새와 표정 · 동작이 필요한 이유"),
      }),
    ),
  });
}
type Design = z.infer<ReturnType<typeof designSchema>>["characters"][number];

const HEX = /^#[0-9a-f]{6}$/i;

function designProblems(d: Design, m: EngineManifest): string[] {
  const out: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]{1,23}$/.test(d.slug)) out.push(`${d.role}: slug "${d.slug}"는 영문 소문자 · 숫자 · 하이픈 2~24자가 아니에요`);
  for (const [k, v] of Object.entries(d.colors)) if (v !== null && !HEX.test(v)) out.push(`${d.role}: colors.${k} "${v}"가 #rrggbb가 아니에요`);
  if (new Set(d.expressions).size < 3) out.push(`${d.role}: 표정이 3개보다 적어요(모델 시트는 표정 3~4개가 필요)`);
  if (!d.actions.length) out.push(`${d.role}: 동작이 비어 있어요`);
  if (d.head_ratio < 0.12 || d.head_ratio > 0.75) out.push(`${d.role}: head_ratio ${d.head_ratio}가 범위(0.12~0.75) 밖이에요`);
  if (d.height < 200 || d.height > 1400) out.push(`${d.role}: height ${d.height}px가 범위(200~1400) 밖이에요`);
  if (!d.views.includes("front")) out.push(`${d.role}: views에 front가 없어요`);
  const known = shapeFeatures(m)[d.shape];
  const keys = known ? Object.keys(known) : null;
  if (keys) {
    for (const f of d.features) {
      if (!keys.includes(f.key)) out.push(`${d.role}: 특징 키 ${f.key}는 ${d.shape} 리그에 없어요(${keys.join(", ")})`);
      // 리그는 색 칸을 그대로 칠한다. 설명 글이 들어가면 색이 깨진다(예: 머리가 흰색으로 나옴)
      else if (/#hex/.test(String(known![f.key])) && typeof f.value === "string" && !HEX.test(f.value) && f.value !== "false") out.push(`${d.role}: ${f.key}는 #rrggbb 색 값이어야 해요("${f.value}")`);
    }
  }
  return out;
}

/** manifest의 모양별 특징 칸(shape_features). 예전 형식(features)도 받는다. */
function shapeFeatures(m: EngineManifest): Record<string, Record<string, string>> {
  const p = m.parametric as Record<string, unknown>;
  const raw = (p.shape_features ?? p.features) as unknown;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, Record<string, string>>) : {};
}

function toSpec(d: Design, id: string, accountKey: string, series: string | null, madeFor: string): CharacterSpec {
  return characterSpecSchema.parse({
    id,
    account_key: accountKey,
    series,
    name: d.name,
    description: d.description,
    rig: "parametric",
    body: {
      shape: d.shape,
      height: d.height,
      head_ratio: d.head_ratio,
      colors: d.colors,
      features: Object.fromEntries(d.features.map((f) => [f.key, f.value])),
    },
    expressions: [...new Set(d.expressions)],
    actions: [...new Set(d.actions)],
    views: [...new Set(d.views)],
    props: [...new Set(d.props)],
    made_for: madeFor,
    sheet: null,
  });
}

function designSystem(m: EngineManifest, style: string): string {
  const sf = shapeFeatures(m);
  const featureInfo = Object.keys(sf).length ? `${JSON.stringify(sf).slice(0, 1800)} — 고른 몸 모양의 키만 쓴다. "#hex"라고 적힌 칸은 #rrggbb 색 값만 넣는다(설명 글 금지)` : null;
  return `너는 릴스 애니메이션 캐릭터 디자이너다. 공용 매개변수 리그(parametric)로 그릴 캐릭터 명세를 쓴다. 그림 코드는 쓰지 않는다.

리그가 아는 것(이 밖의 값은 쓰지 않는다):
- 몸 모양: ${m.parametric.shapes.join(", ")}
- 표정: ${m.parametric.expressions.join(", ")}
- 동작: ${m.parametric.actions.join(", ")}${featureInfo ? `\n- 특징값(features, 몸 모양별): ${featureInfo}` :"\n- 특징값(features): 리그 목록이 없다. 꼭 필요한 것만 짧은 키로 2~4개"}
- 소품: ${manifestPropNames(m).join(", ") || "없음"}

이 영상의 스타일(${style}) 요약:
${styleNotes(style, 1600)}

규칙:
- 배역마다 하나씩, 요청한 배역 이름을 role에 그대로 쓴다.
- 대본 줄마다 필요한 감정 · 행동을 따져 expressions · actions에 빠짐없이 넣는다. 놀람 · 걱정 · 기쁨처럼 대본이 바뀌는 지점의 감정이 꼭 있어야 한다. 쓰지 않을 것은 넣지 않는다.
- 썸네일 크기에서도 실루엣이 읽히게 형태를 단순하고 크게. 배역끼리 몸 색이 겹치지 않게 하고, 종이색 위에서 같은 색끼리 겹쳐 안 보이는 일이 없게 한다. 외곽선 색은 스타일 규칙을 따른다(예: 크레용 그림책은 검정 금지).
- 계정 브랜드 색과 어울리게 고르되 배역 구분이 먼저다.
- 실제 상품을 의인화할 때 상품 자료에 없는 효능을 생김새로 주장하지 않는다(예: 근거 없는 '치료' 도구, 의약품처럼 보이는 모양).
- 기존 만화 · 게임 · 브랜드 캐릭터를 닮게 만들지 않는다.
- 같은 계정 라이브러리 캐릭터와 겹치지 않는 이름 · 생김새로 만든다.

${CLAIM_RULES}`;
}

// ── 시트 검수 ─────────────────────────────────────────────────────────────────

const reviewSchema = z.object({
  description_match: z.boolean().describe("그림의 형태 · 색 · 특징이 설명과 맞는지"),
  proportions_ok: z.boolean().describe("머리 : 키 비율이 명세와 비슷하고, 잘리거나 겹친 부분 없이 형태가 읽히는지"),
  expressions_distinct: z.boolean().describe("표정들이 휴대폰 화면 크기에서도 서로 구분되는지(걱정 · 화남 눈썹 방향 등)"),
  issues: z.array(z.string()).describe("고칠 점. 명세의 어느 값을 어떻게 바꿀지 구체적으로. 없으면 빈 배열"),
});
type Review = z.infer<typeof reviewSchema>;

function mimeOf(file: string): string {
  const ext = extname(file).toLowerCase();
  return ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
}

async function reviewSheet(spec: CharacterSpec, files: string[]): Promise<{ review: Review; usage: AiUsage }> {
  const images = files.slice(0, 4).map((f) => ({ type: "image_url" as const, image_url: { url: imageDataUrl(f, mimeOf(f)), detail: "high" as const } }));
  const r = await lemoParse({
    stage: "lemo.character.review",
    schema: reviewSchema,
    name: "character_sheet_review",
    maxTokens: 1200,
    messages: [
      {
        role: "system",
        content: "너는 애니메이션 캐릭터 시트 검수자다. 실제 엔진으로 렌더한 캐릭터 시트 그림을 명세와 대조한다. 그림에 보이는 것만 근거로 판정하고, 사소한 붓질 차이는 문제로 삼지 않는다. 표정 칸이 있으면 이름과 생김새가 맞는지도 본다.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `명세:\n이름: ${spec.name}\n설명: ${spec.description}\n몸 모양: ${spec.body.shape}, 키 ${spec.body.height}px(1080 폭 기준), 머리 : 키 ${spec.body.head_ratio}\n색: ${JSON.stringify(spec.body.colors)}\n특징: ${JSON.stringify(spec.body.features)}\n표정: ${spec.expressions.join(", ")}\n방향: ${spec.views.join(", ")}`,
          },
          ...images,
        ],
      },
    ],
  });
  return { review: r.parsed, usage: r.usage };
}

const passed = (r: Review) => r.description_match && r.proportions_ok && r.expressions_distinct;

function reviewText(r: Review): string {
  const flags = [!r.description_match && "설명과 그림이 다름", !r.proportions_ok && "비율 · 형태 문제", !r.expressions_distinct && "표정 구분이 안 됨"].filter(Boolean);
  return [...flags, ...r.issues].join(" / ");
}

// ── 준비 ─────────────────────────────────────────────────────────────────────

/**
 * 제작 방식 선택 결과의 배역대로 캐릭터를 준비한다.
 * - reuse id가 이 계정 라이브러리에 있으면 그대로 쓴다(없으면 새로 만들고 problems에 남긴다).
 * - 새 배역은 OpenAI로 parametric 명세를 만들어 workDir/new-characters/<id>/spec.json에 쓰고, 시트를 렌더 · 비전 검수한다.
 * - library는 그 계정 것만(다른 계정 캐릭터가 있으면 throw).
 */
export async function prepareCharacters(input: {
  choice: ProductionChoice;
  account: AccountContext;
  profile: AccountProfile;
  library: CharacterSpec[];
  script: string[];
  facts: ProductFacts | null;
  workDir: string;
  style: string;
}): Promise<{ characters: CharacterSpec[]; reused: string[]; created: { spec: CharacterSpec; dir: string; sheet: string }[]; usage: AiUsage[]; problems: string[] }> {
  const { account, profile, library } = input;
  assertAccountLibrary(account.accountKey, library, "prepareCharacters");
  if (profile.accountKey !== account.accountKey) throw new Error(`prepareCharacters: 프로필(${profile.accountKey})과 계정(${account.accountKey})이 달라요`);
  const out = { characters: [] as CharacterSpec[], reused: [] as string[], created: [] as { spec: CharacterSpec; dir: string; sheet: string }[], usage: [] as AiUsage[], problems: [] as string[] };
  if (input.choice.backend !== "lemo-code") return out;

  const manifest = loadEngineManifest();
  const byId = new Map(library.map((c) => [c.id, c]));
  const toCreate: { role: string; why: string }[] = [];
  for (const role of input.choice.characters) {
    const spec = role.reuse ? byId.get(role.reuse) : undefined;
    if (role.reuse && !spec) out.problems.push(`배역 ${role.role}: 재사용으로 고른 ${role.reuse}가 라이브러리에 없어 새로 만들어요`);
    if (spec) {
      if (!out.reused.includes(spec.id)) {
        out.reused.push(spec.id);
        out.characters.push(spec);
      }
      if (spec.rig === "parametric") {
        const unknownExpr = spec.expressions.filter((e) => !manifest.parametric.expressions.includes(e));
        const unknownAct = spec.actions.filter((a) => a !== "idle" && !manifest.parametric.actions.includes(a));
        if (unknownExpr.length || unknownAct.length) out.problems.push(`${spec.id}: 리그에 없는 표정 · 동작이 명세에 있어요(${[...unknownExpr, ...unknownAct].join(", ")})`);
      }
      continue;
    }
    toCreate.push({ role: role.role, why: role.why });
  }
  if (!toCreate.length) return out;

  const tools = await sheetTools();
  const schema = designSchema(manifest);
  const madeFor = `${input.facts?.name ?? "상품 없음"} · ${input.script[0] ?? ""}`.slice(0, 120);
  const taken = new Set([...library.map((c) => c.id)]);
  const idFor = (slug: string) => {
    let id = `${account.accountKey}.${slug}`;
    for (let n = 2; taken.has(id); n++) id = `${account.accountKey}.${slug}-${n}`;
    taken.add(id);
    return id;
  };

  const baseUser = `${accountBlock(account)}
브랜드 색: ${profile.brand.palette.join(", ")} / 선 ${profile.brand.ink} / 종이 ${profile.brand.paper}

${factsBlock(input.facts)}

대본:
${input.script.map((l, i) => `${i}. ${l}`).join("\n")}

${librarySummary(library)}`;

  const design = async (roles: { role: string; why: string }[], feedback: string | null): Promise<Design[]> => {
    const messages: Message[] = [
      { role: "system", content: designSystem(manifest, input.style) },
      {
        role: "user",
        content: `${baseUser}

만들 배역:
${roles.map((r) => `- ${r.role}: ${r.why}`).join("\n")}${feedback ? `\n\n앞서 만든 명세의 문제(고쳐서 다시 만든다):\n${feedback}` : ""}`,
      },
    ];
    let last: Design[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await lemoParse({ stage: "lemo.character.create", schema, name: "character_specs", messages, maxTokens: 3000 });
      out.usage.push(r.usage);
      last = r.parsed.characters;
      const problems = [
        ...roles.filter((x) => !last.some((d) => d.role === x.role)).map((x) => `배역 ${x.role}의 명세가 없어요`),
        ...last.flatMap((d) => designProblems(d, manifest)),
      ];
      if (!problems.length) return last;
      if (attempt === 1) {
        out.problems.push(...problems.map((p) => `명세 형식: ${p}`));
        return last;
      }
      messages.push({ role: "assistant", content: r.content }, { role: "user", content: `형식 문제를 고쳐 다시 답해 주세요:\n${problems.map((p) => `- ${p}`).join("\n")}` });
    }
    return last;
  };

  const renderAndReview = async (spec: CharacterSpec, dir: string): Promise<{ sheet: string | null; review: Review | null }> => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "spec.json"), JSON.stringify(spec, null, 2));
    let files: string[];
    try {
      const film = tools.buildSheetProject({ workDir: join(input.workDir, "sheet-projects", spec.id), accountKey: account.accountKey, character: spec, characterDir: dir, style: input.style, brand: profile.brand });
      files = (await tools.renderStills(film, [0.5], join(dir, "sheet"), { sheet: spec.id })).files;
    } catch (e) {
      out.problems.push(`${spec.id}: 시트 렌더 실패 — ${e instanceof Error ? e.message : String(e)}`);
      return { sheet: null, review: null };
    }
    if (!files.length) {
      out.problems.push(`${spec.id}: 시트 렌더 결과 그림이 없어요`);
      return { sheet: null, review: null };
    }
    const sheet = files[0];
    writeFileSync(join(dir, "spec.json"), JSON.stringify({ ...spec, sheet }, null, 2));
    const { review, usage } = await reviewSheet(spec, files);
    out.usage.push(usage);
    return { sheet, review };
  };

  const designs = await design(toCreate, null);
  for (const role of toCreate) {
    const d = designs.find((x) => x.role === role.role);
    if (!d) continue;
    const id = idFor(d.slug);
    const dir = join(input.workDir, "new-characters", id);
    let spec = toSpec(d, id, account.accountKey, profile.series, madeFor);
    let res = await renderAndReview(spec, dir);
    if (res.review && !passed(res.review)) {
      const first = reviewText(res.review);
      const redo = await design([role], `${JSON.stringify({ ...d, why: undefined })}\n검수 결과: ${first}`);
      const d2 = redo.find((x) => x.role === role.role);
      if (d2) {
        spec = toSpec(d2, id, account.accountKey, profile.series, madeFor);
        res = await renderAndReview(spec, dir);
        if (res.review && !passed(res.review)) out.problems.push(`${id}: 시트 검수 두 번 불합격 — ${reviewText(res.review)}`);
      } else out.problems.push(`${id}: 시트 검수 불합격(${first}) 후 다시 만든 명세가 없어요`);
    } else if (res.review && res.review.issues.length) {
      // 합격이어도 지적은 남긴다(조용히 넘기지 않음)
      out.problems.push(`${id}: 시트 검수 합격, 참고 지적 — ${res.review.issues.join(" / ")}`);
    }
    if (res.sheet) spec = { ...spec, sheet: res.sheet };
    out.characters.push(spec);
    if (res.sheet) out.created.push({ spec, dir, sheet: res.sheet });
    else out.problems.push(`${id}: 시트가 없어 검수하지 못한 캐릭터예요 — 사람 확인 전에는 쓰지 마세요`);
  }
  return out;
}

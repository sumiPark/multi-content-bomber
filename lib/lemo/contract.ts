import { z } from "zod";

// lemo 제작 경로의 데이터 계약.
// 엔진 코드(lib/lemo/engine — 브라우저 render(t))와 영상마다 바뀌는 데이터(대본 · 음성 시각 · 캐릭터 명세 · 장면 타임라인)를 나눈다.
// 연출 AI는 이 형식의 데이터만 쓰고, 렌더 페이지는 이 데이터만 읽는다. 같은 형식을 production.json으로 프로젝트 폴더에 둔다.
// lemo는 화면(캐릭터 · 배경 · 동작 · 카메라)만 맡는다. 음성 · 모션 자막 · 음악 · 효과음 합성은 기존 편집 키트가 맡는다.

/** 실제로 영상을 만드는 실행 경로. 외부 영상 모델은 이 프로젝트에 연결된 경로가 없어 후보에 넣지 않는다. */
export const BACKENDS = ["lemo-code", "auto-video"] as const;
export type Backend = (typeof BACKENDS)[number];

export const RENDER_MODES = ["2d", "2.5d", "3d"] as const;
export type RenderMode = (typeof RENDER_MODES)[number];

/** 0~1 화면 비율 좌표. 1080×1920 기준으로 엔진이 픽셀로 바꾼다. */
const point = z.object({ x: z.number(), y: z.number() });

export const cameraKeySchema = z.object({
  x: z.number().describe("카메라가 보는 중심 x(0~1)"),
  y: z.number().describe("카메라가 보는 중심 y(0~1)"),
  zoom: z.number().describe("1이 기본, 1.3이면 30% 당겨 보기"),
  rot: z.number().default(0).describe("기울기(도). 대부분 0"),
});
export type CameraKey = z.infer<typeof cameraKeySchema>;

export const placementSchema = z.object({
  x: z.number().describe("발(바닥 기준점) x, 0~1"),
  y: z.number().describe("발(바닥 기준점) y, 0~1"),
  scale: z.number().describe("1이 캐릭터 기본 크기"),
  facing: z.enum(["left", "right", "front"]).default("front"),
});

/** 장면 안의 한 캐릭터 연기. 표정 · 동작 이름은 그 캐릭터 명세(expressions · actions)에 있는 것만 쓴다. */
export const actorSchema = z.object({
  cast: z.string().describe("cast[].id"),
  from: placementSchema,
  to: placementSchema.nullable().describe("장면 동안 이동하면 도착 위치, 아니면 null"),
  expr: z.string().describe("표정 이름(캐릭터 명세의 expressions 중)"),
  expr_to: z.string().nullable().describe("장면 중 감정이 바뀌면 바뀐 표정, 아니면 null"),
  expr_at: z.number().nullable().describe("expr_to로 바뀌는 시각(장면 시작 기준 초)"),
  action: z.string().describe("동작 이름(캐릭터 명세의 actions 중). 가만히 있으면 idle"),
  look: z.union([z.string(), point]).nullable().describe("시선: 다른 cast id 또는 화면 좌표, 없으면 null"),
  enter_at: z.number().nullable().describe("장면 중간에 들어오면 시각(초), 처음부터 있으면 null"),
  exit_at: z.number().nullable().describe("장면 중간에 나가면 시각(초), 끝까지 있으면 null"),
});
export type Actor = z.infer<typeof actorSchema>;

export const propSchema = z.object({
  kind: z.string().describe("소품 이름(캐릭터 · 배경 라이브러리의 props 중)"),
  at: point,
  scale: z.number(),
  state: z.string().nullable().describe("소품 상태(예: open, empty). 없으면 null"),
});

export const sceneSchema = z.object({
  id: z.string(),
  beat: z.number().int().describe("이 장면이 맡는 음성 줄 번호(0부터). 여러 줄을 한 장면이 맡으면 첫 줄"),
  start: z.number().describe("영상 기준 시작 초 — 확정된 음성 시각에서 온다"),
  end: z.number(),
  purpose: z.string().describe("이 장면이 이야기에서 하는 일 한 줄(목적 · 행동 · 반응)"),
  background: z.string().describe("backgrounds[].id"),
  camera: z.object({ from: cameraKeySchema, to: cameraKeySchema, ease: z.enum(["linear", "in", "out", "inout"]) }),
  actors: z.array(actorSchema),
  props: z.array(propSchema),
  fx: z.array(z.object({ kind: z.string(), t: z.number().describe("장면 시작 기준 초"), at: point.nullable() })).describe("스타일 모듈이 아는 효과만(예: sparkle, ripple)"),
  transition_in: z.enum(["cut", "fade", "wipe", "page-turn", "match"]),
  caption_place: z.enum(["top", "lower"]).describe("모션 자막이 들어갈 자리. 이 자리에는 얼굴 · 중요한 행동을 두지 않는다"),
});
export type Scene = z.infer<typeof sceneSchema>;

export const productionSchema = z.object({
  version: z.literal(1),
  size: z.object({ w: z.number().int(), h: z.number().int() }),
  fps: z.number().int(),
  duration: z.number(),
  account_key: z.string().describe("캐릭터 · 배경 라이브러리 이름공간. 다른 계정 것을 쓰지 않는다"),
  series: z.string().nullable(),
  style: z.object({
    slug: z.string().describe("lemo 스타일 slug"),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).describe("스타일 모듈 조절값(종이색, 떨림 fps 등)"),
  }),
  brand: z.object({ palette: z.array(z.string()).describe("#rrggbb"), ink: z.string(), paper: z.string() }),
  cast: z.array(z.object({ id: z.string(), character: z.string().describe("라이브러리 캐릭터 id"), role: z.string() })),
  backgrounds: z.array(z.object({ id: z.string(), kind: z.string().describe("배경 모듈 이름"), params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) })),
  scenes: z.array(sceneSchema),
  sfx: z.array(z.object({ t: z.number(), name: z.string() })).describe("기존 편집 키트 효과음 이름(ig-edit-ko kit.json sfx)만"),
});
export type Production = z.infer<typeof productionSchema>;

/** 계정 · 시리즈 단위로 저장하는 캐릭터 명세. 그림 코드는 같은 폴더의 rig.js. */
export const characterSpecSchema = z.object({
  id: z.string(),
  account_key: z.string(),
  series: z.string().nullable(),
  name: z.string(),
  description: z.string(),
  // parametric이면 공용 매개변수 리그(engine/parametric.js)로 그린다. module이면 같은 폴더 rig.js
  rig: z.enum(["parametric", "module"]),
  body: z.object({
    shape: z.enum(["drop", "blob", "bottle", "fruit", "human", "animal"]),
    height: z.number().describe("1080 폭 기준 기본 키(px)"),
    head_ratio: z.number().describe("머리 : 키"),
    colors: z.object({ body: z.string(), line: z.string(), accent: z.string(), cheek: z.string().nullable() }),
    features: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  }),
  expressions: z.array(z.string()),
  actions: z.array(z.string()),
  views: z.array(z.enum(["front", "q", "side"])),
  props: z.array(z.string()),
  made_for: z.string().describe("처음 만든 대본 · 영상"),
  sheet: z.string().nullable().describe("캐릭터 시트 그림 파일(검수 기록)"),
  // 상품 캐릭터만: 그 상품(products.id). 같은 상품 영상에서 이 키로 찾아 재사용한다. 예전 명세에는 없다
  product_id: z.string().nullable().optional().describe("이 캐릭터가 그린 상품 id. 상품 캐릭터가 아니면 없음"),
});
export type CharacterSpec = z.infer<typeof characterSpecSchema>;

/** 확정된 음성의 줄별 시각. 새 대본은 기존 TTS로 만든 뒤, 비교 시험은 기존 음성에서 읽어 채운다. */
export interface VoiceLine {
  beat: number;
  text: string;
  start: number;
  end: number;
  file: string;
  fileIn: number;
  fileOut: number;
}

/** 제작 방식 선택 결과 — 제작 기록(lemo_productions.choice)에 그대로 남긴다. */
export const productionChoiceSchema = z.object({
  backend: z.enum(BACKENDS),
  style: z.string().nullable().describe("lemo-code면 스타일 slug, 아니면 null"),
  render_mode: z.enum(RENDER_MODES).nullable(),
  reason: z.string().describe("계정 분위기 · 대본 흐름 · 필요한 표정과 동작 · 소재 · 일관성 · 비용을 들어 고른 이유"),
  rejected: z.array(z.object({ option: z.string(), why: z.string() })),
  characters: z.array(
    z.object({
      role: z.string(),
      reuse: z.string().nullable().describe("재사용할 라이브러리 캐릭터 id, 새로 만들면 null"),
      why: z.string(),
      // 상품 자료가 있는 영상은 배역 중 하나만 true(select.ts withProductRole). 예전 기록에는 없다
      product: z.boolean().optional().describe("소개하는 상품 자체를 그린 배역이면 true"),
    }),
  ),
  cost_class: z.enum(["low", "mid", "high"]).describe("렌더 시간 · AI 사용량 어림"),
  // 캐릭터가 연기하는 방식(characters)인지 캐릭터 없이 그림 · 도형 · 글자로 설명하는 방식(no-characters)인지 — 고른 스타일의 needs_characters에서 온다. 예전 기록에는 없다
  approach: z.enum(["characters", "no-characters"]).optional(),
  // 캐릭터 그림이 검수에 떨어져 배역을 다시 정한 기록(characters.ts prepareCharacters가 정하고 run.ts가 선택 결과에 붙인다). 예전 기록에는 없다
  recast: z.array(recastSchema()).optional(),
});
export type ProductionChoice = z.infer<typeof productionChoiceSchema>;

/**
 * 배역 다시 정하기 한 건.
 * - reuse: 계정에 저장된(이미 합격한) 캐릭터 to로 바꿨다
 * - object: 몸 모양 6가지로 못 그리는 물건이라 얼굴 달린 캐릭터 대신 화면 속 물건으로 둔다(엔진 소품 · 장면표 화면 글자로 보여 주거나, 그럴 수 없으면 뺀다)
 * - drop: 바꿀 캐릭터가 없어 그 배역을 빼고 장면을 짠다
 */
function recastSchema() {
  return z.object({
    role: z.string(),
    kind: z.enum(["reuse", "object", "drop"]),
    to: z.string().nullable().describe("kind=reuse면 바꾼 라이브러리 캐릭터 id, 아니면 null"),
    why: z.string(),
    fails: z.array(z.string()).describe("그 배역 시트의 불합격 사유(차례대로)"),
  });
}
export type Recast = z.infer<ReturnType<typeof recastSchema>>;

/** 이 영상의 상품 캐릭터 — 배역 계획이 상품 배역으로 재사용한 것, 없으면 그 상품 키(product_id)로 만든 것. 없으면 null. */
export function productCharacter(choice: ProductionChoice, characters: CharacterSpec[], productId: string | null): CharacterSpec | null {
  const reuse = choice.characters.find((c) => c.product)?.reuse;
  return (reuse ? characters.find((c) => c.id === reuse) : undefined) ?? (productId ? characters.find((c) => c.product_id === productId) : undefined) ?? null;
}

/** AI 호출 한 번(또는 같은 단계 묶음)의 사용량. 비용 계산은 usage.ts가 단가표로 한다. */
export interface AiUsage {
  stage: string;
  provider: "openai" | "anthropic" | "fish" | "pixabay" | "other";
  model: string;
  calls: number;
  input: number;
  cached_input: number;
  cache_write: number;
  output: number;
  // 이미지 생성 · 음성 글자 수 · 받아쓰기 초 같은 다른 과금 단위
  units?: Record<string, number>;
}

/** 계정 맥락 — 제작 방식 선택 · 장면 계획이 읽는 값. */
export interface AccountContext {
  accountKey: string;
  accountName: string;
  // account_concepts.auto_notes (말투 · 분위기 · 영상 스타일)
  notes: string | null;
  voiceId: string | null;
  // 계정 라이브러리 account.json 또는 account_concepts의 선호 스타일. 기본값일 뿐 강제하지 않는다
  preferredStyles: string[];
}

/** 계약 검사 — 다른 계정 캐릭터, 없는 표정 · 동작, 음성 시각과 어긋난 장면을 막는다. */
export function productionProblems(p: Production, library: CharacterSpec[], voice: VoiceLine[]): string[] {
  const out: string[] = [];
  const byId = new Map(library.map((c) => [c.id, c]));
  const castOf = new Map(p.cast.map((c) => [c.id, c]));
  for (const c of p.cast) {
    const spec = byId.get(c.character);
    if (!spec) out.push(`캐릭터 ${c.character}가 라이브러리에 없어요`);
    else if (spec.account_key !== p.account_key) out.push(`캐릭터 ${c.character}는 ${spec.account_key} 계정 것이라 ${p.account_key}에 쓸 수 없어요`);
  }
  const bgs = new Set(p.backgrounds.map((b) => b.id));
  let prevEnd = 0;
  for (const s of p.scenes) {
    if (s.end <= s.start) out.push(`${s.id}: 끝이 시작보다 빨라요`);
    if (Math.abs(s.start - prevEnd) > 0.05) out.push(`${s.id}: 앞 장면과 ${(s.start - prevEnd).toFixed(2)}초 비어 있거나 겹쳐요`);
    prevEnd = s.end;
    if (!bgs.has(s.background)) out.push(`${s.id}: 배경 ${s.background}가 없어요`);
    const line = voice.find((v) => v.beat === s.beat);
    if (line && (line.start < s.start - 0.05 || line.start > s.end)) out.push(`${s.id}: ${s.beat}번 음성(${line.start.toFixed(2)}초)이 장면 밖에서 시작해요`);
    for (const a of s.actors) {
      const cast = castOf.get(a.cast);
      const spec = cast ? byId.get(cast.character) : undefined;
      if (!spec) {
        out.push(`${s.id}: 배역 ${a.cast}가 없어요`);
        continue;
      }
      for (const e of [a.expr, a.expr_to]) if (e && !spec.expressions.includes(e)) out.push(`${s.id}: ${spec.name}에게 ${e} 표정이 없어요`);
      if (a.action !== "idle" && !spec.actions.includes(a.action)) out.push(`${s.id}: ${spec.name}에게 ${a.action} 동작이 없어요`);
    }
  }
  if (Math.abs(prevEnd - p.duration) > 0.05) out.push(`마지막 장면 끝(${prevEnd.toFixed(2)})과 영상 길이(${p.duration.toFixed(2)})가 달라요`);
  return out;
}

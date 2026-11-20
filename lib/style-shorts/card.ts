import { z } from "zod";
import { captionLookEditSchema, captionLookSchema, type CaptionLook } from "@/lib/style-shorts/caption-look";

// 스타일 쇼츠(/style-shorts) — 레퍼런스 분석 값과 스타일 카드 형식. 앱 · 워커가 함께 쓴다(Node 전용 모듈을 불러오지 않는다).
//
// 레퍼런스 하나 → ReferenceAnalysis(워커가 코드로 잰 숫자 + 소리 분석 + AI가 화면을 보고 적은 설명)
// 폴더 하나 → StyleCard(레퍼런스들의 공통점). 편집 에이전트(2단계)가 카드를 꼭 따르게 한다.
// 카드의 글(sections)은 사람이 화면에서 고칠 수 있다. 숫자(numbers)는 레퍼런스에서 잰 값이라 읽기만 한다.

export const MAX_REFERENCES = 10;
// 업로드 레퍼런스 한도 — media 버킷 한도(1GB)보다 작게. 레퍼런스는 짧은 릴스라 이 정도면 충분하다
export const MAX_REFERENCE_BYTES = 500 * 1024 * 1024;

// ─── 레퍼런스 하나의 분석 ────────────────────────────────────────────────────

/** earshot timeline에서 고른 소리 사건. kind는 earshot 분류(UI · WHOOSH · RISER · FOLEY · HIT · VOICE …) */
export interface SoundEvent {
  t: number;
  kind: string;
  tag: string;
  overBedDb: number;
}

export interface SoundSection {
  start: number;
  end: number;
  genre: string[];
  mood: string[];
  instruments: string[];
}

export interface SoundAnalysis {
  sections: SoundSection[];
  // 효과음으로 볼 만한 사건(말소리 제외). 많아야 40개
  events: SoundEvent[];
  // 10초당 효과음 수
  sfxPer10s: number;
  // 종류별 개수(UI · WHOOSH …)
  kinds: Record<string, number>;
  tempo: number | null;
  // 박자가 또렷한 음악인지(earshot pulse clarity ≥ 0.15)
  steadyBeat: boolean;
  loudnessLufs: number | null;
  // 컷 가운데 100ms 안에 소리가 함께 들어간 비율(0~1)
  cutsWithSound: number | null;
  hasMusic: boolean;
  hasVoice: boolean;
  // 2026-11-20 추가(예전 분석에는 없다)
  // earshot이 이름 붙일 사건을 다 썼다 — sfxPer10s는 최소값
  sfxCapped?: boolean;
  // 효과음이 바로 앞 소리보다 큰 정도(dB, 중앙값)
  sfxOverBedDb?: number | null;
  truePeakDb?: number | null;
  // 끝 4초 안에 소리를 잠깐 끊었다(끝맺음 직전 음악 멈춤)
  endDrop?: boolean;
  // 배경음악이 바뀐 시각(초, py/music_changes.py, 분석 판 3). 재지 못했으면 null
  musicChanges?: number[] | null;
}

/** 말 사이 빈틈(받아쓰기 낱말 시각으로 코드가 잰 값, 2026-11-20 추가) */
export interface SpeechPauses {
  // 0.6초 넘는 빈틈의 10초당 개수 · 가장 긴 빈틈(초)
  per10s: number;
  maxSec: number;
  // 첫 낱말부터 마지막 낱말까지에서 0.25초 넘는 빈틈의 합 비율(0~1)
  silentShare: number;
}

/** 말 자막 통계(1초마다 본 프레임으로 코드가 센 값, 2026-11-20 추가) */
export interface CaptionStats {
  // 프레임에서 본 서로 다른 자막 수(1초 간격이라 실제보다 적을 수 있다)
  seen: number;
  // 10초당 자막 수 — 말한 글자 수 ÷ 자막 평균 글자 수로 어림한다(말이 없으면 seen으로)
  per10s: number;
  // 자막 하나의 평균 글자 수(띄어쓰기 제외)
  avgChars: number;
  // 한 줄 자막 비율(0~1)
  oneLineShare: number;
  places: Partial<Record<"top" | "mid" | "lower", number>>;
  // 많이 쓴 글자색(많은 순, 4개까지)
  colors: string[];
  // 크게 강조한 자막 비율(0~1)
  bigShare: number;
}

export const visualReadSchema = z.object({
  hook: z.string().describe("첫 3초: 첫 장면 · 첫 화면 글자 · 첫 마디로 어떻게 붙잡는지. 80자 안"),
  pacing: z.string().describe("컷 길이 · 장면 전환 방식 · 리듬. 80자 안"),
  captions: z.string().describe("말 자막의 모양: 위치(위 · 가운데 · 아래), 크기, 글자색 · 테두리 · 상자, 강조 방식, 한 번에 보이는 양, 나타나는 움직임. 자막이 없으면 없다고. 120자 안"),
  captionStyle: z.enum(["sentence", "keyword", "none"]).describe("sentence: 말한 문장을 거의 그대로 · keyword: 짧은 낱말 위주 · none: 말 자막 없음"),
  graphics: z.string().describe("말 자막 말고 화면에 얹은 글자 · 도형 · 스티커 · 화살표 · 숫자 카드 등. 얼마나 자주, 어떤 모양으로. 없으면 없다고. 100자 안"),
  visual: z.string().describe("화면: 촬영 구도(손 · 얼굴 · 제품 가까이), 색감, 밝기, 확대 · 흔들기 같은 움직임, 전환 효과. 100자 안"),
  voice: z.string().describe("말: 내레이션인지, 사람이 직접 말하는지, 말이 없는지, 말투 · 속도. 받아쓰기가 있으면 참고. 80자 안"),
  ending: z.string().describe("끝맺음: 마지막 장면 · 마지막 글자 · 마지막 말. 60자 안"),
  notes: z.string().describe("이 영상만의 특징 한 줄. 40자 안"),
  captionLook: captionLookSchema.describe("말 자막의 모양을 프레임에서 그대로 읽는다. 색은 글자에서 실제로 보이는 색"),
});
export type VisualRead = z.infer<typeof visualReadSchema>;

// ─── 화면 위 글자 · 그래픽 촘촘히 보기(2026-11-19 사용자 결정) ────────────────
// 1초마다 프레임을 보고, 말 자막 말고 화면에 얹은 것(반응 · 속마음 글자, 스티커, 동그라미 · 화살표, 안내 카드)과
// 화면 확대를 적는다. 횟수 · 비율은 코드가 이 표시로 센다(AI가 숫자를 지어내지 않게).

export const OVERLAY_KINDS = ["reaction", "inner_voice", "sticker", "pointer", "info_card", "title"] as const;
export type OverlayKind = (typeof OVERLAY_KINDS)[number];
export const OVERLAY_KIND_LABEL: Record<OverlayKind, string> = {
  reaction: "반응 · 감탄 글자",
  inner_voice: "속마음 · 괄호 글자",
  sticker: "스티커 · 이모지 · 하트",
  pointer: "동그라미 · 화살표",
  info_card: "안내 · 가격 카드",
  title: "제목 글자",
};

export const overlayScanSchema = z.object({
  frames: z
    .array(
      z.object({
        t: z.number().describe("프레임 시각(초). 주어진 시각 그대로"),
        overlays: z
          .array(
            z.object({
              kind: z.enum(OVERLAY_KINDS).describe("reaction 감탄 · 반응 한마디, inner_voice 괄호 · 속마음 · 혼잣말, sticker 하트 · 이모지 · 그림, pointer 동그라미 · 화살표, info_card 가격 · 안내 상자 · 휴대폰 화면 같은 카드, title 큰 제목 글자"),
              text: z.string().describe("보이는 글자 그대로. 글자가 없으면 무엇인지 짧게(예: 하트 두 개)"),
              color: z.string().describe("글자 · 그림의 주된 색 #RRGGBB"),
              place: z.enum(["top", "mid", "lower"]).describe("화면 위 · 가운데 · 아래"),
            }),
          )
          .describe("말 자막(말을 받아 적은 글자)은 넣지 않는다. 없으면 빈 배열"),
        caption: z
          .object({
            text: z.string().describe("보이는 말 자막 글자 그대로"),
            lines: z.number().int().describe("줄 수"),
            color: z.string().describe("글자의 주된 색 #RRGGBB"),
            place: z.enum(["top", "mid", "lower"]).describe("화면 위 · 가운데 · 아래"),
            big: z.boolean().describe("평소 자막보다 눈에 띄게 크게 강조한 자막이면 true"),
          })
          .nullable()
          .describe("이 프레임의 말 자막(사람이 한 말을 받아 적은 글자). 없으면 null"),
        zoomed: z.boolean().describe("바로 앞 프레임과 같은 장면인데 화면을 확대해 더 가깝게 잡았으면 true"),
      }),
    )
    .describe("받은 프레임마다 하나씩"),
});
export type OverlayScan = z.infer<typeof overlayScanSchema>;

/** 레퍼런스 하나의 화면 위 글자 · 그래픽 통계(코드가 overlayScan으로 센 값) */
export interface OverlayStats {
  // 새로 나타난 화면 위 요소 수(같은 글자가 이어지면 하나로 센다)
  count: number;
  per10s: number;
  kinds: Partial<Record<OverlayKind, number>>;
  // 많이 쓴 색(많은 순, 4개까지)
  colors: string[];
  places: Partial<Record<"top" | "mid" | "lower", number>>;
  // 화면 확대가 시작된 횟수
  zooms: number;
  zoomPer10s: number;
  // 마지막 3초에 안내 카드가 있는지
  endCard: boolean;
  // 글자 예(형식 참고용, 8개까지)
  examples: { kind: OverlayKind; text: string; color: string }[];
}

// 분석 형식 판. 올리면 카드 다시 만들기가 이 판보다 오래된 레퍼런스를 다시 분석한다
// 2: 말 사이 빈틈 · 말 자막 · 효과음 크기 · 끝 직전 음악 끊김(2026-11-20)
// 3: 배경음악이 바뀐 시각(2026-11-20)
export const ANALYSIS_VERSION = 3;

export interface ReferenceAnalysis {
  // 분석 형식 판(ANALYSIS_VERSION). 2026-11-20 전 분석에는 없다
  version?: number;
  durationSec: number;
  // 화면 위 글자 · 그래픽(2026-11-19 추가). 그 전에 분석한 레퍼런스는 없다
  overlays?: OverlayStats | null;
  // 컷 시각(초). 화면이 크게 바뀐 곳을 코드가 잰 값
  cuts: number[];
  avgShotSec: number | null;
  cutsPer10s: number;
  first3sCuts: number;
  // chars · pauses는 2026-11-20 추가(예전 분석에는 없다)
  speech: { has: boolean; transcript: string; charsPerSec: number | null; chars?: number; pauses?: SpeechPauses | null };
  // 말 자막 통계(2026-11-20 추가)
  captions?: CaptionStats | null;
  sound: SoundAnalysis | null;
  // 소리를 분석하지 못한 이유(소리 없음 · 도구 실패)
  soundNote: string | null;
  read: VisualRead;
  caption: string | null;
}

// ─── 폴더의 스타일 카드 ──────────────────────────────────────────────────────

export const CARD_SECTIONS = [
  { key: "hook", title: "후킹 (첫 3초)" },
  { key: "pacing", title: "컷 · 속도" },
  { key: "captions", title: "자막" },
  { key: "graphics", title: "화면 글자 · 그래픽" },
  { key: "visual", title: "화면 · 움직임" },
  { key: "sound", title: "효과음 · 음악" },
  { key: "voice", title: "말 · 말투" },
  { key: "ending", title: "끝맺음" },
  { key: "rules", title: "꼭 지킬 것" },
] as const;
export type CardSectionKey = (typeof CARD_SECTIONS)[number]["key"];

export const CARD_TEXT_MAX = 400;

export interface StyleCardNumbers {
  // 레퍼런스 수 · 영상까지 분석한 수
  references: number;
  videoReferences: number;
  durationSec: [number, number] | null;
  avgShotSec: number | null;
  cutsPer10s: number | null;
  sfxPer10s: number | null;
  tempo: number | null;
  captionStyle: "sentence" | "keyword" | "none" | "mixed";
  // 효과음 종류별 비율(0~1), 많은 순
  sfxKinds: { kind: string; share: number }[];
  // 화면 위 글자 · 그래픽(2026-11-19 추가). 예전 카드에는 없다
  overlayPer10s?: number | null;
  overlayKinds?: { kind: OverlayKind; share: number }[];
  overlayColors?: string[];
  zoomPer10s?: number | null;
  // 안내 카드로 끝나는 레퍼런스 비율(0~1)
  endCardShare?: number | null;
  overlayExamples?: { kind: OverlayKind; text: string; color: string }[];
  // 2026-11-20 추가(예전 카드에는 없다)
  // 효과음 수가 최소값인지(earshot이 이름 붙일 사건을 다 쓴 레퍼런스가 있다)
  sfxIsMin?: boolean;
  sfxOverBedDb?: number | null;
  loudnessLufs?: number | null;
  // 끝 직전에 음악을 끊은 레퍼런스 비율(0~1)
  endDropShare?: number | null;
  // 말: 초당 글자 · 0.6초 넘는 빈틈 10초당 · 가장 긴 빈틈 · 빈틈 비율
  charsPerSec?: number | null;
  pausePer10s?: number | null;
  maxPauseSec?: number | null;
  silentShare?: number | null;
  // 말 자막: 10초당 수 · 평균 글자 수 · 한 줄 비율 · 많이 쓴 자리 · 색 · 크게 강조한 비율
  captionPer10s?: number | null;
  captionChars?: number | null;
  captionOneLine?: number | null;
  captionPlace?: "top" | "mid" | "lower" | null;
  captionColors?: string[];
  captionBigShare?: number | null;
  // 배경음악: 곡을 바꾼 레퍼런스 비율(0~1) · 바꾼 위치(영상 길이 대비 0~1, 첫 번째 · 두 번째 바뀜의 중앙값)
  musicChangeShare?: number | null;
  musicChangeAt?: number[];
}

export interface StyleCard {
  summary: string;
  sections: Record<CardSectionKey, string>;
  // Openverse에서 BGM을 찾을 영어 검색어 · 분위기 설명(사람이 고칠 수 있다)
  music: { query: string; mood: string };
  // 레퍼런스 자막 모양. 2026-11-19 이전에 만든 카드에는 없다(다시 만들기로 채운다)
  captionLook?: CaptionLook | null;
  numbers: StyleCardNumbers;
  // 카드가 만들어진 시각 · 사람이 고친 시각
  builtAt: string;
  editedAt: string | null;
}

/** AI가 카드 글을 쓸 때의 답 형식 */
export const cardWriteSchema = z.object({
  summary: z.string().describe("이 스타일을 한 문장으로. 40자 안"),
  hook: z.string().describe(`첫 3초를 어떻게 만드는지. 편집자가 그대로 따라 할 수 있게 구체적으로. ${CARD_TEXT_MAX}자 안`),
  pacing: z.string().describe(`컷 길이 · 전환 · 리듬. 숫자는 통계에 있는 값만. ${CARD_TEXT_MAX}자 안`),
  captions: z.string().describe(`말 자막의 위치 · 크기 · 색 · 테두리 · 상자 · 강조 · 움직임 · 한 번에 보이는 양. ${CARD_TEXT_MAX}자 안`),
  graphics: z.string().describe(`화면 글자 · 도형 · 스티커 · 숫자 카드를 언제 어떻게 쓰는지. ${CARD_TEXT_MAX}자 안`),
  visual: z.string().describe(`촬영 구도 · 색감 · 확대 · 흔들기 · 전환 효과. ${CARD_TEXT_MAX}자 안`),
  sound: z.string().describe(`효과음을 어디에 어떤 종류로 얼마나 자주 넣는지, 음악의 분위기 · 빠르기 · 크기. 숫자는 통계에 있는 값만. ${CARD_TEXT_MAX}자 안`),
  voice: z.string().describe(`내레이션 · 직접 말하기 · 말투 · 속도. ${CARD_TEXT_MAX}자 안`),
  ending: z.string().describe(`끝맺음. ${CARD_TEXT_MAX}자 안`),
  rules: z.array(z.string()).describe("편집할 때 꼭 지킬 것 4~8개. 한 줄 60자 안. 레퍼런스들에 공통으로 보인 것만"),
  musicQuery: z.string().describe("Openverse에서 배경음악을 찾을 영어 검색어 2~4낱말. 장르 · 분위기 · 악기. 예: upbeat acoustic pop"),
  musicMood: z.string().describe("배경음악 분위기를 한국어로. 40자 안"),
  captionLook: captionLookSchema.describe("레퍼런스들의 말 자막 모양 가운데 가장 많이 보인 것. 레퍼런스마다 다르면 가장 많은 쪽을 고르고 captions 글에 다른 점을 적는다"),
});
export type CardWrite = z.infer<typeof cardWriteSchema>;

/** 화면에서 고친 카드 글 — 저장 전에 검사 */
export const cardEditSchema = z.object({
  summary: z.string().trim().min(1).max(80),
  sections: z.object(Object.fromEntries(CARD_SECTIONS.map((s) => [s.key, z.string().trim().max(CARD_TEXT_MAX * 2)])) as Record<CardSectionKey, z.ZodString>),
  music: z.object({ query: z.string().trim().min(1).max(80), mood: z.string().trim().max(80) }),
  captionLook: captionLookEditSchema.nullable().optional(),
});
export type CardEdit = z.infer<typeof cardEditSchema>;

// ─── 화면 표시 ────────────────────────────────────────────────────────────────

export const REFERENCE_STATUS: Record<string, { label: string; variant: "secondary" | "default" | "ok" | "destructive" | "warn" }> = {
  PENDING: { label: "분석 대기", variant: "secondary" },
  ANALYZING: { label: "분석 중", variant: "default" },
  DONE: { label: "분석 완료", variant: "ok" },
  FAILED: { label: "분석 실패", variant: "destructive" },
};

export const CARD_STATUS: Record<string, { label: string; variant: "secondary" | "default" | "ok" | "destructive" | "warn" }> = {
  EMPTY: { label: "레퍼런스 없음", variant: "secondary" },
  PENDING: { label: "카드 만들기 대기", variant: "secondary" },
  ANALYZING: { label: "카드 만드는 중", variant: "default" },
  READY: { label: "카드 완성", variant: "ok" },
  FAILED: { label: "카드 실패", variant: "destructive" },
};

/** earshot 분류를 화면 말로 */
export const SFX_KIND_LABEL: Record<string, string> = {
  UI: "팝 · 알림음",
  WHOOSH: "휙 (전환)",
  RISER: "상승음",
  HIT: "타격음",
  FOLEY: "생활 소리",
  IMPACT: "충격음",
  GLITCH: "글리치",
  CLICK: "클릭",
  KEY: "타자 소리",
  BELL: "종 · 딩",
  DROP: "떨어지는 저음",
  NOTE: "짧은 음 · 멜로디",
  DRUM: "북 · 드럼",
};

export function sfxKindLabel(kind: string): string {
  return SFX_KIND_LABEL[kind] ?? kind.toLowerCase();
}

/** 인스타 릴스 주소에서 계정 아이디 · 짧은 코드를 꺼낸다. /reel/ · /reels/ · /p/ 모두 받는다. */
export function parseInstagramUrl(raw: string): { permalink: string; shortcode: string; username: string | null } | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!/^(www\.)?instagram\.com$/i.test(url.hostname)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const i = parts.findIndex((p) => p === "reel" || p === "reels" || p === "p");
  if (i < 0 || !parts[i + 1]) return null;
  const shortcode = parts[i + 1];
  if (!/^[A-Za-z0-9_-]{5,40}$/.test(shortcode)) return null;
  const before = i > 0 ? parts[i - 1] : null;
  const username = before && /^[A-Za-z0-9._]{1,30}$/.test(before) ? before.toLowerCase() : null;
  return { permalink: `https://www.instagram.com/reel/${shortcode}/`, shortcode, username };
}

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { conceptBlock } from "@/lib/agents/concept";
import { agentModel } from "@/lib/agents/runner";
import { getOpenAI } from "@/lib/openai";
import { callOptions } from "@/lib/products/analysis/analyze";
import { readableRows, ZONE_BOX, type Look, type Zone } from "@/lib/shoot/video-kit/caption-style";
import { chosenFonts, FONT_PAIRING_RULES, fontChoiceLines, fontWeight, loadSkillFonts, type SkillFont } from "@/lib/shoot/video-kit/skill-fonts";
import type { TimedCaption } from "@/lib/shoot/video-kit/timeline";
import { mediaSeconds } from "@/lib/shoot/video-kit/tools";

// 자막 모션 스킬 연결(2026-11-05 사용자 결정). 스킬은 구매한 사용자의 유료 자료라 저장소에 넣지 않는다.
// 러너는 비공개 저장 공간에서 받고(worker/fetch-caption-skill.ts), 이 PC는 설치된 폴더를 쓴다. 효과 설명 · 글꼴 목록도 실행할 때 스킬 폴더에서 읽는다.
// 영상마다 AI가 제품 화면과 계정 분위기를 보고 대표 모션을 고르고, 말의 내용에 더 맞는 줄만 다른 모션을 쓴다(2026-11-05 사용자 결정).
// 스킬의 디자인 자막처럼 큰 강조어 줄과 작은 줄을 쌓는다. 글꼴도 영상마다 AI가 스킬 글꼴 중에서 고른다(사용자 결정, skill-fonts.ts). AI는 모션 · 글꼴 · 줄 나누기만 고르고, 글자와 시각은 코드가 편집 결과와 대조해 그대로 넣는다.

// 글자 자체가 움직이는 효과만 영상 자막에 쓸 수 있다(스킬 안내). 사물이 나오는 장면 번호는 쓰지 않는다
// 천천히 드러나는 효과(29 · 33 · 37)는 글자가 말보다 늦게 읽혀 쓰지 않는다
const MOTION_FX = ["04", "06", "07", "08", "10", "13", "18", "19", "20", "22", "32", "36", "38", "39", "41"];
const EMOTION_FX = ["sway", "shiver", "heartbeat", "tilt", "hop", "droop", "impact"];
const ALLOWED_FX = new Set(["cut", ...MOTION_FX, ...EMOTION_FX]);
export const isMotionEffect = (value: string): boolean => value !== "cut" && ALLOWED_FX.has(value);
// 손글씨 작은 줄은 글자 몸통이 작아 키운다
const SMALL_SIZE = 96;
const PLAIN_SMALL_SIZE = 80;
const KEY_MAX = 132;
const KEY_WIDTH = 900;
const ROW_GAP = 18;
// 자막 자리의 평균 밝기(0~255)가 이보다 높으면 어두운 글자를 쓴다
const BRIGHT = 150;
const DARK_TEXT = "#1B1F27";

export function captionSkillDir(): string | null {
  const dir = process.env.CAPTION_SKILL_DIR || join(homedir(), ".claude", "skills", "caption-motion-seqc");
  return existsSync(join(dir, "scripts", "subs.cjs")) && existsSync(join(dir, "node_modules")) ? dir : null;
}

const designSchema = z.object({
  key_fx: z.enum([...MOTION_FX, ...EMOTION_FX]).describe("이 영상의 대표 모션. 큰 강조어 줄의 기본이다. 정지 자막 cut은 고르지 않는다"),
  small_fx: z.string().describe("작은 줄 모션. 대표 모션을 돋보이게 하는 부드러운 효과나 cut"),
  finish_fx: z.string().describe("마지막 자막에만 쓰는 모션. 대표 모션과 같아도 된다"),
  key_font: z.string().describe("큰 강조어 줄 글꼴. 쓸 수 있는 글꼴 목록의 이름 그대로"),
  small_font: z.string().describe("작은 줄 글꼴. 쓸 수 있는 글꼴 목록의 이름 그대로"),
  reading: z.string().describe("제품과 분위기를 어떻게 보고 이 모션과 글꼴을 골랐는지 한 줄"),
  lines: z
    .array(
      z.object({
        no: z.number().int().describe("자막 번호(0부터)"),
        rows: z
          .array(z.object({ text: z.string(), role: z.enum(["key", "small"]) }))
          .describe("자막을 위에서 아래로 나눈 1~2줄. 이어 붙이면 자막과 글자가 같아야 한다. 핵심 낱말이 key"),
        fx: z.string().describe("이 자막의 내용에 대표 모션보다 뚜렷하게 맞는 모션이 있을 때만 번호나 이름. 없으면 빈 문자열"),
        spark: z.boolean().describe("이 자막의 강조어에 반짝이 장식을 붙일지. 영상 전체에서 2~3번만"),
      }),
    )
    .describe("자막마다 하나"),
});
export type CaptionDesign = z.infer<typeof designSchema>;

function effectNotes(dir: string): string {
  const text = readFileSync(join(dir, "references", "effects.md"), "utf8");
  return text
    .split("\n")
    .filter((l) => MOTION_FX.some((n) => l.startsWith(`| ${n} |`)))
    .join("\n");
}

/** 계정 설정과 자막을 읽어 효과 · 글꼴을 고른다. */
export async function designCaptions(input: {
  dir: string;
  captions: TimedCaption[];
  product: { name: string; kind: string; oneLine: string | null };
  frames: string;
  look: Look;
  tone?: string | null;
  styleText?: string | null;
}): Promise<{ design: CaptionDesign; tokens: { input: number; output: number } }> {
  const model = agentModel();
  const completion = await getOpenAI().chat.completions.parse({
    model,
    ...callOptions(model, 3000),
    messages: [
      {
        role: "system",
        content: `너는 인스타 릴스 자막 디자이너다. 이 영상의 자막마다 움직임을 고른다. 글자는 바꾸지 않는다.
규칙:
- 자막마다 한 컷짜리 포스터처럼 만든다. 곁들이는 말은 작은 줄, 핵심 낱말은 큰 줄로 나눈다. 글자를 바꾸거나 빼거나 더하지 않는다. 짧은 자막은 key 한 줄이어도 된다.
- 먼저 그림의 제품과 장면, 상품 설명, 계정 설정을 보고 이 영상에 어울리는 대표 모션 하나를 고른다. 차분한 고급 제품에 튀는 모션을, 발랄한 먹거리에 무거운 모션을 쓰지 않는다.
- 글꼴도 이 영상의 제품 · 장면 · 말의 내용 · 계정 분위기에 맞게 고른다. 큰 강조어 줄 글꼴 하나와 작은 줄 글꼴 하나만 쓴다. 습관처럼 같은 글꼴을 고르지 않는다. 자막은 짧게 지나가므로 한 번에 읽혀야 한다.
${FONT_PAIRING_RULES.map((r) => `- ${r}`).join("\n")}
- 자막의 기본은 대표 모션이다. 말의 내용과 뚜렷하게 맞는 줄만 fx로 바꾼다: 궁금증 · 숫자 · 성분 이름 · 주의 · 반전처럼 내용이 분명한 줄이다. 바꾸는 줄은 전체의 3분의 1 이내로 두고, 효과 설명의 "어울리는 문구"를 참고한다.
- 감정 효과의 뜻: sway 여유 · 기분 좋음, shiver 긴장 · 주의, heartbeat 설렘, tilt 궁금함, hop 놀람, droop 아쉬움, impact 강한 한마디. 그 감정이 말에 있을 때만 쓴다.
쓸 수 있는 효과:
${effectNotes(input.dir)}
감정 효과: ${EMOTION_FX.join(", ")}
쓸 수 있는 글꼴(이름 · 종류 · 인상 · 굵기):
${fontChoiceLines(loadSkillFonts(input.dir))}${conceptBlock("이 계정의 말투 · 분위기", input.tone, "효과 세기와 글꼴에 반영한다.")}${conceptBlock("이 계정의 영상 스타일", input.styleText, "자막 움직임과 글꼴에 맞으면 반영한다.")}`,
      },
      {
        role: "user",
        content: [
          { type: "text", text: `상품: ${input.product.name} (${input.product.kind})${input.product.oneLine ? ` — ${input.product.oneLine}` : ""}\n\n자막:\n${input.captions.map((c, i) => `${i}. "${c.text}" (${(c.end - c.start).toFixed(1)}초)`).join("\n")}\n\n그림은 이 영상의 장면을 차례로 모은 것이다.` },
          { type: "image_url", image_url: { url: input.frames, detail: "high" } },
        ],
      },
    ],
    response_format: zodResponseFormat(designSchema, "caption_design"),
  });
  const parsed = completion.choices[0]?.message?.parsed;
  if (!parsed) throw new Error("자막 디자인 응답이 비어 있음");
  return {
    design: parsed,
    tokens: { input: completion.usage?.prompt_tokens ?? 0, output: completion.usage?.completion_tokens ?? 0 },
  };
}

const squash = (t: string) => t.replace(/\s+/g, "");

/** 글자 폭에 맞춘 강조어 크기. 한 줄이 화면을 넘지 않게 한다. */
function keySize(text: string): number {
  const units = [...text].reduce((sum, c) => sum + (c === " " ? 0.3 : /[가-힣]/.test(c) ? 1 : 0.62), 0);
  return Math.round(Math.min(KEY_MAX, Math.max(SMALL_SIZE, KEY_WIDTH / Math.max(units, 1))));
}

function fx(value: string): string {
  return ALLOWED_FX.has(value) ? value : "cut";
}

/** 스킬에 넘기는 글꼴. 굵기가 null이면 지정하지 않는다(한 굵기뿐인 글꼴). */
export interface SubtitleFonts {
  key: string;
  small: string;
  smallSize: number;
  keyWeight?: number | null;
  smallWeight?: number | null;
}

// 스킬은 강조어 줄(key) 굵기를 따로 받지 않으면 400으로 그린다(subs.cjs). 도식 · 끝 화면은 같은 글꼴의 가장 굵은 파일을 쓰므로,
// 굵기를 넘기지 않으면 같은 글꼴이 자막에선 가늘고 도식에선 굵게 나와 서로 다른 글꼴처럼 보인다.
const keyWeightOf = (fonts: SubtitleFonts) => (fonts.keyWeight ? { weight: fonts.keyWeight } : {});

/** AI가 나눈 줄이 자막과 글자가 다르면 쓰지 않고 자막 전체를 큰 줄 하나로 둔다. */
function rowsOf(c: TimedCaption, line: CaptionDesign["lines"][number] | undefined, design: CaptionDesign, last: boolean, bright: boolean, fonts: SubtitleFonts) {
  const usable = line && line.rows.length > 0 && line.rows.length <= 2 && squash(line.rows.map((r) => r.text).join("")) === squash(c.text);
  const rows = usable ? line.rows : readableRows(c.text).map((text) => ({ text, role: "key" as const }));
  const delays = rowDelays(c, rows.map((r) => r.text));
  return rows.map((r, i) => ({
    text: r.text.trim(),
    fx: r.role === "key" ? (line?.fx && ALLOWED_FX.has(line.fx) ? line.fx : fx(last ? design.finish_fx : design.key_fx)) : fx(design.small_fx),
    size: r.role === "key" ? keySize(r.text.trim()) : fonts.smallSize,
    ...(r.role === "key" ? { key: true, ...keyWeightOf(fonts), ...(bright ? {} : { tone: "hi" }) } : {}),
    // 밝은 배경에서는 흰 글자와 노란 강조색이 안 읽혀 어두운 글자와 밝은 그림자로 바꾼다
    ...(bright ? { color: DARK_TEXT, glow: "rgba(255,255,255,.75)" } : {}),
    ...(i > 0 ? { gapPx: ROW_GAP } : {}),
    ...(delays[i] ? { delay: delays[i] } : {}),
  }));
}

// 두 줄 짝의 아랫줄이 나오기 전에 남길 최소 간격과, 나온 뒤 읽을 최소 시간(초)
const MIN_ROW_DELAY = 0.2;
const MIN_ROW_SHOW = 0.5;

/**
 * 두 줄 짝은 줄마다 그 말을 하는 시각에 나오게 한다(스킬 안내 「줄마다 말 시각에 맞춰 delay」).
 * 주지 않으면 두 줄이 자막 시작에 함께 나오고, 짧은 등장 하나가 끝나면 자막이 멈춘 채로 남는다.
 * 줄 안의 말 시각은 모르므로 글자 수 비율로 나눈다(caption-style의 낱말 등장과 같은 방식). 너무 짧으면 함께 나온다.
 */
export function rowDelays(c: Pick<TimedCaption, "start" | "end">, rows: string[]): number[] {
  const out = rows.map(() => 0);
  if (rows.length !== 2) return out;
  const span = c.end - c.start;
  const total = squash(rows.join("")).length;
  const lead = Math.min((span * squash(rows[0]).length) / Math.max(total, 1), span - MIN_ROW_SHOW);
  if (lead >= MIN_ROW_DELAY) out[1] = Number(lead.toFixed(2));
  return out;
}

/** 후킹 글자 · 끝 화면 · 표지처럼 말 자막이 아닌 글자. 글자를 바꾸지 않고 줄만 나눈다. */
export interface SkillBlock {
  start: number;
  end: number;
  zone: Zone;
  rows: { text: string; role: "key" | "small" }[];
  fx: string;
  highlight?: string;
}

/** 긴 문구를 글자 수에 맞춰 줄로 나눈다. 줄바꿈이 있으면 그대로 따른다. */
export function blockRows(text: string, role: "key" | "small" = "key", chars = 13): SkillBlock["rows"] {
  const out: string[] = [];
  for (const part of text.split(/\n+/).map((p) => p.trim()).filter(Boolean)) {
    let line = "";
    for (const word of part.split(/\s+/)) {
      if (line && squash(line + word).length > chars) {
        out.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    if (line) out.push(line);
  }
  return out.map((t) => ({ text: t, role }));
}

function blockLine(b: SkillBlock, bright: boolean, fonts: SubtitleFonts) {
  const box = ZONE_BOX[b.zone];
  return {
    t0: Number(b.start.toFixed(3)),
    t1: Number(b.end.toFixed(3)),
    cy: box.top + Math.round(box.height / 2),
    rows: b.rows.map((r, i) => {
      const marked = b.highlight && r.text.includes(b.highlight) && !r.text.includes("*") ? r.text.replace(b.highlight, `*${b.highlight}*`) : r.text;
      return {
        text: marked,
        fx: r.role === "key" ? fx(b.fx) : "cut",
        size: r.role === "key" ? keySize(r.text) : fonts.smallSize,
        ...(r.role === "key" ? { key: true, ...keyWeightOf(fonts) } : {}),
        ...(bright ? { color: DARK_TEXT, glow: "rgba(255,255,255,.75)" } : {}),
        ...(i > 0 ? { gapPx: ROW_GAP } : {}),
      };
    }),
  };
}

/** 편집 결과의 시각 · 글자를 그대로 쓰는 자막 파일 내용. */
export function buildSubtitleFile(video: string, captions: TimedCaption[], zones: Zone[], design: CaptionDesign, brightness: (number | null)[] = [], blocks: SkillBlock[] = [], blockBrightness: (number | null)[] = [], fonts: SubtitleFonts = { key: "그리운 코코초이툰", small: "온글잎 박다현체", smallSize: SMALL_SIZE }) {
  const byNo = new Map(design.lines.map((l) => [l.no, l]));
  // 작은 줄은 스킬 기본 굵기(본문 800)가 아니라 고른 글꼴의 보통 굵기로. 굵기가 여럿인 글꼴이 작은 줄에서 강조어보다 굵어지지 않게 한다
  const smallWeight = fonts.smallWeight ? { weight: fonts.smallWeight, subWeight: fonts.smallWeight } : {};
  return {
    video,
    size: "9:16",
    // 효과 속도는 스킬의 자동 속도에 맡긴다(speed를 주지 않음 = 1배). 스킬이 줄마다 다음 컷 · 자막 끝까지 남은 시간을 재서
    // 등장이 그 앞쪽에서 끝나게 속도를 올린다. 여기서 배수를 또 주면 두 배수가 곱해져(예: 1.6 × 2.2 = 3.5배) 등장이 0.1~0.3초로 끝나
    // 글자가 움찔하고 멈춘 것처럼 보인다(2026-11-09 시험 영상 첫 자막 2.80~2.87초).
    // 밝은 제품 사진 위에서도 읽히게 그림자를 스킬 기본보다 진하게 둔다
    // 글자 색은 스킬 기본값을 쓴다. look 색은 글자 상자가 있을 때 고른 값이라 그대로 쓰면 빨간 배경에 초록 글자처럼 나온다
    // 강조어 줄은 keyFont, 나머지 줄은 font. subFont까지 같게 해 한 영상에 글꼴을 두 개만 쓴다
    style: { font: fonts.small, subFont: fonts.small, keyFont: fonts.key, ...smallWeight, size: fonts.smallSize, color: "#FFFFFF", accent: "#FFD23F", glow: "rgba(0,0,0,.62)", glowR: 14, shadowY: 6, maxW: 880 },
    lines: [...blocks.map((b, i) => blockLine(b, (blockBrightness[i] ?? 0) > BRIGHT, fonts)), ...captions.map((c, i) => {
      const line = byNo.get(i);
      const box = ZONE_BOX[zones[i] ?? "lower"];
      const rows = rowsOf(c, line, design, i === captions.length - 1, (brightness[i] ?? 0) > BRIGHT, fonts);
      const keyRow = rows.findIndex((r) => "key" in r);
      return {
        t0: Number(c.start.toFixed(3)),
        t1: Number(c.end.toFixed(3)),
        cy: box.top + Math.round(box.height / 2),
        rows,
        // 반짝이는 강조어 줄이 나온 뒤에 붙인다(스킬 기본: 자막 시작 0.15초 뒤)
        ...(line?.spark && keyRow >= 0 ? { deco: [{ type: "spark", at: Number(((rows[keyRow].delay ?? 0) + 0.15).toFixed(2)), items: [{ row: keyRow, corner: "tr", s: 44 }] }] } : {}),
      };
    })].sort((a, b) => a.t0 - b.t0),
  };
}

/** 자막이 놓일 자리의 평균 밝기. 재지 못한 자막은 null(어두운 배경으로 본다). */
export function readableBrightness(pixels: Uint8Array): number | null {
  if (!pixels.length) return null;
  const mean = pixels.reduce((sum, n) => sum + n, 0) / pixels.length;
  const spread = Math.sqrt(pixels.reduce((sum, n) => sum + (n - mean) ** 2, 0) / pixels.length);
  // 흰 펌프와 붉은 배경처럼 명암이 섞이면 평균만 보고 검은 글자로 바꾸지 않는다.
  return spread > 35 ? null : mean;
}

function zoneBrightness(video: string, captions: TimedCaption[], zones: Zone[]): (number | null)[] {
  return captions.map((c, i) => {
    const box = ZONE_BOX[zones[i] ?? "lower"];
    const res = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-ss", ((c.start + c.end) / 2).toFixed(3), "-i", video, "-frames:v", "1", "-vf", `crop=960:${box.height}:60:${box.top},scale=16:16,format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 1024 * 1024 });
    return res.status === 0 && res.stdout?.length ? readableBrightness(res.stdout) : null;
  });
}

/** 고른 짝을 스킬에 넘길 이름 · 크기 · 굵기로. 굵기는 도식 · 끝 화면(downloadVideoFonts)과 같은 값이다. */
export function pickSubtitleFonts(list: SkillFont[], design: Pick<CaptionDesign, "key_font" | "small_font">): SubtitleFonts {
  const picked = chosenFonts(list, design);
  return {
    key: picked.key.name,
    small: picked.small.name,
    smallSize: picked.small.role === "손글씨" ? SMALL_SIZE : PLAIN_SMALL_SIZE,
    keyWeight: fontWeight(picked.key, true),
    smallWeight: fontWeight(picked.small, false),
  };
}

export interface CaptionOverlayInput { dir: string; video: string; captions: TimedCaption[]; zones: Zone[]; design: CaptionDesign; workDir: string; blocks?: SkillBlock[]; name?: string }

/** 프로덕션 렌더와 미리보기가 같은 모션·글꼴·시각 파일을 쓴다. */
export function prepareCaptionFile(input: CaptionOverlayInput): string {
  const work = join(input.workDir, "caption-skill");
  mkdirSync(work, { recursive: true });
  const file = join(work, `${input.name ?? "subs"}.json`);
  const blocks = input.blocks ?? [];
  const blockBrightness = zoneBrightness(input.video, blocks.map((b) => ({ id: "", text: "", emphasis: [], beat: 0, start: b.start, end: Math.min(b.end, b.start + 1) })), blocks.map((b) => b.zone));
  const brightness = zoneBrightness(input.video, input.captions, input.zones);
  writeFileSync(file, JSON.stringify(buildSubtitleFile(input.video, input.captions, input.zones, input.design, brightness, blocks, blockBrightness, pickSubtitleFonts(loadSkillFonts(input.dir), input.design))));
  return file;
}

/** 소리까지 있는 영상 위에 모션 자막을 얹는다. 실패 정책은 호출하는 쪽에서 결정한다. */
export function overlayCaptions(input: CaptionOverlayInput): string {
  const file = prepareCaptionFile(input);
  const out = join(input.workDir, `${input.name ?? "final"}-captioned.mp4`);
  const res = spawnSync(process.execPath, [join(input.dir, "scripts", "subs.cjs"), file, "--out", out], {
    encoding: "utf8",
    timeout: 20 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CMS_NO_UPDATE_CHECK: "1" },
  });
  if (res.status !== 0) throw new Error(`자막 모션 렌더 실패: ${(res.stderr || String(res.error ?? "")).slice(-300)}`);
  // 글꼴을 못 불러오면 스킬이 엉뚱한 글꼴로 그리고 넘어간다. 호출하는 쪽이 대체 글꼴 자막으로 다시 만든다
  if (`${res.stdout}${res.stderr}`.includes("못 불러온 폰트")) throw new Error("자막 모션 렌더에서 글꼴을 불러오지 못했어요");
  if (!existsSync(out)) throw new Error("자막 모션 결과가 없어요");
  const before = mediaSeconds(input.video);
  const after = mediaSeconds(out);
  if (Math.abs(before - after) > 0.3) throw new Error(`자막 모션 결과 길이가 달라요 (${before.toFixed(1)}초 → ${after.toFixed(1)}초)`);
  return out;
}

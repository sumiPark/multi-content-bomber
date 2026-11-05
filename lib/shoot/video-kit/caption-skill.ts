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
import { ZONE_BOX, type Look, type Zone } from "@/lib/shoot/video-kit/caption-style";
import type { TimedCaption } from "@/lib/shoot/video-kit/timeline";
import { mediaSeconds } from "@/lib/shoot/video-kit/tools";

// 자막 모션 스킬 연결(2026-11-05 사용자 결정). 스킬은 구매한 사용자의 유료 자료라 저장소에 넣지 않는다.
// 러너는 비공개 저장 공간에서 받고(worker/fetch-caption-skill.ts), 이 PC는 설치된 폴더를 쓴다. 효과 설명 · 글꼴 목록도 실행할 때 스킬 폴더에서 읽는다.
// 스킬의 디자인 자막을 쓴다: 자막마다 큰 강조어 줄과 작은 줄을 쌓고 줄마다 효과를 다르게 준다.
// AI는 줄 나누기 · 효과 · 글꼴만 고른다. 글자와 시각은 코드가 편집 결과와 대조해 그대로 넣는다.

// 글자 자체가 움직이는 효과만 영상 자막에 쓸 수 있다(스킬 안내). 사물이 나오는 장면 번호는 쓰지 않는다
const MOTION_FX = ["04", "06", "07", "08", "10", "13", "18", "19", "20", "22", "29", "32", "33", "36", "37", "38", "39", "41", "42"];
const EMOTION_FX = ["sway", "shiver", "heartbeat", "tilt", "hop", "droop", "impact"];
const ALLOWED_FX = new Set(["cut", ...MOTION_FX, ...EMOTION_FX]);
const DEFAULT_FONT = "프리텐다드";
const SMALL_SIZE = 66;
const KEY_MAX = 150;
const KEY_WIDTH = 900;

export function captionSkillDir(): string | null {
  const dir = process.env.CAPTION_SKILL_DIR || join(homedir(), ".claude", "skills", "caption-motion-seqc");
  return existsSync(join(dir, "scripts", "subs.cjs")) && existsSync(join(dir, "node_modules")) ? dir : null;
}

const designSchema = z.object({
  key_font: z.string().describe("큰 강조어 글꼴. 목록의 이름 그대로, 눈에 띄는 굵은 글꼴"),
  small_font: z.string().describe("작은 줄 글꼴. 목록의 이름 그대로, 강조어와 성격이 다른 글꼴"),
  reading: z.string().describe("이 설정과 상품을 어떻게 읽어 이렇게 골랐는지 한 줄"),
  lines: z
    .array(
      z.object({
        no: z.number().int().describe("자막 번호(0부터)"),
        rows: z
          .array(z.object({ text: z.string(), role: z.enum(["key", "small"]), fx: z.string().describe("효과 번호나 이름. 바로 나오게 하려면 cut") }))
          .describe("자막을 위에서 아래로 나눈 1~2줄. 이어 붙이면 자막과 글자가 같아야 한다. 핵심 낱말이 key"),
        spark: z.boolean().describe("이 자막의 강조어에 반짝이 장식을 붙일지. 영상 전체에서 2~3번만"),
      }),
    )
    .describe("자막마다 하나"),
});
export type CaptionDesign = z.infer<typeof designSchema>;

function fontNames(dir: string): { name: string; role: string; look: string }[] {
  const raw = JSON.parse(readFileSync(join(dir, "references", "fonts.json"), "utf8")) as { name: string; lang?: string; role?: string; look?: string }[] | { fonts?: { name: string; lang?: string; role?: string; look?: string }[] };
  const list = Array.isArray(raw) ? raw : (raw.fonts ?? []);
  // 자막은 한글이라 한글이 있는 글꼴만 고르게 한다
  return list.filter((f) => !f.lang || f.lang.includes("한") || f.lang.toLowerCase().includes("ko")).map((f) => ({ name: f.name, role: f.role ?? "", look: f.look ?? "" }));
}

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
  product: string;
  look: Look;
  tone?: string | null;
  styleText?: string | null;
}): Promise<{ design: CaptionDesign; tokens: { input: number; output: number } }> {
  const fonts = fontNames(input.dir);
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
- key 줄에는 대부분 효과를 주고, small 줄은 cut이나 부드러운 효과를 준다. 한 영상에 효과는 4~6가지, 같은 효과를 연달아 쓰지 않는다.
- 감정 효과(${EMOTION_FX.join(", ")})는 감정이 있는 말에만 영상당 2~4번 이내로 쓴다.
- 명조 · 세리프를 강조어 글꼴로 고르지 않는다. 설정 분위기와 상품에 맞는 한글 글꼴로 강조어 하나, 작은 줄 하나를 짝짓는다.
쓸 수 있는 효과:
${effectNotes(input.dir)}
감정 효과: ${EMOTION_FX.join(", ")}${conceptBlock("이 계정의 말투 · 분위기", input.tone, "효과 세기와 글꼴에 반영한다.")}${conceptBlock("이 계정의 영상 스타일", input.styleText, "자막 움직임에 맞으면 반영한다.")}`,
      },
      {
        role: "user",
        content: `상품: ${input.product}\n글꼴 목록:\n${fonts.map((f) => `${f.name} (${f.role}, ${f.look})`).join("\n")}\n\n자막:\n${input.captions.map((c, i) => `${i}. "${c.text}" (${(c.end - c.start).toFixed(1)}초)`).join("\n")}`,
      },
    ],
    response_format: zodResponseFormat(designSchema, "caption_design"),
  });
  const parsed = completion.choices[0]?.message?.parsed;
  if (!parsed) throw new Error("자막 디자인 응답이 비어 있음");
  return {
    design: {
      ...parsed,
      key_font: fonts.some((f) => f.name === parsed.key_font) ? parsed.key_font : DEFAULT_FONT,
      small_font: fonts.some((f) => f.name === parsed.small_font) ? parsed.small_font : DEFAULT_FONT,
    },
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

/** AI가 나눈 줄이 자막과 글자가 다르면 쓰지 않고 자막 전체를 큰 줄 하나로 둔다. */
function rowsOf(c: TimedCaption, line: CaptionDesign["lines"][number] | undefined) {
  const usable = line && line.rows.length > 0 && line.rows.length <= 2 && squash(line.rows.map((r) => r.text).join("")) === squash(c.text);
  const rows = usable ? line.rows : [{ text: c.text, role: "key" as const, fx: line?.rows[0]?.fx ?? "cut" }];
  const seconds = c.end - c.start;
  return rows.map((r, i) => ({
    text: r.text.trim(),
    fx: fx(r.fx),
    size: r.role === "key" ? keySize(r.text.trim()) : SMALL_SIZE,
    ...(r.role === "key" ? { key: true, tone: "hi" } : {}),
    // 둘째 줄은 말이 그 낱말에 닿을 즈음 나온다
    ...(i > 0 ? { delay: Number((seconds * (rows[0].text.length / Math.max(squash(c.text).length, 1))).toFixed(2)) } : {}),
  }));
}

/** 편집 결과의 시각 · 글자를 그대로 쓰는 자막 파일 내용. */
export function buildSubtitleFile(video: string, captions: TimedCaption[], zones: Zone[], design: CaptionDesign, look: Look) {
  const byNo = new Map(design.lines.map((l) => [l.no, l]));
  return {
    video,
    size: "9:16",
    // 밝은 제품 사진 위에서도 읽히게 그림자를 스킬 기본보다 진하게 둔다
    style: { font: design.small_font, keyFont: design.key_font, weight: 800, size: SMALL_SIZE, color: look.text_color, accent: look.accent_color, glow: "rgba(0,0,0,.62)", glowR: 14, shadowY: 6, maxW: 960 },
    lines: captions.map((c, i) => {
      const line = byNo.get(i);
      const box = ZONE_BOX[zones[i] ?? "lower"];
      const rows = rowsOf(c, line);
      const keyRow = rows.findIndex((r) => "key" in r);
      return {
        t0: Number(c.start.toFixed(3)),
        t1: Number(c.end.toFixed(3)),
        cy: box.top + Math.round(box.height / 2),
        rows,
        ...(line?.spark && keyRow >= 0 ? { deco: [{ type: "spark", items: [{ row: keyRow, corner: "tr", s: 44 }] }] } : {}),
      };
    }),
  };
}

/** 소리까지 있는 영상 위에 자막을 얹는다. 길이가 달라지거나 실패하면 예외를 던져 호출하는 쪽이 기본 자막으로 돌아간다. */
export function overlayCaptions(input: { dir: string; video: string; captions: TimedCaption[]; zones: Zone[]; design: CaptionDesign; look: Look; workDir: string }): string {
  const work = join(input.workDir, "caption-skill");
  mkdirSync(work, { recursive: true });
  const file = join(work, "subs.json");
  writeFileSync(file, JSON.stringify(buildSubtitleFile(input.video, input.captions, input.zones, input.design, input.look)));
  const out = join(input.workDir, "final-captioned.mp4");
  const res = spawnSync(process.execPath, [join(input.dir, "scripts", "subs.cjs"), file, "--out", out], {
    encoding: "utf8",
    timeout: 20 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CMS_NO_UPDATE_CHECK: "1" },
  });
  if (res.status !== 0) throw new Error(`자막 모션 렌더 실패: ${(res.stderr || String(res.error ?? "")).slice(-300)}`);
  if (!existsSync(out)) throw new Error("자막 모션 결과가 없어요");
  const before = mediaSeconds(input.video);
  const after = mediaSeconds(out);
  if (Math.abs(before - after) > 0.3) throw new Error(`자막 모션 결과 길이가 달라요 (${before.toFixed(1)}초 → ${after.toFixed(1)}초)`);
  return out;
}

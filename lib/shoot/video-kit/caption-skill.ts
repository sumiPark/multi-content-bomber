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
// AI는 줄마다 효과 · 강조 · 크기와 글꼴만 고른다. 글자 내용과 시각은 코드가 편집 결과 그대로 넣는다.

// 글자 자체가 움직이는 효과만 영상 자막에 쓸 수 있다(스킬 안내). 사물이 나오는 장면 번호는 쓰지 않는다
const MOTION_FX = ["04", "06", "07", "08", "10", "13", "18", "19", "20", "22", "29", "32", "33", "36", "37", "38", "39", "41", "42"];
const EMOTION_FX = ["sway", "shiver", "heartbeat", "tilt", "hop", "droop", "impact"];
const ALLOWED_FX = new Set(["cut", ...MOTION_FX, ...EMOTION_FX]);
const DEFAULT_FONT = "프리텐다드";

export function captionSkillDir(): string | null {
  const dir = process.env.CAPTION_SKILL_DIR || join(homedir(), ".claude", "skills", "caption-motion-seqc");
  return existsSync(join(dir, "scripts", "subs.cjs")) && existsSync(join(dir, "node_modules")) ? dir : null;
}

const designSchema = z.object({
  font: z.string().describe("자막 글꼴. 목록의 이름 그대로"),
  size: z.number().int().describe("기본 글자 크기 px, 60~110"),
  reading: z.string().describe("이 설정과 상품을 어떻게 읽어 이렇게 골랐는지 한 줄"),
  lines: z
    .array(
      z.object({
        no: z.number().int().describe("자막 번호(0부터)"),
        fx: z.string().describe("효과 번호나 이름. 바로 바뀌게 하려면 cut"),
        emphasis: z.string().describe("강조할 낱말. 그 자막에 그대로 있는 글자만, 없으면 빈 문자열"),
        scale: z.enum(["normal", "big", "small"]).describe("big은 결론 · 반전, small은 이음말"),
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
- 대부분은 cut으로 두고, 강조할 말의 20~35%에만 효과를 넣는다. 한 영상에 효과는 4~6가지, 같은 효과를 연달아 쓰지 않는다.
- 감정 효과(${EMOTION_FX.join(", ")})는 감정이 있는 말에만 영상당 2~4번 이내로 쓴다.
- 명조 · 세리프 글꼴을 고르지 않는다. 설정 분위기와 상품에 맞는 한글 글꼴 하나를 고른다.
- 결론 · 반전만 big, 이음말만 small로 둔다.
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
    design: { ...parsed, font: fonts.some((f) => f.name === parsed.font) ? parsed.font : DEFAULT_FONT },
    tokens: { input: completion.usage?.prompt_tokens ?? 0, output: completion.usage?.completion_tokens ?? 0 },
  };
}

function markEmphasis(text: string, words: string[]): string {
  // 스킬 표기(*강조*)와 겹치는 글자는 강조 없이 그대로 둔다
  if (text.includes("*")) return text;
  const word = words.find((w) => w && text.includes(w));
  return word ? text.replace(word, `*${word}*`) : text;
}

/** 편집 결과의 시각 · 글자를 그대로 쓰는 자막 파일 내용. 효과를 못 고른 줄은 바로 바뀐다. */
export function buildSubtitleFile(video: string, captions: TimedCaption[], zones: Zone[], design: CaptionDesign, look: Look) {
  const byNo = new Map(design.lines.map((l) => [l.no, l]));
  const size = Math.min(110, Math.max(60, design.size));
  return {
    video,
    size: "9:16",
    pace: "fast",
    // 밝은 제품 사진 위에서도 읽히게 그림자를 스킬 기본보다 진하게 둔다
    style: { font: design.font, weight: 800, size, color: look.text_color, accent: look.accent_color, glow: "rgba(0,0,0,.62)", glowR: 14, shadowY: 6 },
    lines: captions.map((c, i) => {
      const l = byNo.get(i);
      const box = ZONE_BOX[zones[i] ?? "lower"];
      return {
        t0: Number(c.start.toFixed(3)),
        t1: Number(c.end.toFixed(3)),
        text: markEmphasis(c.text, [l?.emphasis ?? "", ...c.emphasis]),
        fx: l && ALLOWED_FX.has(l.fx) ? l.fx : "cut",
        // 그래픽 · 제품을 피한 자리의 가운데. 한 줄 자막의 위치는 스킬에서 윗선(y)으로 받는다
        y: box.top + Math.round((box.height - size) / 2),
        ...(l?.scale === "big" ? { big: true } : {}),
        ...(l?.scale === "small" ? { small: true } : {}),
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

import { mkdirSync, readFileSync } from "node:fs";
import type { EditPlan } from "@/lib/agents/edit-plan";
import { editKit } from "@/lib/agents/ko-skills";
import type { AiUsage, VoiceLine } from "@/lib/lemo/contract";
import { makeVoices, type KitInput } from "@/lib/shoot/video-kit/pipeline";
import { DEFAULT_LOOK } from "@/lib/shoot/video-kit/caption-style";

// lemo 경로의 음성 확정. 화면(lemo)보다 음성이 먼저 정해지고, 장면 시각은 이 줄 시각에서 온다.
// - 새 대본: 기존 편집 키트의 makeVoices(Fish, 계정 목소리, kit.json 무료 모델 고정)로 줄마다 만들고 줄 사이 간격 규칙으로 시각을 정한다.
// - 같은 대본 비교 시험: 이미 만든 voice.wav · timeline.json의 시각을 그대로 읽는다(새로 만들지 않는다).
// 음성을 못 만들면 던진다. 기존 편집처럼 무음으로 넘어가 완료 처리하지 않는다.

const FPS = 30;
// 첫 말 전 여백(첫 화면을 먼저 보여 준다), 줄 사이 기본 간격, 물음 뒤 간격, 마지막 말 뒤 여백(초)
export const VOICE_GAPS = { lead: 0.3, gap: 0.25, question: 0.45, tail: 0.6 } as const;

const round3 = (v: number) => Math.round(v * 1000) / 1000;
// 다음 줄은 프레임 경계에서 시작한다. 장면 전환과 말 시작이 같은 프레임에 놓인다
const ceilFrame = (v: number) => Math.ceil(v * FPS - 1e-6) / FPS;

interface ExistingCut {
  id: string;
  start: number;
  dur: number;
  voice_at: number;
  voice_dur: number;
}

function readExistingCuts(timelineJson: string): ExistingCut[] {
  const raw: unknown = JSON.parse(readFileSync(timelineJson, "utf8"));
  if (!Array.isArray(raw)) throw new Error(`${timelineJson}: 배열이 아니에요`);
  return raw.map((r, i) => {
    const c = r as Partial<ExistingCut>;
    if (typeof c.id !== "string" || ![c.start, c.dur, c.voice_at, c.voice_dur].every((n) => typeof n === "number")) throw new Error(`${timelineJson}: ${i}번 칸 형식이 달라요`);
    return c as ExistingCut;
  });
}

/** 비교 시험 영상 전체 길이(마지막 칸 끝). 장면 데이터의 duration과 맞는지 볼 때 쓴다. */
export function existingDuration(timelineJson: string): number {
  const cuts = readExistingCuts(timelineJson);
  const last = cuts.at(-1);
  return last ? round3(last.start + last.dur) : 0;
}

/**
 * 비교 시험: 하나의 voice.wav 안에 줄마다 놓인 음성 구간을 그대로 줄 시각으로 쓴다.
 * timeline.json의 voice_at · voice_dur가 그 줄의 시작 · 길이이고, voice.wav에서도 같은 자리에 있다.
 */
export function voiceFromExisting(input: { voiceWav: string; timelineJson: string; linesTsv: string }): VoiceLine[] {
  const cuts = readExistingCuts(input.timelineJson);
  const texts = new Map(
    readFileSync(input.linesTsv, "utf8")
      .replace(/^﻿/, "")
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => {
        const [id, ...rest] = l.split("\t");
        return [id.trim(), rest.join("\t").trim()] as const;
      }),
  );
  return cuts.map((c, i) => {
    const text = texts.get(c.id);
    if (!text) throw new Error(`${input.linesTsv}에 ${c.id} 줄이 없어요`);
    const start = round3(c.voice_at);
    const end = round3(c.voice_at + c.voice_dur);
    return { beat: i, text, start, end, file: input.voiceWav, fileIn: start, fileOut: end };
  });
}

/** 줄 시각으로 만든 영상 길이(마지막 말 + 여백, 프레임 경계). */
export function voiceDuration(voice: VoiceLine[], tail: number = VOICE_GAPS.tail): number {
  const last = voice.at(-1);
  return last ? ceilFrame(last.end + tail) : 0;
}

/**
 * 새 대본: 기존 편집 키트의 음성 생성(makeVoices)으로 줄마다 만든다. 목소리는 계정 설정(voiceId), 모델은 kit.json 무료 모델.
 * 줄 시각: 첫 줄 lead초, 이후 앞 줄 끝 + gap(물음표로 끝나면 question). 시작은 프레임 경계로 올린다.
 */
export async function voiceFromScript(input: { lines: string[]; voiceId: string | null; workDir: string }): Promise<{ voice: VoiceLine[]; usage: AiUsage; warnings: string[] }> {
  const lines = input.lines.map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error("음성을 만들 대본 줄이 없어요");
  if (!process.env.FISH_API_KEY) throw new Error("음성 키(FISH_API_KEY)가 없어 음성을 만들 수 없어요. lemo 경로는 무음으로 넘어가지 않아요");
  // makeVoices는 비트의 tts만 읽는다(live 비트가 없으니 컷은 읽지 않는다)
  const plan: EditPlan = {
    look: { ...DEFAULT_LOOK },
    analysis: [],
    hook: { on_screen: "", highlight: "", position: "top", spoken: lines[0] },
    thumbnail: { title: "", highlight: "", position: "top", sub: "", clip: 1, at: 0 },
    beats: lines.map((tts) => ({ mode: "tts" as const, tts, captions: [], emphasis: [], cuts: [{ clip: 1, in: 0, out: 1, what: "" }], graphics: [], sfx: [] })),
    visuals: [],
    warnings: [],
  };
  const clips: KitInput["clips"] = [];
  mkdirSync(input.workDir, { recursive: true });
  const made = await makeVoices(plan, clips, input.workDir, input.voiceId);
  const missing = made.voices.map((v, i) => (v.file ? -1 : i)).filter((i) => i >= 0);
  if (missing.length) {
    const why = made.warnings.find((w) => w.includes("음성")) ?? "음성 응답이 비어 있음";
    throw new Error(`${missing.map((i) => i + 1).join(", ")}번 줄 음성을 만들지 못했어요: ${why}`);
  }
  const voice: VoiceLine[] = [];
  let t: number = VOICE_GAPS.lead;
  made.voices.forEach((v, i) => {
    if (i > 0) t = ceilFrame(voice[i - 1].end + (/[?？]\s*$/.test(lines[i - 1]) ? VOICE_GAPS.question : VOICE_GAPS.gap));
    const start = round3(t);
    const end = round3(start + (v.fileOut - v.fileIn));
    voice.push({ beat: i, text: lines[i], start, end, file: v.file!, fileIn: v.fileIn, fileOut: v.fileOut });
  });
  const kit = editKit();
  // 과금 단위는 읽은 글자 수(읽기용 원고로 바뀐 뒤의 글)
  const characters = plan.beats.reduce((n, b) => n + b.tts.length, 0);
  return {
    voice,
    usage: { stage: "voice", provider: "fish", model: kit.voice.model, calls: lines.length, input: 0, cached_input: 0, cache_write: 0, output: 0, units: { characters } },
    warnings: made.warnings,
  };
}

/** renderKitEdit의 presetVoices로 옮긴다. 줄 시각을 고정해 lemo 화면과 음성이 같은 시각에 놓인다. */
export function toPresetVoices(voice: VoiceLine[]): { clips: { file: string; fileIn: number; fileOut: number }[]; layout: { start: number; end: number }[] } {
  return {
    clips: voice.map((v) => ({ file: v.file, fileIn: v.fileIn, fileOut: v.fileOut })),
    layout: voice.map((v) => ({ start: v.start, end: v.end })),
  };
}

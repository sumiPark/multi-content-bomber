import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { writeEditPlan, type EditClipInfo, type EditPlan, type EditPlanContext, type VisualPolicy } from "@/lib/agents/edit-plan";
import { editKit, editKitAsset, ttsReading } from "@/lib/agents/ko-skills";
import type { ProductFacts } from "@/lib/agents/product-facts";
import { agentModel } from "@/lib/agents/runner";
import { getOpenAI } from "@/lib/openai";
import { callOptions } from "@/lib/products/analysis/analyze";
import type { ContentRule } from "@/lib/rules/check";
import { DEFAULT_EDIT_STYLE, type EditStyle } from "@/lib/shoot/edit-style";
import { hookZone, normalizeLook, readableCaptions, readableLook, readableRows, type CutZones, type Look } from "@/lib/shoot/video-kit/caption-style";
import { CAPTION_FALLBACK_WARNING, selectCaptionRenderer } from "@/lib/shoot/video-kit/caption-renderer";
import { inspectAndRepairVideo, type VideoQuality, type VideoReview } from "@/lib/shoot/video-kit/quality";
import { buildVisualClips, loadVisualLibrary, type UsedVisual } from "@/lib/shoot/video-kit/generated-visual";
import { blockRows, captionSkillDir, designCaptions, isMotionEffect, overlayCaptions, type CaptionDesign, type SkillBlock } from "@/lib/shoot/video-kit/caption-skill";
import { findMusic, libraryMusic, reloadMusic, type MusicSource, type MusicToUse, type PickedMusic } from "@/lib/shoot/video-kit/music";
import { frameZones, runVisionTool, subjectZones } from "@/lib/shoot/video-kit/vision-tools";
import { concatSegments, probe, renderSegment } from "@/lib/shoot/ffmpeg";
import { captionZones, writeCoverProject, writeProject, type BehindWord, type VideoFonts } from "@/lib/shoot/video-kit/compose";
import { chosenFonts, downloadVideoFonts, loadSkillFonts } from "@/lib/shoot/video-kit/skill-fonts";
import { layoutBeats, timeText, type FixedLayout, type TimedCut, type TimedSfx, type Timeline, type VoiceClip } from "@/lib/shoot/video-kit/timeline";
import { contactSheet, ffmpeg, fishTts, hyperframes, imageDataUrl, mediaSeconds, transcribeWords, voicedSpan, type Spoken } from "@/lib/shoot/video-kit/tools";
import type { createServiceClient } from "@/lib/supabase/service";

// 편집 키트 — 촬영본 → 프레임 분석 → 편집 계획(에이전트 3) → 음성 → 컷 → 자막 · 그래픽 → 점검 → 렌더 → 표지.
// 규칙은 .claude/skills/ig-edit-ko. 실패하면 던지고, 워커가 기본 편집으로 넘어간다.

type Service = ReturnType<typeof createServiceClient>;

export interface KitClip extends EditClipInfo {
  file: string;
  hasAudio: boolean;
  hdrTransfer: string | null;
}

export interface KitInput {
  workDir: string;
  service: Service | null;
  readService?: Service;
  planId?: string;
  accountName: string;
  liveVoice: boolean;
  facts: ProductFacts;
  rules: ContentRule[];
  clips: KitClip[];
  // 소재 종류(편집 지시가 달라진다). 없으면 직접 촬영
  source?: "shoot" | "auto";
  scriptLines?: string[];
  // 계정 설정의 목소리. 없으면 기본 목소리. 모델은 kit.json의 무료 모델 고정
  voiceId?: string | null;
  // 글꼴을 미리 고른 흐름만 넘긴다. 없으면 자막 디자인 AI가 고른다
  fonts?: { key_font: string; small_font: string };
  reviewFinal?: (file: string, timeline: Timeline) => Promise<VideoReview>;
  // AI 이미지 규칙. 없으면 직접 촬영 기본값
  visualPolicy?: VisualPolicy;
  humanHook?: string | null;
  humanThumbnail?: string | null;
  // 직접 촬영: 관리자가 이 상품으로 하고 싶은 말(human_brief) → 컷 리스트의 추천 대본 차례로 따른다
  brief?: string | null;
  recommendedScript?: EditPlanContext["recommendedScript"];
  shotlistHook?: { spoken: string; on_screen: string } | null;
  shotlistThumbnail?: { title: string; sub?: string } | null;
  fixedHook?: string | null;
  fixedEnding?: string | null;
  tone?: string | null;
  editStyleText?: string | null;
  style?: EditStyle;
  // 다시 편집: 같은 촬영본이면 이 계획을 다시 쓴다(사람이 고친 글만 반영)
  reusePlan?: EditPlan | null;
  overrides?: { no: number; onScreen?: string | null; subtitle?: string | null }[];
  // 이미 만든 음성(lemo 경로). 있으면 음성을 새로 만들지 않고 비트마다 이 음성을 쓴다.
  // layout이 있으면 줄 시각 · 영상 길이도 이 값으로 고정한다(화면이 먼저 만들어진 경우). 직접 촬영 · AI 자동은 넘기지 않는다
  presetVoices?: { clips: VoiceClip[]; layout?: FixedLayout["lines"]; duration?: number };
  // 영상 기준 시각이 정해진 효과음(lemo 장면 데이터). 있으면 비트의 sfx 대신 이 시각을 그대로 쓴다 — 말 사이 효과음도 그림과 맞는다
  presetSfx?: TimedSfx[];
  // 글자 자리가 이미 정해진 경우(lemo 장면 데이터의 caption_place). 있으면 화면에서 상품 · 사람 자리를 읽지 않고 이 값으로 후킹 · 자막 자리를 고른다.
  // 직접 촬영 · AI 자동(사진 경로)은 넘기지 않는다
  presetZones?: CutZones[];
}

export interface KitSegment {
  cut: number;
  start: number;
  duration: number;
  onScreen: string;
  subtitles: { text: string; from: number; to: number }[];
}

export interface KitResult {
  final: string;
  cover: string;
  seconds: number;
  plan: EditPlan;
  timeline: Timeline;
  segments: KitSegment[];
  hook: { text: string; source: "human" | "saved" | "ai" };
  warnings: string[];
  sounds: { sfx: string[]; music: string | null; musicSource: MusicSource | null };
  loudness: number | null;
  tokens: { input: number; output: number };
  usedVoice: boolean;
  visuals: UsedVisual[];
  quality?: VideoQuality;
  captionMode: "motion" | "basic";
}

const squash = (s: string) => s.replace(/[\s.,!?~·"']+/g, "");

/** 두 글이 얼마나 비슷한지(음절 쌍 겹침). 받아쓰기와 대본 비교용. */
function similarity(a: string, b: string): number {
  const bigrams = (s: string) => new Map([...Array(Math.max(0, s.length - 1)).keys()].map((i) => [s.slice(i, i + 2), 1]));
  const x = bigrams(squash(a));
  const y = bigrams(squash(b));
  if (!x.size || !y.size) return 0;
  let hit = 0;
  for (const k of x.keys()) if (y.has(k)) hit++;
  return (2 * hit) / (x.size + y.size);
}

/** 사람이 넣은 문구는 AI 답과 상관없이 글자 그대로 쓴다. */
export function applyHumanText(plan: EditPlan, input: Pick<KitInput, "humanHook" | "humanThumbnail" | "fixedHook" | "fixedEnding" | "overrides">): EditPlan {
  const out: EditPlan = JSON.parse(JSON.stringify(plan));
  const hook = input.humanHook?.trim() || input.fixedHook?.trim();
  if (hook) {
    out.hook.on_screen = hook;
    out.hook.spoken = hook;
    out.hook.highlight = hook.includes(out.hook.highlight) ? out.hook.highlight : "";
    const first = out.beats[0];
    if (first) {
      first.mode = "tts";
      first.tts = hook;
      first.captions = [];
    }
  }
  const thumb = input.humanThumbnail?.trim();
  if (thumb) {
    out.thumbnail.title = thumb;
    out.thumbnail.highlight = thumb.includes(out.thumbnail.highlight) ? out.thumbnail.highlight : "";
  }
  const ending = input.fixedEnding?.trim();
  const last = out.beats[out.beats.length - 1];
  if (ending && last && out.beats.length > 1 && last.mode === "tts") {
    last.tts = ending;
    last.captions = [ending];
  }
  for (const o of input.overrides ?? []) {
    const beatIndex = out.beats.findIndex((b) => b.cuts.some((c) => c.clip === o.no));
    if (beatIndex < 0) continue;
    const beat = out.beats[beatIndex];
    if (o.subtitle != null) beat.captions = o.subtitle.trim() ? [o.subtitle.trim()] : [];
    if (o.onScreen != null) {
      if (beatIndex === 0 && !hook) out.hook.on_screen = o.onScreen.trim();
      else {
        const g = beat.graphics.find((x) => ["badge", "title", "chip", "notice", "stat", "end_card"].includes(x.type));
        if (g) g.text = o.onScreen.trim();
      }
    }
  }
  return out;
}

/**
 * 계획을 촬영본에 맞게 다듬는다 — 없는 촬영본 · 잘못된 구간은 버리고, 빠진 끝 카드는 그대로 둔다.
 * 말한 소리를 쓰지 않는 계정(기본)은 AI가 지시를 어기거나 예전 계획을 다시 써도 찍은 말이 나가지 않게
 * live 비트를 AI 음성으로 바꾼다. 읽을 글은 자막 → 그 컷의 내레이션 순서로 채운다(2026-11-04).
 */
export function sanitizePlan(plan: EditPlan, clips: KitClip[], liveVoice: boolean): EditPlan {
  const seconds = new Map(clips.map((c) => [c.no, c.duration]));
  const narrationOf = new Map(clips.map((c) => [c.no, c.narration ?? ""]));
  const fixed = plan.beats
    .map((b) =>
      liveVoice || b.mode !== "live"
        ? b
        : { ...b, mode: "tts" as const, tts: b.tts.trim() || b.captions.join(" ").trim() || b.cuts.map((c) => narrationOf.get(c.clip) ?? "").join(" ").trim() },
    )
    .map((b) => ({
      ...b,
      cuts: b.cuts
        .filter((c) => seconds.has(c.clip))
        .map((c) => {
          const max = seconds.get(c.clip)!;
          const from = Math.min(Math.max(0, c.in), Math.max(0, max - 0.2));
          return { ...c, in: from, out: Math.max(from + 0.2, Math.min(c.out, max)) };
        }),
    }));
  const keep = (b: EditPlan["beats"][number]) => b.cuts.length > 0 && (b.mode === "live" || !!b.tts.trim());
  const beats = fixed.filter(keep);
  if (beats.length === 0) throw new Error("편집 계획에 쓸 컷이 없어요");
  // 비트가 빠지면 AI 이미지의 비트 번호도 당긴다. 예전 계획에는 visuals가 없다
  const visuals = (plan.visuals ?? [])
    .filter((v) => fixed[v.beat] && keep(fixed[v.beat]))
    .map((v) => ({ ...v, beat: fixed.slice(0, v.beat).filter(keep).length }));
  const thumb = seconds.has(plan.thumbnail.clip) ? plan.thumbnail : { ...plan.thumbnail, clip: beats[0].cuts[0].clip, at: beats[0].cuts[0].in };
  return { ...plan, beats, visuals, thumbnail: thumb };
}

/** 코드로 재는 계획 문제. 걸리면 에이전트가 한 번 다시 쓴다. */
export function planProblems(plan: EditPlan): string[] {
  const problems: string[] = [];
  const all = plan.beats.flatMap((b) => b.cuts);
  for (const [i, a] of all.entries()) {
    const twin = all.slice(i + 1).find((b) => b.clip === a.clip && Math.min(a.out, b.out) - Math.max(a.in, b.in) > 0.5 * Math.min(a.out - a.in, b.out - b.in));
    if (twin) problems.push(`${a.clip}번 촬영본의 ${a.in}~${a.out}초와 ${twin.in}~${twin.out}초가 겹쳐요. 같은 구간을 두 번 쓰지 말고 다른 구간이나 다른 촬영본을 쓰세요.`);
  }
  const syllables = plan.beats.reduce((s, b) => s + squash(b.tts).length, 0);
  if (plan.beats.some((b) => b.mode === "tts") && syllables < 60) problems.push("대본이 너무 짧아요. 15초 이상 나오게 쓰세요.");
  if (syllables > 630) problems.push("대본이 너무 길어요. 85초 안에 들어오게 줄이세요.");
  if (all.length < 6) problems.push(`컷이 ${all.length}개뿐이에요. 비트를 나눠 컷을 더 쓰세요.`);
  if (!plan.beats[plan.beats.length - 1]?.graphics.some((g) => g.type === "end_card")) problems.push("마지막 비트에 end_card가 없어요.");
  if (squash(plan.hook.on_screen).length > 22) problems.push("후킹 글자가 너무 길어요. 12자 안팎으로 줄이세요.");
  return [...new Set(problems)];
}

export async function makeVoices(plan: EditPlan, clips: KitClip[], workDir: string, voiceId: string | null | undefined): Promise<{ voices: VoiceClip[]; usedVoice: boolean; warnings: string[] }> {
  const kit = editKit();
  const voiceSetting = { ...kit.voice, id: voiceId || process.env.FISH_VOICE_ID || kit.voice.id };
  const warnings: string[] = [];
  const clipOf = new Map(clips.map((c) => [c.no, c]));
  const ttsLines = plan.beats.map((b) => (b.mode === "tts" ? b.tts : ""));
  const reading = ttsReading(ttsLines.filter(Boolean));
  let r = 0;
  const texts = ttsLines.map((t) => (t ? reading[r++]?.text ?? t : ""));
  for (const line of reading) for (const flag of line.flags) warnings.push(`읽기용 원고: "${line.text}" — ${flag}`);

  const voices: VoiceClip[] = [];
  let usedVoice = false;
  let noVoice = false;
  let voiceError: string | null = null;
  for (const [i, beat] of plan.beats.entries()) {
    if (beat.mode === "live") {
      const c = beat.cuts[0];
      const owner = clipOf.get(c.clip);
      voices.push({ file: owner?.file ?? null, fileIn: c.in, fileOut: c.out });
      continue;
    }
    plan.beats[i] = { ...beat, tts: texts[i] };
    let buf: Buffer | null = null;
    if (!noVoice) {
      try {
        buf = await fishTts(texts[i], voiceSetting);
      } catch (e) {
        // 무료 모델이 끝났거나 장애면 음성만 빼고 이어 간다 — 영상 전체를 기본 편집으로 떨어뜨리지 않는다
        voiceError = e instanceof Error ? e.message : String(e);
      }
    }
    if (!buf) {
      noVoice = true;
      // 음성이 없으면 말 길이를 어림해 자막만 맞춘다
      voices.push({ file: null, fileIn: 0, fileOut: 0, estimated: Math.max(1.2, squash(texts[i]).length / 6.5) });
      continue;
    }
    const file = join(workDir, `line${i}.wav`);
    writeFileSync(file, buf);
    const span = voicedSpan(file);
    voices.push({ file, fileIn: span.from, fileOut: span.to });
    usedVoice = true;
  }
  if (noVoice) warnings.push(voiceError ? `음성을 만들지 못해 내레이션 없이 자막과 음악으로 만들었어요. (${voiceError.slice(0, 160)})` : "음성 키(FISH_API_KEY)가 없어 내레이션 없이 자막과 음악으로 만들었어요.");
  return { voices, usedVoice, warnings };
}

function renderCuts(tl: Timeline, clips: KitClip[], workDir: string, style: EditStyle): string {
  const clipOf = new Map(clips.map((c) => [c.no, c]));
  const out: string[] = [];
  tl.cuts.forEach((c: TimedCut, i) => {
    const owner = clipOf.get(c.clip);
    if (!owner) throw new Error(`${c.clip}번 촬영본이 없어요`);
    const raw = join(workDir, `raw${i}.mp4`);
    const seg = join(workDir, `seg${i}.mp4`);
    // 소리는 믹스에서 따로 입힌다. 글자도 HyperFrames에서 입힌다
    renderSegment({ input: owner.file, start: c.in, duration: c.out - c.in, hasAudio: false, onScreen: "", subtitles: [], hdrTransfer: owner.hdrTransfer, style }, raw, workDir, `k${i}`);
    const rate = (c.out - c.in) / c.duration;
    // 구간이 말보다 짧으면 마지막 프레임을 잠시 둔다
    const pad = rate < 0.56 ? `,tpad=stop_mode=clone:stop_duration=${c.duration.toFixed(3)}` : "";
    ffmpeg(["-y", "-v", "error", "-i", raw, "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000", "-filter:v", `setpts=PTS/${Math.max(0.55, rate).toFixed(4)},fps=30${pad}`, "-map", "0:v:0", "-map", "1:a:0", "-t", c.duration.toFixed(4), "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", seg]);
    out.push(seg);
  });
  const base = join(workDir, "base.mp4");
  concatSegments(out, base, workDir);
  return base;
}

/** 내레이션 트랙. 맨 앞 무음이 없으면 첫 소리의 지연이 무시되어 트랙 전체가 앞당겨진다. */
function buildVoiceTrack(tl: Timeline, workDir: string): string {
  const out = join(workDir, "vo.wav");
  const lines = tl.lines.filter((l) => l.file);
  const D = tl.duration.toFixed(3);
  if (lines.length === 0) {
    ffmpeg(["-y", "-v", "error", "-f", "lavfi", "-t", D, "-i", "anullsrc=r=48000:cl=mono", out]);
    return out;
  }
  const inputs = lines.flatMap((l) => ["-i", l.file!]);
  const parts = lines.map(
    (l, i) =>
      `[${i}:a]atrim=${l.fileIn.toFixed(3)}:${l.fileOut.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=0.015,afade=t=out:st=${Math.max(0, l.fileOut - l.fileIn - 0.03).toFixed(3)}:d=0.03,aresample=48000,aformat=channel_layouts=mono,adelay=${Math.round(l.start * 1000)}:all=1[v${i}]`,
  );
  parts.push(`anullsrc=r=48000:cl=mono,atrim=0:${D}[z]`);
  parts.push(`[z]${lines.map((_, i) => `[v${i}]`).join("")}amix=inputs=${lines.length + 1}:normalize=0:duration=longest,acompressor=threshold=-18dB:ratio=2.5:attack=8:release=120,loudnorm=I=-15:TP=-2:LRA=7,aresample=48000,apad=whole_dur=${D},atrim=0:${D}[out]`);
  ffmpeg(["-y", "-v", "error", ...inputs, "-filter_complex", parts.join(";"), "-map", "[out]", "-ar", "48000", "-ac", "1", out]);
  return out;
}

/** 내레이션 + 효과음 + 음악. 말할 때 음악과 효과음이 자동으로 줄어든다. */
function buildMix(tl: Timeline, voice: string, dest: string, music: MusicToUse): { sfx: string[]; music: string | null; musicSource: MusicSource | null } {
  const kit = editKit();
  const D = tl.duration.toFixed(3);
  const used = tl.sfx.filter((s) => kit.sfx[s.name]);
  const inputs: string[] = [];
  const parts: string[] = [];
  used.forEach((s, i) => {
    const def = kit.sfx[s.name];
    inputs.push("-i", editKitAsset("sfx", `${s.name}.mp3`));
    const cutPart = def.slice ? `atrim=${def.slice[0]}:${def.slice[0] + def.slice[1]},` : "";
    const fade = def.slice ? `afade=t=out:st=${Math.max(0, def.slice[1] - 0.15).toFixed(3)}:d=0.15,` : "";
    parts.push(`[${i}:a]${cutPart}asetpts=PTS-STARTPTS,afade=t=in:d=0.004,${fade}aresample=48000,aformat=channel_layouts=stereo,volume=${def.gain_db}dB,adelay=${Math.round(Math.max(0, s.t - (def.lead ?? 0)) * 1000)}:all=1[s${i}]`);
  });
  const m = used.length;
  parts.push(`anullsrc=r=48000:cl=stereo,atrim=0:${D}[z]`);
  parts.push(`[z]${used.map((_, i) => `[s${i}]`).join("")}amix=inputs=${m + 1}:normalize=0:duration=longest,apad=whole_dur=${D},atrim=0:${D}[sfx]`);
  inputs.push("-stream_loop", "-1", "-i", music.file, "-i", voice);
  parts.push(`[${m}:a]atrim=${music.in}:${music.in + tl.duration},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${music.gain_db}dB,afade=t=in:d=0.3,afade=t=out:st=${Math.max(0, tl.duration - 1).toFixed(3)}:d=1[bg]`);
  parts.push(`[${m + 1}:a]aformat=channel_layouts=stereo,asplit=3[k1][k2][vm]`);
  parts.push("[bg][k1]sidechaincompress=threshold=0.05:ratio=3.5:attack=20:release=260:makeup=1[bgd]");
  parts.push("[sfx][k2]sidechaincompress=threshold=0.06:ratio=2:attack=5:release=120:makeup=1[sfxd]");
  parts.push(`[vm][sfxd][bgd]amix=inputs=3:normalize=0:duration=first,volume=1dB,alimiter=limit=0.84:level=false,atrim=0:${D}[mix]`);
  ffmpeg(["-y", "-v", "error", ...inputs, "-filter_complex", parts.join(";"), "-map", "[mix]", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", dest]);
  return { sfx: [...new Set(used.map((s) => s.name))], music: music.name, musicSource: music.source };
}

function lufs(file: string): number | null {
  const out = ffmpeg(["-hide_banner", "-i", file, "-af", "ebur128=framelog=quiet", "-f", "null", "-"]);
  const m = out.match(/I:\s+(-?[0-9.]+) LUFS/);
  return m ? Number(m[1]) : null;
}

function buildSegments(plan: EditPlan, tl: Timeline, realClipOf: Map<number, number>): KitSegment[] {
  return tl.cuts.map((c, i) => {
    const caps = tl.captions.filter((x) => x.start >= c.start - 0.001 && x.start < c.end);
    const texts = tl.graphics.filter((g) => g.start >= c.start && g.start < c.end).map((g) => g.g.text).filter(Boolean);
    return {
      // AI 이미지 컷은 사람이 찾을 수 있게 원래 촬영본 번호로 남긴다
      cut: realClipOf.get(c.clip) ?? c.clip,
      start: c.in,
      duration: c.duration,
      onScreen: i === 0 ? plan.hook.on_screen.replace(/\n+/g, " ") : texts.join(" · "),
      subtitles: caps.map((x) => ({ text: x.text, from: Number((x.start - c.start).toFixed(3)), to: Number((x.end - c.start).toFixed(3)) })),
    };
  });
}

const qaSchema = z.object({
  drop_graphics: z.array(z.string()).describe("표적을 벗어난 ring · arrow처럼 빼야 할 그래픽 id"),
  issues: z.array(z.string()).describe("사람이 확인할 문제: 글자가 상품 · 손 동작 · 얼굴을 가림, 그래픽 내용이 화면과 다름, 읽기 어려움. 사람이 찾을 수 있게 시각을 쓴다. 없으면 빈 배열"),
});

/** 렌더 전에 프레임을 찍어 본다. 실패해도 편집은 이어 간다. */
async function qaFrames(version: string, dir: string, tl: Timeline, workDir: string): Promise<{ drop: Set<string>; issues: string[]; tokens: { input: number; output: number } }> {
  const empty = { drop: new Set<string>(), issues: [] as string[], tokens: { input: 0, output: 0 } };
  if (!process.env.OPENAI_API_KEY) return empty;
  // 그래픽 표시 자리를 보는 검수라 그래픽이 없으면 볼 것이 없다(프레임 1장이면 xstack이 실패해 어차피 빈 결과였다)
  if (!tl.graphics.length) return empty;
  try {
    const times = [0.1, ...tl.graphics.map((g) => (g.start + g.end) / 2)];
    const unique = [...new Set(times.map((t) => t.toFixed(2)))].slice(0, 12);
    const outDir = join(workDir, "qa");
    hyperframes(version, dir, ["snapshot", "--at", unique.join(","), "--no-end", "-o", outDir], 5 * 60_000);
    const pngs = readdirSync(outDir).filter((f) => /^frame.*\.png$|^at-.*\.png$/.test(f)).sort();
    if (!pngs.length) return empty;
    const sheet = join(workDir, "qa.jpg");
    const scale = pngs.map((_, i) => `[${i}:v]scale=270:-2[p${i}]`).join(";");
    const cols = Math.min(6, pngs.length);
    const rows = Math.ceil(pngs.length / cols);
    const layout = pngs.map((_, i) => `${(i % cols) * 270}_${Math.floor(i / cols) * 480}`).join("|");
    ffmpeg(["-y", "-v", "error", ...pngs.flatMap((f) => ["-i", join(outDir, f)]), "-filter_complex", `${scale};${pngs.map((_, i) => `[p${i}]`).join("")}xstack=inputs=${pngs.length}:layout=${layout}:fill=black,scale=iw:${rows * 480}`, "-frames:v", "1", "-q:v", "4", sheet]);
    const model = agentModel();
    const completion = await getOpenAI().chat.completions.parse({
      model,
      ...callOptions(model, 1200),
      messages: [
        { role: "system", content: "너는 릴스 편집 검수자다. 왼쪽 위부터 차례대로 찍은 편집 프레임을 본다. 첫 칸은 후킹 첫 화면이다. 표적을 벗어난 ring · arrow만 drop_graphics에 넣고, 나머지 문제는 issues에 적는다. 사소한 건 적지 않는다." },
        {
          role: "user",
          content: [
            { type: "text", text: `칸 순서의 시각: ${unique.join(", ")}\n그래픽: ${JSON.stringify(tl.graphics.map((g) => ({ id: g.id, type: g.type, start: g.start, end: g.end, text: g.g.text })))}` },
            { type: "image_url", image_url: { url: imageDataUrl(sheet), detail: "high" } },
          ],
        },
      ],
      response_format: zodResponseFormat(qaSchema, "edit_qa"),
    });
    const parsed = completion.choices[0]?.message?.parsed;
    return {
      drop: new Set(parsed?.drop_graphics ?? []),
      issues: parsed?.issues ?? [],
      tokens: { input: completion.usage?.prompt_tokens ?? 0, output: completion.usage?.completion_tokens ?? 0 },
    };
  } catch (e) {
    console.warn("[video-kit] 프레임 검수 실패:", e instanceof Error ? e.message : e);
    return empty;
  }
}

/** AI가 고른 낱말이 [제품컷]의 자막에 있으면 그 컷의 제품을 떼어 글자 앞에 놓는다. 안 되면 null. */
function makeBehindWord(look: Look, tl: Timeline, clips: KitClip[], baseVideo: string, project: string, workDir: string): BehindWord | null {
  const word = look.behind_word;
  if (!word) return null;
  const cap = tl.captions.find((c) => c.text.includes(word) && c.start > 1.3);
  const cut = cap && tl.cuts.find((c) => c.start <= cap.start && cap.start < c.end);
  const owner = cut && clips.find((c) => c.no === cut.clip);
  if (!cap || !cut || !owner?.shot?.startsWith("[제품컷]") || cut.end - cut.start > 3.5) return null;
  const file = "cutout.webm";
  const made = runVisionTool<{ ratio: number }>("cutout.py", [baseVideo, cut.start.toFixed(3), (cut.end - cut.start).toFixed(3), join(project, "assets", file), join(workDir, "cutout")]);
  // 제품이 거의 없거나 화면을 다 덮으면 글자가 안 보인다
  if (!made || made.ratio < 0.06 || made.ratio > 0.6) return null;
  return { word, start: Number(Math.max(cut.start, cap.start).toFixed(3)), cutStart: Number(cut.start.toFixed(3)), end: Number(cut.end.toFixed(3)), file };
}

/** 표지도 영상과 같은 글꼴로 만든다. 프레임을 잠깐 영상으로 만들어 글자를 얹고 한 장을 뽑는다. */
function makeSkillCover(dir: string, design: CaptionDesign, workDir: string, clip: KitClip, thumb: EditPlan["thumbnail"]): string {
  const frame = join(workDir, "cover-frame.jpg");
  const at = Math.min(Math.max(0, thumb.at), Math.max(0, clip.duration - 0.1));
  ffmpeg(["-y", "-v", "error", "-ss", at.toFixed(3), "-i", clip.file, "-frames:v", "1", "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920", "-q:v", "2", frame]);
  const still = join(workDir, "cover-still.mp4");
  ffmpeg(["-y", "-v", "error", "-loop", "1", "-t", "2", "-i", frame, "-f", "lavfi", "-t", "2", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000", "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "fast", "-crf", "16", "-c:a", "aac", "-shortest", still]);
  const cover0 = frameZones([frame], workDir)?.[0];
  const zone = cover0 ? (cover0.top <= cover0.lower ? "top" : "lower") : thumb.position === "lower" ? "lower" : "top";
  const blocks: SkillBlock[] = [{ start: 0, end: 2, zone, fx: "cut", highlight: thumb.highlight, rows: [...blockRows(thumb.title), ...(thumb.sub ? blockRows(thumb.sub, "small", 18) : [])] }];
  const made = overlayCaptions({ dir, video: still, captions: [], zones: [], design, workDir, blocks, name: "cover" });
  const cover = join(workDir, "cover.jpg");
  ffmpeg(["-y", "-v", "error", "-ss", "1.6", "-i", made, "-frames:v", "1", "-q:v", "2", cover]);
  return cover;
}

function makeCover(version: string, workDir: string, clip: KitClip, thumb: EditPlan["thumbnail"], look: Look, fonts?: VideoFonts): string {
  const frame = join(workDir, "cover-frame.jpg");
  const at = Math.min(Math.max(0, thumb.at), Math.max(0, clip.duration - 0.1));
  ffmpeg(["-y", "-v", "error", "-ss", at.toFixed(3), "-i", clip.file, "-frames:v", "1", "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920", "-q:v", "2", frame]);
  const dir = join(workDir, "cover");
  mkdirSync(dir, { recursive: true });
  // 표지 글자도 상품을 피한다. 자리를 못 읽으면 AI가 정한 자리
  const cover0 = frameZones([frame], workDir)?.[0];
  const plan = cover0 ? { ...thumb, position: cover0.top <= cover0.lower ? ("top" as const) : ("lower" as const) } : thumb;
  writeCoverProject(dir, frame, plan, look, fonts);
  const outDir = join(workDir, "cover-out");
  hyperframes(version, dir, ["snapshot", "--at", "0.5", "--no-end", "-o", outDir], 5 * 60_000);
  const png = readdirSync(outDir).find((f) => f.endsWith(".png"));
  if (!png) throw new Error("표지를 만들지 못했어요");
  const cover = join(workDir, "cover.jpg");
  ffmpeg(["-y", "-v", "error", "-i", join(outDir, png), "-q:v", "2", cover]);
  return cover;
}

function motionBlocks(tl: Timeline, zones: CutZones[] | null, design: CaptionDesign): SkillBlock[] {
  const blocks: SkillBlock[] = [{ start: 0, end: tl.hook.end, zone: hookZone(zones, tl.hook.start, tl.hook.end, tl.hook.position), fx: design.key_fx, highlight: tl.hook.highlight, rows: readableRows(tl.hook.onScreen).map((text) => ({ text, role: "key" })) }];
  const endCard = tl.graphics.find((g) => g.type === "end_card");
  if (endCard) {
    const p = endCard.g;
    const rows = [...(p.chip ? blockRows(p.chip, "small", 18) : []), ...blockRows(p.text), ...(p.sub ? blockRows(p.sub, "small", 18) : []), ...(p.note ? blockRows(p.note, "small", 18) : [])];
    if (rows.length) blocks.push({ start: endCard.start, end: tl.duration, zone: "top", fx: design.finish_fx, rows });
  }
  return blocks;
}

export async function renderKitEdit(input: KitInput): Promise<KitResult> {
  const kit = editKit();
  const { workDir, clips } = input;
  mkdirSync(workDir, { recursive: true });
  const version = kit.render.hyperframes;
  const warnings: string[] = [];
  const tokens = { input: 0, output: 0 };

  // 1. 편집 계획 — 프레임을 보고 정한다
  let plan: EditPlan;
  if (input.reusePlan) {
    plan = input.reusePlan;
  } else {
    const sheets = clips.map((c) => imageDataUrl(contactSheet(c.file, join(workDir, `sheet${c.no}.jpg`))));
    let closer = 0;
    const visualLibrary = await loadVisualLibrary(input.service ?? input.readService);
    const ask = (retry: { plan: EditPlan; problems: string[] } | null) => writeEditPlan({
      retry,
      service: input.service,
      readService: input.readService,
      planId: input.planId,
      accountName: input.accountName,
      liveVoice: input.liveVoice,
      facts: input.facts,
      rules: input.rules,
      clips,
      sheets,
      humanHook: input.humanHook,
      humanThumbnail: input.humanThumbnail,
      brief: input.brief,
      recommendedScript: input.recommendedScript,
      shotlistHook: input.shotlistHook,
      shotlistThumbnail: input.shotlistThumbnail,
      fixedHook: input.fixedHook,
      fixedEnding: input.fixedEnding,
      tone: input.tone,
      editStyle: input.editStyleText,
      source: input.source,
      scriptLines: input.scriptLines,
      visualLibrary,
      lookCloser: async (no, from, to) => {
        const c = clips.find((x) => x.no === no);
        if (!c) throw new Error(`${no}번 촬영본이 없어요`);
        return imageDataUrl(contactSheet(c.file, join(workDir, `closer${closer++}.jpg`), { from, to }));
      },
    });
    const res = await ask(null);
    tokens.input += res.tokens.input;
    tokens.output += res.tokens.output;
    plan = res.output;
    const problems = planProblems(applyHumanText(plan, input));
    if (problems.length) {
      console.log(`[video-kit] 계획 다시 쓰기: ${problems.join(" / ")}`);
      const again = await ask({ plan, problems });
      tokens.input += again.tokens.input;
      tokens.output += again.tokens.output;
      plan = again.output;
      for (const p of planProblems(applyHumanText(plan, input))) warnings.push(`편집 계획: ${p}`);
    }
  }
  plan = sanitizePlan(applyHumanText(plan, input), clips, input.liveVoice);
  // 첫 비트는 후킹 글자만 — 다른 그래픽이 겹치면 후킹이 묻힌다
  plan.beats[0] = { ...plan.beats[0], graphics: plan.beats[0].graphics.filter((g) => g.type === "ring" || g.type === "arrow") };
  warnings.push(...plan.warnings);
  const readable = input.source === "auto";
  const skillDir = captionSkillDir();
  const renderer = selectCaptionRenderer(!!skillDir);
  // 직접 촬영은 예전처럼 조용히 기본 자막으로 만든다. 자동 영상은 경고를 남겨 자동 발행을 멈춘다
  if (renderer === "basic" && readable) warnings.push(`${CAPTION_FALLBACK_WARNING} (스킬 파일을 받지 못함)`);
  const look = normalizeLook(plan.look);

  // 2. 음성 → 시각표
  const preset = input.presetVoices;
  if (preset && (preset.clips.length !== plan.beats.length || (preset.layout && preset.layout.length !== plan.beats.length))) {
    throw new Error(`미리 만든 음성 ${preset.clips.length}줄과 비트 ${plan.beats.length}개가 맞지 않아요`);
  }
  const made = preset ? { voices: preset.clips, usedVoice: preset.clips.some((c) => !!c.file), warnings: [] as string[] } : await makeVoices(plan, clips, workDir, input.voiceId);
  warnings.push(...made.warnings);

  // AI 이미지 컷 — 말 길이를 안 뒤에 만든다. 원래 컷을 담은 plan은 그대로 저장해 다시 편집에 쓴다
  const visual = await buildVisualClips({
    plan,
    clips,
    lengths: made.voices.map((v) => v.estimated ?? v.fileOut - v.fileIn),
    facts: input.facts,
    policy: input.visualPolicy,
    service: input.service,
    readService: input.readService,
    workDir,
  });
  warnings.push(...visual.warnings);
  tokens.input += visual.tokens.input;
  tokens.output += visual.tokens.output;
  const allClips = visual.clips;
  const seconds = new Map(allClips.map((c) => [c.no, c.duration]));
  const base = layoutBeats(visual.plan, made.voices, seconds, preset?.layout ? { lines: preset.layout, duration: preset.duration } : undefined);

  const draftTimeline = timeText(plan, base, [], new Map());
  const voice = buildVoiceTrack(draftTimeline, workDir);

  // 3. 받아쓰기 — 낱말 시각과 발음 확인. 실패해도 글자 수 비율로 이어 간다
  let words: Spoken[] = [];
  if (made.usedVoice || base.lines.some((l) => l.live)) {
    try {
      const stt = await transcribeWords(voice, workDir);
      words = stt.words;
      for (const line of base.lines) {
        if (line.live || !line.file) continue;
        const heard = stt.words.filter((w) => w.start >= line.start - 0.1 && w.start < line.end).map((w) => w.text).join("");
        if (heard && similarity(heard, line.tts) < 0.45) warnings.push(`${line.start.toFixed(1)}초 발음을 들어 봐 주세요. 원고 "${line.tts}" / 받아쓰기 "${heard}"`);
      }
    } catch (e) {
      console.warn("[video-kit] 받아쓰기 실패:", e instanceof Error ? e.message : e);
    }
  }
  const live = new Map<number, Spoken[]>();
  for (const line of base.lines) {
    if (!line.live) continue;
    const beat = plan.beats[line.beat];
    const c = beat.cuts[0];
    const owner = clips.find((x) => x.no === c.clip);
    const shifted = (owner?.transcript ?? [])
      .filter((s) => s.end > c.in && s.start < c.out)
      .map((s) => ({ text: s.text, start: line.start + Math.max(0, s.start - c.in), end: line.start + Math.min(c.out, s.end) - c.in }));
    live.set(line.beat, shifted);
  }
  let tl = timeText(plan, base, words, live);
  if (input.presetSfx) tl = { ...tl, sfx: input.presetSfx.filter((s) => s.t >= 0 && s.t < tl.duration) };
  if (readable) tl = { ...tl, captions: readableCaptions(tl.captions) };
  // 사람이 볼 수 있게 어디에 들어갔는지 남긴다. 경고가 있으면 자동 발행도 멈춘다
  for (const u of visual.used) {
    const line = tl.lines[u.beat];
    if (line) warnings.push(`${line.start.toFixed(1)}~${line.end.toFixed(1)}초에 AI가 만든 그림이 들어갔어요: ${u.subject}`);
  }

  // 4. 컷 → 믹스 → 프로젝트
  const baseVideo = renderCuts(tl, allClips, workDir, input.style ?? DEFAULT_EDIT_STYLE);
  const project = join(workDir, "project");
  mkdirSync(join(project, "assets"), { recursive: true });
  copyFileSync(baseVideo, join(project, "assets", "base.mp4"));
  const mix = join(project, "assets", "mix.wav");
  // 음악: 다시 편집이면 처음 고른 곡, 아니면 영상마다 검색한다. 안 되면 대체 곡
  const priorMusic = (input.reusePlan as (EditPlan & { pickedMusic?: PickedMusic }) | null | undefined)?.pickedMusic;
  const music =
    (priorMusic ? (priorMusic.source ? await reloadMusic(priorMusic, workDir) : libraryMusic(priorMusic.name)) : null) ??
    (await findMusic({ service: input.service, readService: input.readService, query: look.music_query, intent: look.music_intent, workDir })) ??
    libraryMusic(look.music);
  console.log(`[video-kit] 음악: ${music.name}${music.source ? ` (${music.source.creator}, ${music.source.license}, 검색어 "${music.query}")` : " (대체 곡)"}`);
  const sounds = buildMix(tl, voice, mix, music);
  // 장면마다 상품 · 사람이 있는 자리를 읽어 글자가 피하게 한다. 못 읽으면 기본 자리
  const zones = input.presetZones ?? subjectZones(baseVideo, tl.cuts, workDir)?.map((z, i) => {
    const owner = allClips.find((c) => c.no === tl.cuts[i]?.clip);
    return owner?.shot?.startsWith("[코드 모션]") ? { ...z, cover: { ...z.cover, mid: 1 } } : z;
  }) ?? null;
  if (readable) {
    // 마지막 대사를 다시 큰 광고 카드로 덮지 않는다. 자막은 마지막 프레임까지 유지한다.
    tl = { ...tl, graphics: tl.graphics.filter((g) => g.type !== "end_card"), captions: tl.captions.map((c, i) => i === tl.captions.length - 1 ? { ...c, end: tl.duration } : c) };
  }
  const behind = makeBehindWord(look, tl, allClips, baseVideo, project, workDir);
  writeProject(project, tl, { look, zones, behind, readable });

  // 5. 프레임 검수 — 표적을 벗어난 표시는 빼고, 나머지는 사람에게 넘긴다
  const qa = await qaFrames(version, project, tl, workDir);
  tokens.input += qa.tokens.input;
  tokens.output += qa.tokens.output;
  if (!input.reviewFinal) warnings.push(...qa.issues);
  if (qa.drop.size) {
    tl = { ...tl, graphics: tl.graphics.filter((g) => !qa.drop.has(g.id) || (g.type !== "ring" && g.type !== "arrow")) };
    writeProject(project, tl, { look, zones, behind, readable });
  }

  // 자막 시작과 말 시작의 차이를 잰다. 받아쓰기가 없으면 재지 않는다
  if (words.length && tl.captions.length) {
    const gaps = tl.captions.map((c) => Math.min(...words.map((w) => Math.abs(w.start - c.start))));
    const sorted = [...gaps].sort((a, b) => a - b);
    const worst = sorted[sorted.length - 1];
    console.log(`[video-kit] 싱크: 자막 시작과 말 시작 차이 중앙값 ${sorted[Math.floor(sorted.length / 2)].toFixed(2)}초 · 최대 ${worst.toFixed(2)}초`);
    if (worst > 0.5) warnings.push(`자막과 말의 시각이 최대 ${worst.toFixed(1)}초 어긋나요.`);
  }

  // 6. 렌더 · 표지
  // 자막 모션 스킬을 쓸 수 있으면 자막 없이 렌더한 뒤 얹는다. 안 되면 지금까지의 자막으로 렌더한다
  const priorDesign = (input.reusePlan as (EditPlan & { captionDesign?: CaptionDesign }) | null | undefined)?.captionDesign;
  let design: CaptionDesign | null = null;
  let videoFonts: VideoFonts | undefined;
  if (renderer === "motion" && skillDir && tl.captions.length) {
    try {
      if (priorDesign && isMotionEffect(priorDesign.key_fx)) design = priorDesign;
      else {
        // 제품과 장면을 보고 고르게 영상 전체에서 여섯 장면을 모아 보여 준다
        const framesFile = join(workDir, "caption-frames.jpg");
        ffmpeg(["-y", "-v", "error", "-i", baseVideo, "-an", "-vf", `fps=6/${tl.duration.toFixed(3)},scale=300:-2,tile=6x1`, "-frames:v", "1", "-q:v", "4", framesFile]);
        const made = await designCaptions({
          dir: skillDir,
          captions: tl.captions,
          product: { name: input.facts.name, kind: input.facts.kindLabel, oneLine: input.facts.oneLine },
          frames: imageDataUrl(framesFile),
          look,
          tone: input.tone,
          styleText: input.editStyleText,
        });
        console.log(`[video-kit] 자막 모션: 대표 ${made.design.key_fx} · 작은 줄 ${made.design.small_fx} · 마지막 ${made.design.finish_fx} · 글꼴 ${made.design.key_font} + ${made.design.small_font} — ${made.design.reading}`);
        design = made.design;
        tokens.input += made.tokens.input;
        tokens.output += made.tokens.output;
      }
      // 글꼴을 미리 고른 흐름(AI 자동)은 그 값을 쓴다. 설명 화면과 글꼴이 달라지지 않게 한다
      if (input.fonts) design = { ...design, ...input.fonts };
      // 도식 · 끝 화면 글자도 자막과 같은 글꼴로 쓴다. 못 받으면 대체 글꼴로 만든다
      try {
        videoFonts = await downloadVideoFonts(chosenFonts(loadSkillFonts(skillDir), design), workDir);
      } catch (e) {
        warnings.push(`고른 글꼴을 받지 못해 도식 글자는 대체 글꼴로 만들었어요. (${e instanceof Error ? e.message : e})`.slice(0, 300));
      }
      writeProject(project, tl, { look, zones, behind, noCaptions: true, fonts: videoFonts, readable });
    } catch (e) {
      design = null;
      warnings.push(`${CAPTION_FALLBACK_WARNING} (${e instanceof Error ? e.message : e})`.slice(0, 300));
    }
  }
  // 읽기 보정 여부와 자막 렌더러 선택은 별개다. 모션 사용 시 기본 자막을 다시 쓰지 않는다.
  let final = join(workDir, "final.mp4");
  try {
    hyperframes(version, project, ["render", "-o", final, "-q", "standard", "--video-bitrate", "10M", "--skill", "hyperframes"]);
  } catch (e) {
    // 제품 뒤 글자가 렌더를 막으면 그 효과만 빼고 다시 만든다
    if (!behind) throw e;
    console.warn("[video-kit] 제품 뒤 글자를 빼고 다시 렌더:", e instanceof Error ? e.message : e);
    writeProject(project, tl, { look, zones, behind: null, noCaptions: !!design, fonts: videoFonts, readable });
    hyperframes(version, project, ["render", "-o", final, "-q", "standard", "--video-bitrate", "10M", "--skill", "hyperframes"]);
  }
  if (!existsSync(final) || mediaSeconds(final) < 1) throw new Error("렌더 결과가 없어요");
  if (design && skillDir) {
    try {
      // 후킹 글자와 끝 화면도 자막과 같은 스킬로 얹는다
      const blocks = motionBlocks(tl, zones, design);
      final = overlayCaptions({ dir: skillDir, video: final, captions: tl.captions, zones: captionZones(tl, zones), design, workDir, blocks });
    } catch (e) {
      console.warn("[video-kit] 자막 모션 실패, 기본 자막으로 다시 렌더:", e instanceof Error ? e.message : e);
      warnings.push(`${CAPTION_FALLBACK_WARNING} (${e instanceof Error ? e.message : e})`.slice(0, 300));
      design = null;
      writeProject(project, tl, { look, zones, behind: null, fonts: videoFonts, readable });
      hyperframes(version, project, ["render", "-o", final, "-q", "standard", "--video-bitrate", "10M", "--skill", "hyperframes"]);
    }
  }
  // 최종 인코딩 뒤 검수한다. 음성/시간표/음악/실물 소재를 재사용해 글자만 최대 두 번 고친다.
  let quality: VideoQuality | undefined;
  let finalLook = look;
  let finalZones = zones;
  if (input.reviewFinal) {
    const inspected = await inspectAndRepairVideo({
      file: final,
      review: (file) => input.reviewFinal!(file, tl),
      save: (report) => writeFileSync(join(workDir, "quality.json"), JSON.stringify(report, null, 2)),
      repair: async (attempt, issues) => {
        console.log(`[video-kit] 완성본 자동 수정 ${attempt}: ${issues.map((i) => `${i.at.toFixed(1)}초 ${i.detail}`).join(" / ")}`);
        const previousPlaces = captionZones(tl, finalZones);
        const previousHook = hookZone(finalZones, tl.hook.start, tl.hook.end, tl.hook.position);
        const repairZones = (finalZones ?? tl.cuts.map((c) => ({ start: c.start, end: c.end, cover: { top: 0, mid: 0, lower: 0 } }))).map((z) => {
          const cover = { ...z.cover };
          const active = issues.filter((i) => i.at >= z.start - 0.1 && i.at < z.end + 0.1);
          if (active.length) {
            const avoid = new Set(active.flatMap((issue) => [
              ...tl.captions.flatMap((c, i) => issue.at >= c.start - 0.1 && issue.at <= c.end + 0.1 ? [previousPlaces[i]] : []),
              ...(issue.at <= tl.hook.end ? [previousHook] : []),
            ]));
            for (const place of ["top", "mid", "lower"] as const) cover[place] = avoid.has(place) ? 1 : Math.min(0.99, cover[place]);
          }
          return { ...z, cover };
        });
        const repaired = { ...tl, graphics: [] };
        const useMotion = !!design && !!skillDir;
        finalLook = useMotion ? look : readableLook(look);
        writeProject(project, repaired, { look: finalLook, zones: repairZones, behind: null, fonts: videoFonts, noCaptions: useMotion, readable: readable || !useMotion });
        const out = join(workDir, `readable-${attempt}.mp4`);
        hyperframes(version, project, ["render", "-o", out, "-q", "standard", "--video-bitrate", "10M", "--skill", "hyperframes"]);
        tl = repaired;
        finalZones = repairZones;
        return design && skillDir ? overlayCaptions({ dir: skillDir, video: out, captions: repaired.captions, zones: captionZones(repaired, repairZones), design, workDir, blocks: motionBlocks(repaired, repairZones, design), name: `repair-${attempt}` }) : out;
      },
    });
    final = inspected.file;
    quality = inspected.quality;
    warnings.push(...quality.attempts.at(-1)!.issues.map((i) => `${i.at.toFixed(1)}초 ${i.detail}`));
  }
  // 컷마다 여러 시점(25 · 50 · 75%)을 보고, 한 시점이라도 거의 한 색이거나 위아래 단색 띠 때문에 그림이 작으면 빈 화면으로 본다.
  // 경고로만 남긴다(발행을 막지 않는다)
  for (const cut of tl.cuts) {
    const times = BLANK_POINTS.map((p) => cut.start + (cut.end - cut.start) * p);
    // 거의 한 색: 자막 · 그래픽까지 얹은 완성본
    const flat = grayFrames(final, times, 64, 64)?.some(nearlyFlat) ?? false;
    // 단색 띠: 자막이 띠 위에 얹히면 띠가 끊겨 보이므로 컷만 이은 바탕 영상에서 잰다
    const small = !flat && (grayFrames(baseVideo, times, BAR_W, BAR_H, true)?.some((px) => pictureShare(px, BAR_W, BAR_H) < MIN_PICTURE_SHARE) ?? false);
    if (flat || small) warnings.push(`${cut.start.toFixed(1)}~${cut.end.toFixed(1)}초 화면이 거의 한 색이에요. 빈 화면처럼 보일 수 있어요.`);
  }
  const coverClip = clips.find((c) => c.no === plan.thumbnail.clip) ?? clips[0];
  let cover: string | null = null;
  if (design && skillDir) {
    try {
      cover = makeSkillCover(skillDir, design, workDir, coverClip, plan.thumbnail);
    } catch (e) {
      console.warn("[video-kit] 스킬 표지 실패, 기본 표지로 만든다:", e instanceof Error ? e.message : e);
    }
  }
  cover ??= makeCover(version, workDir, coverClip, plan.thumbnail, look, videoFonts);

  const hookText = plan.hook.on_screen.replace(/\n+/g, " ");
  plan.look = finalLook;
  return {
    final,
    cover,
    seconds: mediaSeconds(final),
    plan: { ...plan, pickedMusic: { name: music.name, in: music.in, gain_db: music.gain_db, source: music.source, query: music.query }, ...(design ? { captionDesign: design } : {}) } as EditPlan,
    timeline: tl,
    segments: buildSegments(plan, tl, visual.realClipOf),
    hook: { text: hookText, source: input.humanHook?.trim() ? "human" : input.fixedHook?.trim() ? "saved" : "ai" },
    warnings: [...new Set(warnings)],
    sounds,
    loudness: lufs(final),
    tokens,
    usedVoice: made.usedVoice,
    visuals: visual.used,
    quality,
    captionMode: design ? "motion" : "basic",
  };
}

// 빈 화면 검사. 컷 가운데 한 장만 보면 도식 항목이 늦게 나오거나 움직이는 이미지가 끝난 뒤의 빈 화면을 놓친다
const BLANK_POINTS = [0.25, 0.5, 0.75];
// 64×64 회색 화면의 밝기 편차가 이보다 작으면 거의 한 색이다
const BLANK_SPREAD = 12;
// 단색 띠를 잴 때의 크기. 세로를 촘촘히 봐야 띠 경계가 정확하다
const BAR_W = 64;
const BAR_H = 128;
// 줄 안의 밝기 편차가 이보다 작고 맨 끝 줄과 밝기가 같으면 채운 띠다. 사진 · AI 그림의 민 바탕은 결이 있어 대개 이보다 크다
const BAR_ROW_SPREAD = 2;
const BAR_ROW_SHIFT = 3;
// 위아래 띠를 걷어 낸 그림 높이가 화면의 이 비율보다 작으면 빈 화면처럼 보인다
// (2026-11-09 시험: 가로로 긴 움직이는 이미지를 폭에 맞춘 컷 0.37, 위가 민 바탕인 AI 그림 0.55 · 일반 컷 0.67~1)
const MIN_PICTURE_SHARE = 0.45;

/** 여러 시각의 회색 프레임(w×h)을 한 번에 뽑는다. area는 화소 평균으로 줄인다(띠 경계용). 실패하면 null. */
function grayFrames(video: string, times: number[], w: number, h: number, area = false): Uint8Array[] | null {
  const graph = `${times.map((_, n) => `[${n}:v]scale=${w}:${h}${area ? ":flags=area" : ""},format=gray[g${n}]`).join(";")};${times.map((_, n) => `[g${n}]`).join("")}${times.length > 1 ? `vstack=inputs=${times.length}` : "null"}`;
  const res = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", ...times.flatMap((t) => ["-ss", Math.max(0, t).toFixed(3), "-i", video]), "-filter_complex", graph, "-frames:v", "1", "-f", "rawvideo", "-"], { maxBuffer: 4 * 1024 * 1024 });
  if (res.status !== 0 || !res.stdout || res.stdout.length < w * h * times.length) return null;
  return times.map((_, n) => new Uint8Array(res.stdout.subarray(n * w * h, (n + 1) * w * h)));
}

/** 화면 전체 밝기 편차가 작으면 거의 한 색이다. */
export function nearlyFlat(px: Uint8Array): boolean {
  if (!px.length) return false;
  const mean = px.reduce((a, b) => a + b, 0) / px.length;
  const spread = Math.sqrt(px.reduce((a, b) => a + (b - mean) ** 2, 0) / px.length);
  return spread < BLANK_SPREAD;
}

/** 위 · 아래 끝에서 이어지는 단색 띠를 걷어 낸 그림 높이의 비율(0~1). w×h 회색 화소. */
export function pictureShare(px: Uint8Array, w: number, h: number): number {
  if (px.length < w * h || !h) return 1;
  const rows = Array.from({ length: h }, (_, y) => {
    const row = px.subarray(y * w, (y + 1) * w);
    const mean = row.reduce((a, b) => a + b, 0) / w;
    return { mean, spread: Math.sqrt(row.reduce((a, b) => a + (b - mean) ** 2, 0) / w) };
  });
  const band = (from: number, step: number) => {
    let n = 0;
    for (let y = from; y >= 0 && y < h && rows[y].spread < BAR_ROW_SPREAD && Math.abs(rows[y].mean - rows[from].mean) < BAR_ROW_SHIFT; y += step) n++;
    return n;
  };
  const top = band(0, 1);
  // 화면 전체가 한 색이면 위에서 이미 다 걷힌다
  const bottom = top >= h ? 0 : band(h - 1, -1);
  return Math.max(0, 1 - (top + bottom) / h);
}

/** 기본 편집에서 쓰던 정보로 촬영본을 읽는다. */
export function readClip(no: number, file: string, cut: Omit<EditClipInfo, "no" | "duration">): KitClip {
  const info = probe(file);
  return { ...cut, no, file, duration: info.duration, hasAudio: info.hasAudio, hdrTransfer: info.hdrTransfer };
}


import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { writeEditPlan, type EditClipInfo, type EditPlan } from "@/lib/agents/edit-plan";
import { editKit, editKitAsset, ttsReading } from "@/lib/agents/ko-skills";
import type { ProductFacts } from "@/lib/agents/product-facts";
import { agentModel } from "@/lib/agents/runner";
import { getOpenAI } from "@/lib/openai";
import { callOptions } from "@/lib/products/analysis/analyze";
import type { ContentRule } from "@/lib/rules/check";
import { DEFAULT_EDIT_STYLE, type EditStyle } from "@/lib/shoot/edit-style";
import { normalizeLook, type Look } from "@/lib/shoot/video-kit/caption-style";
import { captionSkillDir, designCaptions, overlayCaptions, type CaptionDesign } from "@/lib/shoot/video-kit/caption-skill";
import { findMusic, libraryMusic, reloadMusic, type MusicSource, type MusicToUse, type PickedMusic } from "@/lib/shoot/video-kit/music";
import { frameZones, runVisionTool, subjectZones } from "@/lib/shoot/video-kit/vision-tools";
import { concatSegments, probe, renderSegment } from "@/lib/shoot/ffmpeg";
import { captionZones, writeCoverProject, writeProject, type BehindWord } from "@/lib/shoot/video-kit/compose";
import { layoutBeats, timeText, type TimedCut, type Timeline, type VoiceClip } from "@/lib/shoot/video-kit/timeline";
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
  humanHook?: string | null;
  humanThumbnail?: string | null;
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
  const beats = plan.beats
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
    }))
    .filter((b) => b.cuts.length > 0 && (b.mode === "live" || b.tts.trim()));
  if (beats.length === 0) throw new Error("편집 계획에 쓸 컷이 없어요");
  const thumb = seconds.has(plan.thumbnail.clip) ? plan.thumbnail : { ...plan.thumbnail, clip: beats[0].cuts[0].clip, at: beats[0].cuts[0].in };
  return { ...plan, beats, thumbnail: thumb };
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
  if (syllables > 240) problems.push("대본이 너무 길어요. 35초 안에 들어오게 줄이세요.");
  if (all.length < 6) problems.push(`컷이 ${all.length}개뿐이에요. 비트를 나눠 컷을 더 쓰세요.`);
  if (!plan.beats[plan.beats.length - 1]?.graphics.some((g) => g.type === "end_card")) problems.push("마지막 비트에 end_card가 없어요.");
  if (squash(plan.hook.on_screen).length > 22) problems.push("후킹 글자가 너무 길어요. 12자 안팎으로 줄이세요.");
  return [...new Set(problems)];
}

async function makeVoices(plan: EditPlan, clips: KitClip[], workDir: string, voiceId: string | null | undefined): Promise<{ voices: VoiceClip[]; usedVoice: boolean; warnings: string[] }> {
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

function buildSegments(plan: EditPlan, tl: Timeline): KitSegment[] {
  return tl.cuts.map((c, i) => {
    const caps = tl.captions.filter((x) => x.start >= c.start - 0.001 && x.start < c.end);
    const texts = tl.graphics.filter((g) => g.start >= c.start && g.start < c.end).map((g) => g.g.text).filter(Boolean);
    return {
      cut: c.clip,
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

function makeCover(version: string, workDir: string, clip: KitClip, thumb: EditPlan["thumbnail"], look: Look): string {
  const frame = join(workDir, "cover-frame.jpg");
  const at = Math.min(Math.max(0, thumb.at), Math.max(0, clip.duration - 0.1));
  ffmpeg(["-y", "-v", "error", "-ss", at.toFixed(3), "-i", clip.file, "-frames:v", "1", "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920", "-q:v", "2", frame]);
  const dir = join(workDir, "cover");
  mkdirSync(dir, { recursive: true });
  // 표지 글자도 상품을 피한다. 자리를 못 읽으면 AI가 정한 자리
  const cover0 = frameZones([frame], workDir)?.[0];
  const plan = cover0 ? { ...thumb, position: cover0.top <= cover0.lower ? ("top" as const) : ("lower" as const) } : thumb;
  writeCoverProject(dir, frame, plan, look);
  const outDir = join(workDir, "cover-out");
  hyperframes(version, dir, ["snapshot", "--at", "0.5", "--no-end", "-o", outDir], 5 * 60_000);
  const png = readdirSync(outDir).find((f) => f.endsWith(".png"));
  if (!png) throw new Error("표지를 만들지 못했어요");
  const cover = join(workDir, "cover.jpg");
  ffmpeg(["-y", "-v", "error", "-i", join(outDir, png), "-q:v", "2", cover]);
  return cover;
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
      shotlistHook: input.shotlistHook,
      shotlistThumbnail: input.shotlistThumbnail,
      fixedHook: input.fixedHook,
      fixedEnding: input.fixedEnding,
      tone: input.tone,
      editStyle: input.editStyleText,
      source: input.source,
      scriptLines: input.scriptLines,
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
  const look = normalizeLook(plan.look);

  // 2. 음성 → 시각표
  const made = await makeVoices(plan, clips, workDir, input.voiceId);
  warnings.push(...made.warnings);
  const seconds = new Map(clips.map((c) => [c.no, c.duration]));
  const base = layoutBeats(plan, made.voices, seconds);

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

  // 4. 컷 → 믹스 → 프로젝트
  const baseVideo = renderCuts(tl, clips, workDir, input.style ?? DEFAULT_EDIT_STYLE);
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
  const zones = subjectZones(baseVideo, tl.cuts, workDir)?.map((z, i) => {
    const owner = clips.find((c) => c.no === tl.cuts[i]?.clip);
    return owner?.shot?.startsWith("[코드 모션]") ? { ...z, cover: { ...z.cover, mid: 1 } } : z;
  }) ?? null;
  const behind = makeBehindWord(look, tl, clips, baseVideo, project, workDir);
  writeProject(project, tl, { look, zones, behind });

  // 5. 프레임 검수 — 표적을 벗어난 표시는 빼고, 나머지는 사람에게 넘긴다
  const qa = await qaFrames(version, project, tl, workDir);
  tokens.input += qa.tokens.input;
  tokens.output += qa.tokens.output;
  warnings.push(...qa.issues);
  if (qa.drop.size) {
    tl = { ...tl, graphics: tl.graphics.filter((g) => !qa.drop.has(g.id) || (g.type !== "ring" && g.type !== "arrow")) };
    writeProject(project, tl, { look, zones, behind });
  }

  // 6. 렌더 · 표지
  // 자막 모션 스킬을 쓸 수 있으면 자막 없이 렌더한 뒤 얹는다. 안 되면 지금까지의 자막으로 렌더한다
  const skillDir = captionSkillDir();
  const priorDesign = (input.reusePlan as (EditPlan & { captionDesign?: CaptionDesign }) | null | undefined)?.captionDesign;
  let design: CaptionDesign | null = null;
  if (skillDir && tl.captions.length) {
    try {
      if (priorDesign?.lines?.[0]?.rows) design = priorDesign;
      else {
        const made = await designCaptions({ dir: skillDir, captions: tl.captions, product: input.facts.name, look, tone: input.tone, styleText: input.editStyleText });
        design = made.design;
        tokens.input += made.tokens.input;
        tokens.output += made.tokens.output;
      }
      writeProject(project, tl, { look, zones, behind, noCaptions: true });
    } catch (e) {
      design = null;
      warnings.push(`자막 모션 스킬을 쓰지 못해 기본 자막으로 만들었어요. (${e instanceof Error ? e.message : e})`.slice(0, 300));
    }
  }
  let final = join(workDir, "final.mp4");
  try {
    hyperframes(version, project, ["render", "-o", final, "-q", "standard", "--video-bitrate", "10M", "--skill", "hyperframes"]);
  } catch (e) {
    // 제품 뒤 글자가 렌더를 막으면 그 효과만 빼고 다시 만든다
    if (!behind) throw e;
    console.warn("[video-kit] 제품 뒤 글자를 빼고 다시 렌더:", e instanceof Error ? e.message : e);
    writeProject(project, tl, { look, zones, behind: null, noCaptions: !!design });
    hyperframes(version, project, ["render", "-o", final, "-q", "standard", "--video-bitrate", "10M", "--skill", "hyperframes"]);
  }
  if (!existsSync(final) || mediaSeconds(final) < 1) throw new Error("렌더 결과가 없어요");
  if (design && skillDir) {
    try {
      final = overlayCaptions({ dir: skillDir, video: final, captions: tl.captions, zones: captionZones(tl, zones), design, look, workDir });
    } catch (e) {
      console.warn("[video-kit] 자막 모션 실패, 기본 자막으로 다시 렌더:", e instanceof Error ? e.message : e);
      warnings.push(`자막 모션 스킬을 쓰지 못해 기본 자막으로 만들었어요. (${e instanceof Error ? e.message : e})`.slice(0, 300));
      design = null;
      writeProject(project, tl, { look, zones, behind: null });
      hyperframes(version, project, ["render", "-o", final, "-q", "standard", "--video-bitrate", "10M", "--skill", "hyperframes"]);
    }
  }
  const coverClip = clips.find((c) => c.no === plan.thumbnail.clip) ?? clips[0];
  const cover = makeCover(version, workDir, coverClip, plan.thumbnail, look);

  const hookText = plan.hook.on_screen.replace(/\n+/g, " ");
  return {
    final,
    cover,
    seconds: mediaSeconds(final),
    plan: { ...plan, pickedMusic: { name: music.name, in: music.in, gain_db: music.gain_db, source: music.source, query: music.query }, ...(design ? { captionDesign: design } : {}) } as EditPlan,
    timeline: tl,
    segments: buildSegments(plan, tl),
    hook: { text: hookText, source: input.humanHook?.trim() ? "human" : input.fixedHook?.trim() ? "saved" : "ai" },
    warnings: [...new Set(warnings)],
    sounds,
    loudness: lufs(final),
    tokens,
    usedVoice: made.usedVoice,
  };
}

/** 기본 편집에서 쓰던 정보로 촬영본을 읽는다. */
export function readClip(no: number, file: string, cut: Omit<EditClipInfo, "no" | "duration">): KitClip {
  const info = probe(file);
  return { ...cut, no, file, duration: info.duration, hasAudio: info.hasAudio, hdrTransfer: info.hdrTransfer };
}


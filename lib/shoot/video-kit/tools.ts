import { spawnSync } from "node:child_process";
import { createReadStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { getOpenAI } from "@/lib/openai";

// 편집 키트의 바깥 도구 — FFmpeg · HyperFrames · Fish Audio · 받아쓰기.
// 로컬 시험은 FFMPEG_PATH · FFPROBE_PATH 환경변수로 경로를 준다(lib/shoot/ffmpeg.ts와 같다).

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

export function ffmpeg(args: string[]): string {
  const r = spawnSync(FFMPEG, ["-nostdin", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`ffmpeg 실행 실패: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffmpeg 오류(${r.status}): ${(r.stderr || "").split("\n").slice(-6).join(" ").slice(0, 600)}`);
  // 측정 필터는 stderr에 쓴다
  return `${r.stdout}\n${r.stderr}`;
}

export function mediaSeconds(file: string): number {
  const r = spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" });
  return Number((r.stdout || "").trim()) || 0;
}

/** 앞뒤 무음을 뺀 소리 구간. */
export function voicedSpan(file: string): { from: number; to: number } {
  const total = mediaSeconds(file);
  const out = ffmpeg(["-hide_banner", "-i", file, "-af", "silencedetect=noise=-38dB:d=0.08", "-f", "null", "-"]);
  const starts = [...out.matchAll(/silence_start: ([0-9.]+)/g)].map((m) => Number(m[1]));
  const ends = [...out.matchAll(/silence_end: ([0-9.]+)/g)].map((m) => Number(m[1]));
  const from = starts.length && starts[0] < 0.02 && ends.length ? ends[0] : 0;
  const last = starts[starts.length - 1];
  const to = last != null && last > from && (ends.length < starts.length || ends[ends.length - 1] >= total - 0.02) ? last : total;
  return { from: Math.max(0, from - 0.02), to: Math.min(total, to + 0.06) };
}

/** 촬영본 프레임 묶음 (시각 표시). 반환은 jpg 경로. 낮은 해상도로 토큰을 아낀다. */
export function contactSheet(input: string, out: string, opts: { from?: number; to?: number; frames?: number } = {}): string {
  const total = mediaSeconds(input);
  const from = Math.max(0, opts.from ?? 0);
  const to = Math.min(total || Infinity, opts.to ?? total);
  const frames = opts.frames ?? 12;
  const step = Math.max(0.05, (to - from) / frames);
  const label = `text='%{eif\\:t+${from.toFixed(2)}\\:d}.%{eif\\:mod((t+${from.toFixed(2)})*10\\,10)\\:d}':x=4:y=4:fontsize=22:fontcolor=yellow:box=1:boxcolor=black@0.7`;
  ffmpeg([
    "-y", "-v", "error",
    "-ss", from.toFixed(3),
    "-t", (to - from).toFixed(3),
    "-i", input,
    "-an",
    "-vf", `fps=1/${step.toFixed(3)},scale=180:-2,drawtext=${label},tile=${Math.min(6, frames)}x${Math.ceil(frames / 6)}`,
    "-frames:v", "1",
    "-q:v", "5",
    out,
  ]);
  return out;
}

export function imageDataUrl(file: string, mime = "image/jpeg"): string {
  return `data:${mime};base64,${readFileSync(file).toString("base64")}`;
}

/** HyperFrames CLI. 버전은 kit.json에 고정한다. */
export function hyperframes(version: string, cwd: string, args: string[], timeoutMs = 25 * 60_000): string {
  const command = `npx --yes hyperframes@${version} ${args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ")}`;
  const r = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: timeoutMs,
    env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: "1", HYPERFRAMES_NO_UPDATE_CHECK: "1", NO_COLOR: "1" },
  });
  if (r.error) throw new Error(`hyperframes 실행 실패: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`hyperframes ${args[0]} 오류(${r.status}): ${`${r.stderr}\n${r.stdout}`.split("\n").slice(-12).join(" ").slice(0, 800)}`);
  return r.stdout;
}

/** Fish Audio TTS. 키가 없으면 null — 호출한 쪽이 음성 없이 이어 간다(다른 유료 서비스로 넘어가지 않는다). */
export async function fishTts(text: string, voice: { id: string; model: string; speed: number }): Promise<Buffer | null> {
  const key = process.env.FISH_API_KEY;
  if (!key) return null;
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", model: voice.model },
      body: JSON.stringify({ text, reference_id: process.env.FISH_VOICE_ID || voice.id, format: "wav", normalize: true, latency: "normal", prosody: { speed: voice.speed, volume: 0 } }),
      signal: AbortSignal.timeout(120_000),
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    last = `${res.status} ${(await res.text()).slice(0, 200)}`;
    if (res.status < 500 && res.status !== 429) break;
  }
  throw new Error(`Fish Audio 오류: ${last}`);
}

export type Spoken = { text: string; start: number; end: number };

/** 낱말 시각 받아쓰기. 파일을 줄여 보낸다. 대본을 힌트로 주지 않아 발음 확인에도 쓴다. */
export async function transcribeWords(file: string, workDir: string, hint?: string): Promise<{ words: Spoken[]; segments: Spoken[]; text: string }> {
  const small = join(workDir, `stt-${Date.now()}.mp3`);
  ffmpeg(["-y", "-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "64k", small]);
  const r = await getOpenAI().audio.transcriptions.create({
    file: createReadStream(small),
    model: "whisper-1",
    language: "ko",
    ...(hint ? { prompt: hint.slice(0, 200) } : {}),
    response_format: "verbose_json",
    timestamp_granularities: ["word", "segment"],
  });
  return {
    text: r.text ?? "",
    words: (r.words ?? []).map((w) => ({ text: w.word, start: w.start, end: w.end })),
    segments: (r.segments ?? []).filter((s) => (s.no_speech_prob ?? 0) < 0.6 && s.text.trim()).map((s) => ({ text: s.text.trim(), start: s.start, end: s.end })),
  };
}

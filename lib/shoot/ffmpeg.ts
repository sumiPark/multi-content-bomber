import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// 직접 촬영 편집용 FFmpeg 다리 — GitHub Actions 러너(apt ffmpeg + fonts-nanum)에서 돈다. Vercel에서 부르면 안 된다.
// 로컬 시험은 FFMPEG_PATH · FFPROBE_PATH · SHOOT_FONT 환경변수로 경로를 준다.

export const OUT_W = 1080;
export const OUT_H = 1920;
const FPS = 30;

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
// 러너: fonts-nanum. 로컬(Windows): 맑은 고딕 굵게.
const FONT =
  process.env.SHOOT_FONT ||
  (process.platform === "win32" ? "C:/Windows/Fonts/malgunbd.ttf" : "/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf");

function run(bin: string, args: string[]): string {
  const r = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`${bin} 실행 실패: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${bin} 오류(${r.status}): ${(r.stderr || "").split("\n").slice(-6).join(" ").slice(0, 600)}`);
  return r.stdout;
}

export interface ProbeResult {
  duration: number;
  hasAudio: boolean;
  // HDR 촬영본이면 전달 함수(iPhone 기본 = arib-std-b67), 아니면 null
  hdrTransfer: string | null;
}

const HDR_TRANSFERS = ["arib-std-b67", "smpte2084"];

export function probe(file: string): ProbeResult {
  const out = run(FFPROBE, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,color_transfer", "-of", "json", file]);
  const j = JSON.parse(out) as { format?: { duration?: string }; streams?: { codec_type?: string; color_transfer?: string }[] };
  const transfer = (j.streams ?? []).find((s) => s.codec_type === "video")?.color_transfer;
  return {
    duration: Number(j.format?.duration ?? 0),
    hasAudio: (j.streams ?? []).some((s) => s.codec_type === "audio"),
    hdrTransfer: transfer && HDR_TRANSFERS.includes(transfer) ? transfer : null,
  };
}

let zscaleAvailable: boolean | null = null;

/** 색 변환 필터가 있는 FFmpeg인지 — 없는 빌드면 색이 바래더라도 편집은 끝낸다. */
function hasZscale(): boolean {
  if (zscaleAvailable == null) zscaleAvailable = /\bzscale\b/.test(run(FFMPEG, ["-hide_banner", "-filters"]));
  return zscaleAvailable;
}

/** HDR → 일반 영상(BT.709). 그대로 8비트로 내리면 iPhone 기본 촬영본의 색이 바래 보인다. */
function toneMapFilters(transfer: string): string[] {
  return [
    `zscale=tin=${transfer}:pin=2020:min=2020_ncl:t=linear:npl=100`,
    "format=gbrpf32le",
    "zscale=p=709",
    "tonemap=tonemap=hable:desat=0",
    "zscale=t=709:m=709:r=tv",
    "format=yuv420p",
  ];
}

/** drawtext 필터 값 이스케이프 (경로 · 옵션 안의 : ' \ ) */
function esc(v: string): string {
  return v.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

/** 한 줄 최대 maxChars로 — 공백에서 끊고, 없으면 글자 수로. */
function wrapLines(t: string, maxChars: number): string[] {
  if (t.length <= maxChars) return [t];
  const words = t.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= maxChars) cur += " " + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.flatMap((l) => (l.length <= maxChars ? [l] : l.match(new RegExp(`.{1,${maxChars}}`, "g")) ?? []));
}

/**
 * 문구를 두 줄 안에 넣는다. 안 들어가면 한 줄 글자 수를 늘리고 그만큼 글자를 줄인다.
 * 예전엔 둘째 줄에 나머지를 다 붙여 22자를 넘는 문구가 화면 밖으로 잘렸다(2026-11-04).
 */
export function fitLines(text: string, maxChars: number, size: number): { lines: string[]; size: number } {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return { lines: [], size };
  // 아주 긴 낱말 하나 때문에 글자가 너무 작아지지 않게, 절반 길이를 넘으면 낱말 중간에서 끊는다
  const half = Math.ceil(t.length / 2);
  const scaled = (chars: number) => Math.floor((size * maxChars) / chars);
  for (let chars = maxChars; chars <= half; chars++) {
    const lines = wrapLines(t, chars);
    if (lines.length <= 2) return { lines, size: scaled(chars) };
  }
  if (t.length <= maxChars) return { lines: [t], size };
  return { lines: t.match(new RegExp(`.{1,${half}}`, "g")) ?? [t], size: scaled(Math.max(half, maxChars)) };
}

interface TextLayer {
  lines: string[];
  // 첫 줄 위쪽 y (영상 높이 비율)
  top: number;
  size: number;
  box: boolean;
  // 이 시간(조각 기준 초)에만 보이기
  from?: number;
  to?: number;
}

function drawtext(layer: TextLayer, workDir: string, tag: string): string[] {
  return layer.lines.map((line, i) => {
    // 글자는 파일로 넘긴다 — 따옴표 · 콜론 · % 이스케이프 문제를 피한다
    const file = join(workDir, `${tag}-${i}.txt`);
    writeFileSync(file, line, "utf8");
    const y = Math.round(OUT_H * layer.top + i * layer.size * 1.3);
    return [
      `drawtext=fontfile='${esc(FONT)}'`,
      `textfile='${esc(file)}'`,
      "expansion=none",
      `fontsize=${layer.size}`,
      "fontcolor=white",
      "borderw=5",
      "bordercolor=black@0.85",
      ...(layer.box ? ["box=1", "boxcolor=black@0.45", "boxborderw=18"] : []),
      "x=(w-text_w)/2",
      `y=${y}`,
      ...(layer.from != null && layer.to != null ? [`enable='between(t\,${layer.from.toFixed(2)}\,${layer.to.toFixed(2)})'`] : []),
    ].join(":");
  });
}

export interface SegmentSpec {
  input: string;
  start: number;
  duration: number;
  hasAudio: boolean;
  // 화면 위쪽 문구(인스타 상단 UI 아래, 18%) · 아래쪽 말 자막(인스타 캡션 영역 위, 66%)
  onScreen: string;
  subtitles: { text: string; from: number; to: number }[];
  hdrTransfer: string | null;
}

/** 컷 하나 → 1080x1920 · 30fps · H.264 · AAC 48kHz 스테레오 조각 (모두 같은 규격이라 이어 붙일 때 다시 인코딩하지 않는다). */
export function renderSegment(spec: SegmentSpec, out: string, workDir: string, tag: string): void {
  const filters = [
    ...(spec.hdrTransfer && hasZscale() ? toneMapFilters(spec.hdrTransfer) : []),
    `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase`,
    `crop=${OUT_W}:${OUT_H}`,
    `fps=${FPS}`,
    "setsar=1",
    ...drawtext({ ...fitLines(spec.onScreen, 11, 84), top: 0.18, box: false }, workDir, `${tag}-top`),
    ...spec.subtitles.flatMap((sub, i) =>
      drawtext({ ...fitLines(sub.text, 16, 52), top: 0.66, box: true, from: sub.from, to: sub.to }, workDir, `${tag}-sub${i}`),
    ),
    "format=yuv420p",
  ];
  const args = ["-y", "-v", "error", "-ss", spec.start.toFixed(3), "-t", spec.duration.toFixed(3), "-i", spec.input];
  // 소리 없는 촬영본은 무음 트랙을 깔아 모든 조각의 오디오 규격을 맞춘다
  if (!spec.hasAudio) args.push("-f", "lavfi", "-t", spec.duration.toFixed(3), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
  args.push(
    "-vf",
    filters.join(","),
    "-map",
    "0:v:0",
    "-map",
    spec.hasAudio ? "0:a:0" : "1:a:0",
    "-af",
    "aresample=48000,aformat=channel_layouts=stereo",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-shortest",
    out,
  );
  run(FFMPEG, args);
}

/** 조각 이어 붙이기 + 소리 크기 맞추기(-14 LUFS, 인스타 권장 근처) + 빠른 재생 시작(faststart). */
export function concatSegments(segments: string[], out: string, workDir: string): void {
  const list = join(workDir, "concat.txt");
  writeFileSync(list, segments.map((s) => `file '${s.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
  run(FFMPEG, [
    "-y",
    "-v",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-c:v",
    "copy",
    "-af",
    "loudnorm=I=-14:TP=-1.5:LRA=11",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ar",
    "48000",
    "-movflags",
    "+faststart",
    out,
  ]);
}

/** 조각의 소리만 뽑기 (자막 받아쓰기용, 16kHz 모노). */
export function extractAudio(input: string, out: string): void {
  run(FFMPEG, ["-y", "-v", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "64k", out]);
}

/** 미리보기 그림 한 장 (완성본 확인 화면 · 표지 후보). */
export function snapshot(input: string, at: number, out: string): void {
  run(FFMPEG, ["-y", "-v", "error", "-ss", at.toFixed(2), "-i", input, "-frames:v", "1", "-q:v", "3", out]);
}

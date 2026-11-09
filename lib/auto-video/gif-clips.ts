import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ffmpeg, mediaSeconds } from "@/lib/shoot/video-kit/tools";

// 상세페이지의 움직이는 이미지를 영상 소재로 쓴다. 사진 처리는 GIF의 첫 프레임만 보기 때문에 따로 다룬다.
// 원본을 그대로 쓰고, 세로 화면에 들어가지 않는 부분은 흐린 복제 대신 영상 색에서 뽑은 단색 바탕으로 채운다.

const FRAME_W = 1080;
const FRAME_H = 1920;
const CLIP_SECONDS = 8;
const MIN_ANIMATED_SECONDS = 1;
const MAX_GIFS = 10;
const THUMB_W = 240;
const SHEET_FRAMES = 6;

export interface GifAsset {
  id: string;
  file: string;
  seconds: number;
  w: number;
  h: number;
  sheet: string;
}

export const isGif = (bytes: Uint8Array) => bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46;

function dimensions(file: string): { w: number; h: number } {
  const out = ffmpeg(["-hide_banner", "-i", file, "-frames:v", "1", "-f", "null", "-"]);
  const m = out.match(/,\s*(\d{2,5})x(\d{2,5})[,\s]/);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 0, h: 0 };
}

export function isAnimatedGif(file: string): boolean {
  return mediaSeconds(file) >= MIN_ANIMATED_SECONDS;
}

/** 움직이는 이미지마다 프레임 묶음을 만든다. 왼쪽부터 시간 순서다. */
export function prepareGifAssets(files: string[], workDir: string): GifAsset[] {
  const dir = join(workDir, "gifs");
  mkdirSync(dir, { recursive: true });
  const out: GifAsset[] = [];
  for (const file of files.slice(0, MAX_GIFS)) {
    try {
      const seconds = mediaSeconds(file);
      const id = `g${out.length + 1}`;
      const sheet = join(dir, `${id}.jpg`);
      const rate = Math.max(0.2, (SHEET_FRAMES / Math.max(0.5, seconds)) * 0.98).toFixed(3);
      ffmpeg(["-y", "-v", "error", "-i", file, "-vf", `fps=${rate},scale=${THUMB_W}:-2,tile=${SHEET_FRAMES}x1`, "-frames:v", "1", "-q:v", "4", sheet]);
      out.push({ id, file, seconds, sheet, ...dimensions(file) });
    } catch (e) {
      console.warn(`  움직이는 이미지 처리 실패(${file}):`, e instanceof Error ? e.message : e);
    }
  }
  return out;
}

export interface GifCrop {
  crop_x: number;
  crop_y: number;
  crop_w: number;
  crop_h: number;
  start_sec?: number;
  end_sec?: number;
}

/** 쓸 시간 구간. 값이 이상하거나 너무 짧으면 전체를 쓴다. */
export function gifRange(seconds: number, crop: GifCrop): { start: number; length: number } {
  const start = Math.min(seconds, Math.max(0, Number.isFinite(crop.start_sec) ? crop.start_sec! : 0));
  const end = Math.min(seconds, Number.isFinite(crop.end_sec) && crop.end_sec! > 0 ? crop.end_sec! : seconds);
  return end - start >= 0.5 ? { start, length: end - start } : { start: 0, length: seconds };
}

const unit = (n: number, fallback: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback);

/** 잘라 낼 구간을 픽셀로 바꾼다. 영상 코덱에 맞게 짝수로 맞추고, 너무 좁으면 전체를 쓴다. */
export function cropPixels(asset: { w: number; h: number }, crop: GifCrop): { x: number; y: number; w: number; h: number } {
  const x = unit(crop.crop_x, 0);
  const y = unit(crop.crop_y, 0);
  const w = Math.min(1 - x, unit(crop.crop_w, 1));
  const h = Math.min(1 - y, unit(crop.crop_h, 1));
  const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
  if (w * asset.w < 120 || h * asset.h < 120) return { x: 0, y: 0, w: even(asset.w), h: even(asset.h) };
  return { x: Math.round(x * asset.w), y: Math.round(y * asset.h), w: even(w * asset.w), h: even(h * asset.h) };
}

// ── 글자 띠를 반쯤 자르지 않기 ──
// 장면표 AI는 240px 썸네일 묶음을 보고 자를 구역을 비율로 낸다. 그 정도 눈금으로는 상세페이지의 제목 띠 바로 아래를 정확히 짚지 못해,
// 위 경계가 띠 안 글자 줄을 지나가며 글자 윗부분이 잘린 채 들어갔다(2026-11-09 시험 g5: "파이니티 리젠 / 버블 액티베이터" 빨간 띠).
// 그래서 자른 구역의 위 · 아래 경계가 글자 띠 안에 걸리면 코드가 원본 픽셀을 보고 경계를 띠 밖으로 옮긴다.
// 띠 판단은 photo_blocks.py와 같은 기준이다: 글자 · 그래픽 띠는 한 줄의 픽셀이 한 색(띠 바탕)에 몰리고, 사진은 색이 흩어진다.

export interface GifRow {
  /** 줄에서 가장 많은 색의 비율(색을 12단계로 뭉개서 잰다) */
  flat: number;
  /** 밝기가 크게 바뀌는 곳이 많은 줄 — 단색 바탕 위 글자 획 */
  text: boolean;
}
type Box = { x: number; y: number; w: number; h: number };
type Span = { start: number; end: number };

// 실측(g5, 자른 열 258px): 띠 줄은 0.43 이상, 사진 줄은 0.33 이하였다
const BAND_FLAT = 0.4;
// 글자 줄: 표본 열의 4% 이상에서 밝기가 크게 바뀐다(실측 글자 줄 12~40%, 사진 줄 0~3%)
const TEXT_EDGE_SHARE = 0.04;
const TEXT_EDGE_MIN = 4;
const EDGE_LUMA = 48;
const MIN_CROP = 120;
// 띠를 빼고 남는 높이가 원래 구역의 이 비율보다 작으면 빼지 않고 글자 줄을 통째로 넣는다
const KEEP_SHARE = 0.5;
const ROW_FRAMES = 3;

/** 프레임 한 장(rgb24)의 x0~x1 열에서 줄마다 단색 비율과 글자 획 여부를 잰다. 속도를 위해 열은 2px마다 본다. */
export function gifRows(rgb: Uint8Array, w: number, h: number, x0: number, x1: number): GifRow[] {
  return lineStats(rgb, w, h, "row", x0, x1);
}

/**
 * 프레임 한 장(rgb24)의 y0~y1 줄에서 열마다 단색 비율과 글자 획 여부를 잰다. 줄은 2px마다 본다.
 * 가로 글자 줄을 세로로 지나가는 열은 바탕 · 획이 번갈아 나와 밝기가 자주 바뀐다. 줄 단위 측정과 같은 기준이다.
 */
export function gifCols(rgb: Uint8Array, w: number, h: number, y0: number, y1: number): GifRow[] {
  return lineStats(rgb, w, h, "col", y0, y1);
}

/** row: 줄마다 from~to 열을 본다. col: 열마다 from~to 줄을 본다. */
function lineStats(rgb: Uint8Array, w: number, h: number, along: "row" | "col", fromAt: number, toAt: number): GifRow[] {
  const counts = new Uint16Array(21 * 21 * 21);
  const touched: number[] = [];
  const out: GifRow[] = [];
  const lines = along === "row" ? h : w;
  const span = along === "row" ? w : h;
  const from = Math.max(0, Math.min(span - 1, fromAt));
  const to = Math.max(from + 1, Math.min(span, toAt));
  for (let line = 0; line < lines; line++) {
    let n = 0;
    let best = 0;
    let edges = 0;
    let prev = -1;
    for (let p = from; p < to; p += 2) {
      const i = (along === "row" ? line * w + p : p * w + line) * 3;
      const k = Math.floor(rgb[i] / 12) * 441 + Math.floor(rgb[i + 1] / 12) * 21 + Math.floor(rgb[i + 2] / 12);
      if (counts[k] === 0) touched.push(k);
      counts[k]++;
      if (counts[k] > best) best = counts[k];
      const luma = (rgb[i] * 299 + rgb[i + 1] * 587 + rgb[i + 2] * 114) / 1000;
      if (prev >= 0 && Math.abs(luma - prev) > EDGE_LUMA) edges++;
      prev = luma;
      n++;
    }
    for (const k of touched) counts[k] = 0;
    touched.length = 0;
    const flat = n ? best / n : 0;
    out.push({ flat, text: flat >= BAND_FLAT && edges >= Math.max(TEXT_EDGE_MIN, n * TEXT_EDGE_SHARE) });
  }
  return out;
}

/** 여러 프레임을 합친다. 글자 띠는 움직이지 않으니 모든 프레임에서 띠 · 글자인 줄만 띠 · 글자로 본다. */
export function mergeGifRows(frames: GifRow[][]): GifRow[] {
  if (!frames.length) return [];
  return frames[0].map((_, y) => ({ flat: Math.min(...frames.map((f) => f[y]?.flat ?? 0)), text: frames.every((f) => f[y]?.text ?? false) }));
}

/** 참인 줄의 구간. gap 이하의 틈은 잇는다. */
function spansOf(mask: boolean[], gap: number): Span[] {
  const out: Span[] = [];
  let start = -1;
  let last = -1;
  mask.forEach((v, i) => {
    if (!v) return;
    if (start < 0) start = i;
    else if (i - last > gap + 1) {
      out.push({ start, end: last + 1 });
      start = i;
    }
    last = i;
  });
  if (start >= 0) out.push({ start, end: last + 1 });
  return out;
}

/**
 * 한 축(세로면 줄, 가로면 열)에서 자른 구역의 두 경계 [start, start+size)가 글자 띠 안에 걸리면 경계를 옮긴다.
 * ① 띠를 통째로 뺀다(장면표가 글자를 피해 잡으려던 뜻). ② 빼면 남는 화면이 너무 작으면, 경계가 지나가던 글자 줄을 통째로 넣는다.
 * 옮길 일이 없으면 null.
 */
function shiftEdges(lines: GifRow[], start: number, size: number): { start: number; end: number } | null {
  if (lines.length < start + size) return null;
  const bands = spansOf(lines.map((r) => r.flat >= BAND_FLAT), 4);
  const texts = spansOf(lines.map((r) => r.text), 6);
  const keep = Math.max(MIN_CROP, size * KEEP_SHARE);
  // 띠 안에서 [from, to) 구역에 들어오는 글자가 있나
  const textIn = (band: Span, from: number, to: number) => texts.some((l) => l.start < Math.min(band.end, to) && l.end > Math.max(band.start, from));
  const cutText = (at: number) => texts.find((l) => l.start < at && at < l.end);
  let lo = start;
  let hi = start + size;
  const loBand = bands.find((b) => b.start < lo && lo < b.end);
  if (loBand && textIn(loBand, lo, hi)) {
    if (hi - loBand.end >= keep) lo = loBand.end;
    else {
      const t = cutText(lo);
      if (t) lo = Math.max(0, t.start - 2);
    }
  }
  const hiBand = bands.find((b) => b.start < hi && hi < b.end);
  if (hiBand && textIn(hiBand, lo, hi)) {
    if (hiBand.start - lo >= keep) hi = hiBand.start;
    else {
      const t = cutText(hi);
      if (t) hi = Math.min(lines.length, t.end + 2);
    }
  }
  return lo === start && hi === start + size ? null : { start: lo, end: hi };
}

const evenSize = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/**
 * 자른 구역의 위 · 아래 경계가 글자 띠 안에 걸리면 경계를 옮긴다.
 * 어느 쪽이든 글자 줄을 가로로 반쯤 자르지 않는다. 경계가 띠에 걸리지 않으면 그대로 둔다.
 */
export function avoidTextCut(rows: GifRow[], c: Box): Box {
  const moved = shiftEdges(rows, c.y, c.h);
  return moved ? { x: c.x, y: moved.start, w: c.w, h: evenSize(moved.end - moved.start) } : c;
}

/**
 * 자른 구역의 왼쪽 · 오른쪽 경계가 글자 띠 안에 걸리면 경계를 옮긴다. avoidTextCut과 같은 원리를 열 단위로 한다.
 * 상세페이지에서 사진 옆에 붙은 설명 글 칸을 경계가 세로로 지나가면 글자가 반쪽만 들어간다.
 * 그 칸을 통째로 빼거나, 빼면 너무 좁아질 때는 지나가던 낱말을 통째로 넣는다.
 */
export function avoidSideCut(cols: GifRow[], c: Box): Box {
  const moved = shiftEdges(cols, c.x, c.w);
  return moved ? { x: moved.start, y: c.y, w: evenSize(moved.end - moved.start), h: c.h } : c;
}

/** 쓸 구간에서 프레임 몇 장을 원본 크기(rgb24)로 읽는다. 읽지 못하면 null(자르기를 그대로 쓴다). */
function readGifFrames(asset: GifAsset, range: { start: number; length: number }): Uint8Array[] | null {
  if (asset.w < 2 || asset.h < 2) return null;
  const size = asset.w * asset.h * 3;
  const ffmpegBin = process.env.FFMPEG_PATH || "ffmpeg";
  const rate = (ROW_FRAMES / Math.max(0.5, range.length)).toFixed(3);
  const r = spawnSync(ffmpegBin, ["-nostdin", "-v", "error", "-ss", range.start.toFixed(2), "-t", range.length.toFixed(2), "-i", asset.file, "-vf", `fps=${rate}`, "-frames:v", String(ROW_FRAMES), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: size * (ROW_FRAMES + 1) });
  const b = r.stdout as Buffer | null;
  if (r.status !== 0 || !b || b.length < size) return null;
  const frames: Uint8Array[] = [];
  for (let at = 0; at + size <= b.length; at += size) frames.push(b.subarray(at, at + size));
  return frames;
}

/**
 * 고른 구역의 네 경계가 글자를 자르지 않게 옮긴다. 위 · 아래를 먼저 고친 뒤, 고친 줄 범위에서 열을 재서 왼쪽 · 오른쪽을 고친다.
 * 프레임이 없으면(원본을 못 읽으면) 고른 구역 그대로.
 */
export function avoidTextCuts(frames: Uint8Array[] | null, size: { w: number; h: number }, asked: Box): Box {
  if (!frames?.length) return asked;
  const vertical = avoidTextCut(mergeGifRows(frames.map((f) => gifRows(f, size.w, size.h, asked.x, asked.x + asked.w))), asked);
  return avoidSideCut(mergeGifRows(frames.map((f) => gifCols(f, size.w, size.h, vertical.y, vertical.y + vertical.h))), vertical);
}

function dominantColor(file: string, c: { x: number; y: number; w: number; h: number }): string {
  const ffmpegBin = process.env.FFMPEG_PATH || "ffmpeg";
  const r = spawnSync(ffmpegBin, ["-nostdin", "-v", "error", "-i", file, "-frames:v", "1", "-vf", `crop=${c.w}:${c.h}:${c.x}:${c.y},scale=1:1:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const b = r.stdout as Buffer | null;
  if (!b || b.length < 3) return "0x202225";
  // 글자와 부딪히지 않게 어둡게 눌러 바탕으로 쓴다
  const dark = (v: number) => Math.round(v * 0.28).toString(16).padStart(2, "0");
  return `0x${dark(b[0])}${dark(b[1])}${dark(b[2])}`;
}

/** 자른 구역 · 구간을 세로 영상 컷으로 만든다. 한 번 재생한 뒤 마지막 장면을 유지한다. */
export function gifClip(asset: GifAsset, crop: GifCrop, workDir: string): { file: string; soft: boolean } {
  const range = gifRange(asset.seconds, crop);
  const asked = cropPixels(asset, crop);
  // 위 · 아래 · 왼쪽 · 오른쪽 경계가 글자 띠를 지나가면 띠 밖으로 옮긴다. 원본을 못 읽으면 고른 구역 그대로 쓴다
  const c = avoidTextCuts(readGifFrames(asset, range), asset, asked);
  const scale = Math.min(FRAME_W / c.w, FRAME_H / c.h);
  const w = Math.floor((c.w * scale) / 2) * 2;
  const h = Math.floor((c.h * scale) / 2) * 2;
  const file = join(workDir, `${asset.id}-clip.mp4`);
  const color = dominantColor(asset.file, c);
  const hold = Math.max(0, CLIP_SECONDS - range.length + 0.2).toFixed(2);
  ffmpeg([
    "-y", "-v", "error", "-ss", range.start.toFixed(2), "-t", range.length.toFixed(2), "-i", asset.file,
    "-vf", `crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${w}:${h}:flags=lanczos,unsharp=5:5:0.6,pad=${FRAME_W}:${FRAME_H}:(ow-iw)/2:(oh-ih)/2:color=${color},fps=30,tpad=stop_mode=clone:stop_duration=${hold},format=yuv420p`,
    "-t", String(CLIP_SECONDS), "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "18", file,
  ]);
  return { file, soft: scale > 2.4 };
}

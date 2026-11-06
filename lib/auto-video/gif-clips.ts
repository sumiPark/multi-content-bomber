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

function dominantColor(file: string, c: { x: number; y: number; w: number; h: number }): string {
  const ffmpegBin = process.env.FFMPEG_PATH || "ffmpeg";
  const r = spawnSync(ffmpegBin, ["-nostdin", "-v", "error", "-i", file, "-frames:v", "1", "-vf", `crop=${c.w}:${c.h}:${c.x}:${c.y},scale=1:1:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const b = r.stdout as Buffer | null;
  if (!b || b.length < 3) return "0x202225";
  // 글자와 부딪히지 않게 어둡게 눌러 바탕으로 쓴다
  const dark = (v: number) => Math.round(v * 0.28).toString(16).padStart(2, "0");
  return `0x${dark(b[0])}${dark(b[1])}${dark(b[2])}`;
}

/** 자른 구간을 세로 영상 컷으로 만든다. 한 번 재생한 뒤 마지막 장면을 유지한다. */
export function gifClip(asset: GifAsset, crop: GifCrop, workDir: string): { file: string; soft: boolean } {
  const c = cropPixels(asset, crop);
  const scale = Math.min(FRAME_W / c.w, FRAME_H / c.h);
  const w = Math.floor((c.w * scale) / 2) * 2;
  const h = Math.floor((c.h * scale) / 2) * 2;
  const file = join(workDir, `${asset.id}-clip.mp4`);
  const color = dominantColor(asset.file, c);
  const hold = Math.max(0, CLIP_SECONDS - asset.seconds + 0.2).toFixed(2);
  ffmpeg([
    "-y", "-v", "error", "-i", asset.file,
    "-vf", `crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${w}:${h}:flags=lanczos,unsharp=5:5:0.6,pad=${FRAME_W}:${FRAME_H}:(ow-iw)/2:(oh-ih)/2:color=${color},fps=30,tpad=stop_mode=clone:stop_duration=${hold},format=yuv420p`,
    "-t", String(CLIP_SECONDS), "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "18", file,
  ]);
  return { file, soft: scale > 2.4 };
}

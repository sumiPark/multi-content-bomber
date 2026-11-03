import sharp from "sharp";
import { isShopAsset, type ShopCode } from "@/lib/products/shops";

// 상세 이미지 내려받기 · 자르기.
// 몰 상세페이지는 세로 1~2만 px짜리 통이미지라 그대로 AI에 보내면 글자가 뭉개진다. 리유 분석
// 프로젝트(ChatGPT-Codex/ai-recommend lib/automatic-analysis.ts)와 같은 방식으로 자른다:
//   가로 1000px로 줄임(확대 없음) → 세로 12,000px 파트(앞 파트와 150px 겹침) → 파트 안에서
//   1650px 타일(1500px 간격, 150px 겹침). 파트 하나 = AI 호출 1회, 호출당 타일 최대 8장.
// 겹치는 이유: 경계에 걸친 글줄이 잘려 양쪽 다 못 읽는 일을 막는다.

const DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_BYTES = 15 * 1024 * 1024;
const TARGET_WIDTH = 1000;
const PART_HEIGHT = 12_000;
const TILE_HEIGHT = 1650;
const TILE_STEP = 1500;
const OVERLAP = 150;
// 너무 작은 조각(구분선 · 여백)은 버린다.
const MIN_TILE_HEIGHT = 120;

export interface ImagePart {
  index: number; // 0부터
  count: number;
  tiles: string[]; // data:image/jpeg;base64,...
}

export interface PreparedImage {
  width: number;
  height: number;
  // GIF 등 움직이는 이미지는 첫 장면만 쓴다 — 추출 결과에 불확실 항목으로 남긴다.
  animated: boolean;
  parts: ImagePart[];
}

export async function downloadImage(url: string, shop: ShopCode): Promise<Buffer> {
  if (!isShopAsset(url, shop)) throw new Error(`허용되지 않은 이미지 주소: ${url}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`이미지 내려받기 실패 (${res.status}): ${url}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES) throw new Error(`이미지가 너무 큼 (${Math.round(len / 1e6)}MB): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`이미지가 너무 큼: ${url}`);
  return buf;
}

export async function prepareImage(buf: Buffer): Promise<PreparedImage> {
  const meta = await sharp(buf, { limitInputPixels: 60_000_000 }).metadata();
  const animated = (meta.pages ?? 1) > 1;

  // 첫 프레임만, 회전 정보 반영, 가로 1000px 이하로.
  const normalized = await sharp(buf, { limitInputPixels: 60_000_000, page: 0 })
    .rotate()
    .resize({ width: TARGET_WIDTH, withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 85 })
    .toBuffer({ resolveWithObject: true });
  const { width, height } = normalized.info;

  const partStarts: number[] = [];
  for (let start = 0; start < height; start += PART_HEIGHT) {
    partStarts.push(Math.max(0, start - (start === 0 ? 0 : OVERLAP)));
  }

  const parts: ImagePart[] = [];
  for (let p = 0; p < partStarts.length; p++) {
    const top = partStarts[p];
    const bottom = Math.min(height, (p + 1) * PART_HEIGHT);
    const tiles: string[] = [];
    for (let y = top; y < bottom; y += TILE_STEP) {
      const h = Math.min(TILE_HEIGHT, bottom - y);
      if (h < MIN_TILE_HEIGHT && tiles.length > 0) break;
      const tile = await sharp(normalized.data)
        .extract({ left: 0, top: y, width, height: h })
        .jpeg({ quality: 85 })
        .toBuffer();
      tiles.push(`data:image/jpeg;base64,${tile.toString("base64")}`);
      if (y + h >= bottom) break;
    }
    parts.push({ index: p, count: partStarts.length, tiles });
  }
  return { width, height, animated, parts };
}

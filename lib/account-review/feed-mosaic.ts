import sharp from "sharp";

// 피드 진열 분석용 합성 이미지 — 최근 게시물 표지를 실제 피드처럼 3열로 이어 붙인다.
// 표지를 한 장씩 보면 색 · 글꼴 통일감이나 게시물 배치를 판단할 수 없어서 한 장으로 본다.
// 칸 비율은 인스타 프로필 격자(3:4)에 맞춰 가운데를 자른다. 앱의 실제 잘림과는 조금 다를 수 있다.

const COLUMNS = 3;
const CELL_WIDTH = 360;
const CELL_HEIGHT = 480;
const GAP = 6;
const IMAGE_TIMEOUT_MS = 15_000;

async function cell(url: string | null): Promise<Buffer | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
    if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("image/")) return null;
    return await sharp(Buffer.from(await res.arrayBuffer()))
      .resize(CELL_WIDTH, CELL_HEIGHT, { fit: "cover", position: "centre" })
      .jpeg({ quality: 82 })
      .toBuffer();
  } catch {
    return null;
  }
}

export interface FeedMosaic {
  jpeg: Buffer;
  // 표지를 받은 칸 수 (못 받은 칸은 회색으로 남는다)
  cells: number;
  total: number;
}

/** 표지 주소(최신순) → 3열 합성 JPEG. 한 장도 못 받으면 null. */
export async function buildFeedMosaic(urls: (string | null)[]): Promise<FeedMosaic | null> {
  if (urls.length === 0) return null;
  const images = await Promise.all(urls.map(cell));
  const cells = images.filter(Boolean).length;
  if (cells === 0) return null;

  const rows = Math.ceil(images.length / COLUMNS);
  const width = COLUMNS * CELL_WIDTH + (COLUMNS - 1) * GAP;
  const height = rows * CELL_HEIGHT + (rows - 1) * GAP;
  const jpeg = await sharp({ create: { width, height, channels: 3, background: { r: 232, g: 235, b: 239 } } })
    .composite(
      images.flatMap((input, i) =>
        input
          ? [{ input, left: (i % COLUMNS) * (CELL_WIDTH + GAP), top: Math.floor(i / COLUMNS) * (CELL_HEIGHT + GAP) }]
          : [],
      ),
    )
    .jpeg({ quality: 80 })
    .toBuffer();
  return { jpeg, cells, total: images.length };
}

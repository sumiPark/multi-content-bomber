// 사진 게시물(contents.media_type = 'IMAGE')에는 인스타 캐러셀용 영상도 섞일 수 있다(2026-11-10).
// 장마다 사진인지 영상인지는 저장 경로의 확장자로 가른다 — lib/storage/upload.ts가 MIME으로
// 확장자를 붙이므로(mp4 · mov = 영상) 따로 컬럼을 두지 않는다.
// 섞인 캐러셀은 인스타 전용이다(유튜브 · 틱톡은 사진 게시물을 올리지 않는다).

export type MediaItemKind = "IMAGE" | "VIDEO";

const VIDEO_EXT = /\.(mp4|mov)$/i;
const VIDEO_MIMES = ["video/mp4", "video/quicktime"];

export function isVideoPath(path: string): boolean {
  return VIDEO_EXT.test(path.split("?")[0] ?? path);
}

export function isVideoFile(file: { type: string }): boolean {
  return VIDEO_MIMES.includes(file.type);
}

export function mediaItemKinds(paths: string[]): MediaItemKind[] {
  return paths.map((p) => (isVideoPath(p) ? "VIDEO" : "IMAGE"));
}

export function countMediaKinds(paths: string[]): { images: number; videos: number } {
  const videos = paths.filter(isVideoPath).length;
  return { images: paths.length - videos, videos };
}

// 캐러셀 안 영상 한 개의 길이 범위(초). 메타 공식 문서에 캐러셀 영상 길이가 따로 적혀 있지 않아
// 여러 예약 도구 안내에서 가장 일관된 값(3~60초)을 쓴다. 넘으면 컨테이너가 ERROR로 끝난다.
export const CAROUSEL_VIDEO_MIN_SEC = 3;
export const CAROUSEL_VIDEO_MAX_SEC = 60;

// 사진 게시물 metadata.item_thumbs — 영상 장의 경로 → 첫 프레임 이미지 경로.
// 목록 · 미리 보기는 영상 대신 이 이미지를 보여 준다.
export function itemThumbs(metadata: unknown): Record<string, string> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const raw = (metadata as { item_thumbs?: unknown }).item_thumbs;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && v) out[k] = v;
  }
  return out;
}

// 목록 썸네일로 쓸 경로. 영상(릴스)은 metadata.thumbnail_path, 사진 게시물은 첫 장 —
// 첫 장이 영상이면 그 영상의 첫 프레임(item_thumbs)을 쓴다.
export function contentThumbPath(content: {
  media_type: string;
  media_urls: string[] | null;
  metadata: unknown;
}): string | undefined {
  const meta = content.metadata as { thumbnail_path?: unknown } | null;
  if (content.media_type === "VIDEO") {
    return typeof meta?.thumbnail_path === "string" ? meta.thumbnail_path : undefined;
  }
  const first = content.media_urls?.[0];
  if (!first) return undefined;
  if (!isVideoPath(first)) return first;
  return itemThumbs(content.metadata)[first];
}

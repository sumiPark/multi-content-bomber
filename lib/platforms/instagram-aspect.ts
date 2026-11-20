// 인스타그램 피드 사진 비율 — API는 가로/세로 0.8(4:5) ~ 1.91(1.91:1) 밖의 사진을
// "The aspect ratio is not supported."(400)로 거부한다. 인스타 앱은 알아서 잘라 주지만 API는 자르지 않는다.
// 폰 기본 3:4(0.75) 세로 사진이 대표적으로 걸린다(2026-11-20 joongdi 사진 4장 중 3장).
//
// 화면(콘텐츠 생성 2단계 경고 · 미리 보기)과 워커(발행 때 자르기)가 같은 계산을 쓰도록 여기 한 곳에 둔다.
// 브라우저 · Node 모두에서 돌아야 하므로 이미지 라이브러리를 import하지 않는다.

export const IG_FEED_MIN_RATIO = 4 / 5;
export const IG_FEED_MAX_RATIO = 1.91;

/** 원본 안에서 남길 영역(픽셀). 가운데 기준으로 넘치는 쪽만 자른다. */
export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function isIgFeedRatioOk(width: number, height: number): boolean {
  if (!width || !height) return true; // 크기를 모르면 판단하지 않는다(워커가 다시 잰다)
  const r = width / height;
  return r >= IG_FEED_MIN_RATIO && r <= IG_FEED_MAX_RATIO;
}

/**
 * 범위 밖이면 범위 끝(세로는 4:5, 가로는 1.91:1)에 맞춘 가운데 영역, 범위 안이면 null.
 * 반올림으로 범위를 다시 벗어나지 않게 남기는 쪽 길이는 내림한다.
 */
export function igFeedCrop(width: number, height: number): CropRect | null {
  if (isIgFeedRatioOk(width, height)) return null;
  if (width / height < IG_FEED_MIN_RATIO) {
    // 세로가 너무 길다 → 위아래를 잘라 4:5로
    const h = Math.min(height, Math.floor(width / IG_FEED_MIN_RATIO));
    return { left: 0, top: Math.floor((height - h) / 2), width, height: h };
  }
  // 가로가 너무 길다 → 양옆을 잘라 1.91:1로
  const w = Math.min(width, Math.floor(height * IG_FEED_MAX_RATIO));
  return { left: Math.floor((width - w) / 2), top: 0, width: w, height };
}

/** "3:4" 같은 사람이 읽는 비율 — 흔한 비율이면 그 이름, 아니면 소수 두 자리. */
export function describeRatio(width: number, height: number): string {
  const r = width / height;
  const known: [number, string][] = [
    [3 / 4, "3:4"],
    [9 / 16, "9:16"],
    [2 / 3, "2:3"],
    [4 / 5, "4:5"],
    [1, "1:1"],
    [4 / 3, "4:3"],
    [3 / 2, "3:2"],
    [16 / 9, "16:9"],
    [2, "2:1"],
  ];
  const hit = known.find(([v]) => Math.abs(v - r) < 0.01);
  return hit ? hit[1] : `${r.toFixed(2)}:1`;
}

// contents.metadata.ig_auto_fit — 콘텐츠 생성에서 "인스타그램에는 잘라서 올려도 괜찮아요"에 동의했는지.
// 동의가 없으면 워커는 범위 밖 사진을 자르지 않고 발행을 멈춘다.
export function igAutoFitAllowed(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  return (metadata as { ig_auto_fit?: unknown }).ig_auto_fit === true;
}

// contents.metadata.ig_fit_paths — 원본 경로 → 워커가 잘라 올린 사본 경로. 콘텐츠를 지울 때 함께 지운다.
export function igFitPaths(metadata: unknown): Record<string, string> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const raw = (metadata as { ig_fit_paths?: unknown }).ig_fit_paths;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && v) out[k] = v;
  }
  return out;
}

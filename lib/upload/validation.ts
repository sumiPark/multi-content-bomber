import type { Platform } from "@/lib/platforms";

export type MediaType = "IMAGE" | "VIDEO";

export interface MediaItem {
  file: File;
  width?: number;
  height?: number;
  durationSeconds?: number;
}

export type IssueSeverity = "error" | "warning";

export interface ValidationIssue {
  severity: IssueSeverity;
  platform: Platform;
  code: string;
  message: string;
}

export interface PlatformVerdict {
  platform: Platform;
  status: "ok" | "warning" | "blocked";
  issues: ValidationIssue[];
}

export interface ValidationResult {
  ok: boolean;
  blockedPlatforms: Platform[];
  perPlatform: PlatformVerdict[];
  issues: ValidationIssue[];
}

interface PlatformConstraints {
  supportsImage: boolean;
  supportsVideo: boolean;
  maxImagesPerPost: number;
  maxFileSizeBytes: number;
  // 플랫폼 공식 한도(maxFileSizeBytes)보다 낮은 우리 구현상의 한도.
  // 초과해도 막지는 않고 경고만 — 다른 플랫폼 발행은 정상 진행된다.
  warnFileSizeBytes?: number;
  warnFileSizeNote?: string;
  maxVideoDurationSec: number;
  imageMimes: string[];
  videoMimes: string[];
  recommendedAspectRatio?: number;
  recommendedAspectName?: string;
  recommendedMinResolution?: { width: number; height: number };
}

const MB = 1024 * 1024;

const CONSTRAINTS: Record<Platform, PlatformConstraints> = {
  YOUTUBE: {
    supportsImage: true,
    supportsVideo: true,
    maxImagesPerPost: 1,
    maxFileSizeBytes: 256 * 1024 * MB,
    maxVideoDurationSec: 12 * 3600,
    imageMimes: ["image/jpeg", "image/png", "image/webp"],
    videoMimes: ["video/mp4", "video/quicktime", "video/x-msvideo", "video/webm"],
    recommendedAspectRatio: 9 / 16,
    recommendedAspectName: "9:16 (Shorts)",
    recommendedMinResolution: { width: 1080, height: 1920 },
  },
  INSTAGRAM: {
    supportsImage: true,
    supportsVideo: true,
    maxImagesPerPost: 10,
    maxFileSizeBytes: 4 * 1024 * MB,
    maxVideoDurationSec: 15 * 60,
    imageMimes: ["image/jpeg", "image/png"],
    videoMimes: ["video/mp4", "video/quicktime"],
    recommendedAspectRatio: 9 / 16,
    recommendedAspectName: "9:16 (Reels) 또는 4:5 (Feed)",
    recommendedMinResolution: { width: 1080, height: 1350 },
  },
  TIKTOK: {
    supportsImage: false,
    supportsVideo: true,
    maxImagesPerPost: 0,
    maxFileSizeBytes: 287 * MB,
    // 어댑터가 single chunk 업로드만 구현 — lib/platforms/tiktok.ts 참고.
    warnFileSizeBytes: 64 * MB,
    warnFileSizeNote: "발행 시 실패할 수 있어요 (분할 업로드 미지원).",
    maxVideoDurationSec: 60 * 60,
    imageMimes: [],
    videoMimes: ["video/mp4", "video/quicktime"],
    recommendedAspectRatio: 9 / 16,
    recommendedAspectName: "9:16 (세로 전체화면)",
    recommendedMinResolution: { width: 1080, height: 1920 },
  },
};

const ASPECT_TOLERANCE = 0.05;

function ratio(width?: number, height?: number): number | null {
  if (!width || !height) return null;
  return width / height;
}

function evaluatePlatform(
  platform: Platform,
  mediaType: MediaType,
  items: MediaItem[],
): PlatformVerdict {
  const c = CONSTRAINTS[platform];
  const issues: ValidationIssue[] = [];

  if (mediaType === "IMAGE" && !c.supportsImage) {
    issues.push({
      severity: "error",
      platform,
      code: "image_unsupported",
      message: `${platform}은 이미지 게시를 지원하지 않습니다 (영상만 가능).`,
    });
  }
  if (mediaType === "VIDEO" && !c.supportsVideo) {
    issues.push({
      severity: "error",
      platform,
      code: "video_unsupported",
      message: `${platform}은 영상 게시를 지원하지 않습니다.`,
    });
  }

  if (mediaType === "IMAGE" && items.length > c.maxImagesPerPost) {
    issues.push({
      severity: "error",
      platform,
      code: "too_many_images",
      message: `${platform} 1회 게시는 ${c.maxImagesPerPost}장까지 가능합니다 (현재 ${items.length}장).`,
    });
  }

  for (const item of items) {
    const allowedMimes =
      mediaType === "IMAGE" ? c.imageMimes : c.videoMimes;
    if (allowedMimes.length > 0 && !allowedMimes.includes(item.file.type)) {
      issues.push({
        severity: "error",
        platform,
        code: "mime_unsupported",
        message: `${platform}은 ${item.file.type || "알 수 없는 포맷"}을 지원하지 않습니다 (${item.file.name}).`,
      });
    }

    if (
      item.file.size <= c.maxFileSizeBytes &&
      c.warnFileSizeBytes !== undefined &&
      item.file.size > c.warnFileSizeBytes
    ) {
      const warnMB = Math.floor(c.warnFileSizeBytes / MB);
      const fileMB = (item.file.size / MB).toFixed(1);
      issues.push({
        severity: "warning",
        platform,
        code: "file_over_supported_size",
        message: `${platform}은 ${warnMB}MB 이하만 지원합니다 (${item.file.name}: ${fileMB}MB). ${c.warnFileSizeNote ?? ""}`.trim(),
      });
    }

    if (item.file.size > c.maxFileSizeBytes) {
      const maxMB = Math.floor(c.maxFileSizeBytes / MB);
      const fileMB = (item.file.size / MB).toFixed(1);
      issues.push({
        severity: "error",
        platform,
        code: "file_too_large",
        message: `${platform} 최대 파일 크기 ${maxMB}MB 초과 (${item.file.name}: ${fileMB}MB).`,
      });
    }

    if (
      mediaType === "VIDEO" &&
      item.durationSeconds !== undefined &&
      item.durationSeconds > c.maxVideoDurationSec
    ) {
      const maxMin = Math.floor(c.maxVideoDurationSec / 60);
      const dur = Math.round(item.durationSeconds);
      issues.push({
        severity: "error",
        platform,
        code: "video_too_long",
        message: `${platform} 영상 길이 한도 초과 (${dur}초 > ${maxMin}분).`,
      });
    }

    const r = ratio(item.width, item.height);
    if (r !== null && c.recommendedAspectRatio) {
      const diff = Math.abs(r - c.recommendedAspectRatio);
      if (diff > ASPECT_TOLERANCE) {
        issues.push({
          severity: "warning",
          platform,
          code: "aspect_off",
          message: `${platform} 권장 비율(${c.recommendedAspectName})과 다릅니다. 자동 크롭 또는 여백이 발생할 수 있어요.`,
        });
      }
    }

    if (
      item.width !== undefined &&
      item.height !== undefined &&
      c.recommendedMinResolution &&
      (item.width < c.recommendedMinResolution.width ||
        item.height < c.recommendedMinResolution.height)
    ) {
      issues.push({
        severity: "warning",
        platform,
        code: "resolution_low",
        message: `${platform} 권장 최소 해상도(${c.recommendedMinResolution.width}×${c.recommendedMinResolution.height}) 미만입니다.`,
      });
    }
  }

  const hasError = issues.some((i) => i.severity === "error");
  const hasWarning = issues.some((i) => i.severity === "warning");
  return {
    platform,
    status: hasError ? "blocked" : hasWarning ? "warning" : "ok",
    issues,
  };
}

export function validateMedia(
  mediaType: MediaType,
  items: MediaItem[],
  selectedPlatforms: Platform[],
): ValidationResult {
  if (items.length === 0) {
    return {
      ok: false,
      blockedPlatforms: [],
      perPlatform: [],
      issues: [],
    };
  }

  const perPlatform = selectedPlatforms.map((p) =>
    evaluatePlatform(p, mediaType, items),
  );
  const blocked = perPlatform
    .filter((v) => v.status === "blocked")
    .map((v) => v.platform);
  const allIssues = perPlatform.flatMap((v) => v.issues);
  return {
    ok: blocked.length === 0,
    blockedPlatforms: blocked,
    perPlatform,
    issues: allIssues,
  };
}

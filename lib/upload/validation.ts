import type { Platform } from "@/lib/platforms";
import {
  CAROUSEL_VIDEO_MAX_SEC,
  CAROUSEL_VIDEO_MIN_SEC,
  isVideoFile,
} from "@/lib/upload/media-kind";

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

// 인스타 릴스 영상 한도. 공식 문서는 300MB(video_url 방식)지만 실측으론 446MB까지
// 정상 발행됐다. 661MB·780MB는 컨테이너가 IN_PROGRESS에서 몇 시간째 끝나지 않은
// 적이 있어(ERROR도 안 주고 멈춤) 300MB를 넘으면 경고만 하고, 막는 건 1GB부터.
// 워커(lib/platforms/instagram.ts)도 같은 값으로 컨테이너를 만들기 전에 거른다.
export const INSTAGRAM_MAX_VIDEO_BYTES = 1024 * MB;

const CONSTRAINTS: Record<Platform, PlatformConstraints> = {
  YOUTUBE: {
    // 유튜브는 영상만 — 어댑터(lib/platforms/youtube.ts publish)가 사진을 거절해 발행이 늘 실패했다(2026-11-04).
    supportsImage: false,
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
    // INSTAGRAM_MAX_VIDEO_BYTES 참고.
    maxFileSizeBytes: INSTAGRAM_MAX_VIDEO_BYTES,
    warnFileSizeBytes: 300 * MB,
    warnFileSizeNote: "인스타 공식 한도를 넘어 처리가 오래 걸리거나 실패할 수 있어요.",
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
    // 공식 한도는 287MB지만 어댑터가 한 번에 올리기(single chunk)만 구현해 64MB를 넘으면 발행이 늘 실패한다
    // (lib/platforms/tiktok.ts). 경고만 하던 것을 막도록 바꿨다(2026-11-04).
    maxFileSizeBytes: 64 * MB,
    maxVideoDurationSec: 60 * 60,
    imageMimes: [],
    videoMimes: ["video/mp4", "video/quicktime"],
    recommendedAspectRatio: 9 / 16,
    recommendedAspectName: "9:16 (세로 전체화면)",
    recommendedMinResolution: { width: 1080, height: 1920 },
  },
};

const ASPECT_TOLERANCE = 0.05;

const PLATFORM_KO: Record<Platform, { name: string; topic: string }> = {
  YOUTUBE: { name: "유튜브", topic: "유튜브는" },
  INSTAGRAM: { name: "인스타그램", topic: "인스타그램은" },
  TIKTOK: { name: "틱톡", topic: "틱톡은" },
};

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
  const { name, topic } = PLATFORM_KO[platform];
  const issues: ValidationIssue[] = [];

  if (mediaType === "IMAGE" && !c.supportsImage) {
    issues.push({
      severity: "error",
      platform,
      code: "image_unsupported",
      message: `${topic} 사진을 올릴 수 없어요 (영상만 가능). 1단계에서 이 계정을 빼거나 영상으로 바꿔 주세요.`,
    });
  }
  if (mediaType === "VIDEO" && !c.supportsVideo) {
    issues.push({
      severity: "error",
      platform,
      code: "video_unsupported",
      message: `${topic} 영상을 올릴 수 없어요.`,
    });
  }

  if (mediaType === "IMAGE" && items.length > c.maxImagesPerPost) {
    issues.push({
      severity: "error",
      platform,
      code: "too_many_images",
      message: `${name} 게시물 하나에는 ${c.maxImagesPerPost}장까지 올릴 수 있어요 (지금 ${items.length}장).`,
    });
  }

  // 사진 게시물에 섞인 영상(인스타 캐러셀, 2026-11-10). 사진만 있는 게시물은 아래 검사가 전과 같다.
  const carouselVideos =
    mediaType === "IMAGE" ? items.filter((i) => isVideoFile(i.file)) : [];
  if (carouselVideos.length > 0 && items.length === 1) {
    issues.push({
      severity: "error",
      platform,
      code: "single_video_in_photo",
      message: "영상 1개만 올리려면 '영상 1개(릴스)'를 골라 주세요. 사진 칸의 영상은 사진 · 영상을 2개 이상 묶을 때만 쓸 수 있어요.",
    });
  }
  if (carouselVideos.length > 0 && platform === "INSTAGRAM") {
    const ratios = items.map((i) => ratio(i.width, i.height));
    const first = ratios[0];
    if (
      first != null &&
      ratios.some((r) => r != null && Math.abs(r - first) > ASPECT_TOLERANCE)
    ) {
      issues.push({
        severity: "warning",
        platform,
        code: "carousel_aspect_mixed",
        message: `${topic} 캐러셀의 나머지 장을 첫 장 비율에 맞춰 잘라요. 비율이 다른 사진 · 영상이 있어요.`,
      });
    }
    if (carouselVideos.some((v) => {
      const r = ratio(v.width, v.height);
      return r != null && r < 4 / 5 - ASPECT_TOLERANCE;
    })) {
      issues.push({
        severity: "warning",
        platform,
        code: "carousel_video_tall",
        message: `${topic} 캐러셀을 4:5보다 길게 보여 주지 않아요. 세로 영상(9:16)은 위아래가 잘릴 수 있어요.`,
      });
    }
  }

  for (const item of items) {
    const itemIsVideo = mediaType === "VIDEO" || isVideoFile(item.file);
    const allowedMimes = itemIsVideo ? c.videoMimes : c.imageMimes;
    if (allowedMimes.length > 0 && !allowedMimes.includes(item.file.type)) {
      issues.push({
        severity: "error",
        platform,
        code: "mime_unsupported",
        message: `${topic} 이 파일 형식(${item.file.type || "알 수 없음"})을 올릴 수 없어요 (${item.file.name}).`,
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
        message: `${topic} ${warnMB}MB 이하만 안정적으로 올라가요 (${item.file.name}: ${fileMB}MB). ${c.warnFileSizeNote ?? ""}`.trim(),
      });
    }

    if (item.file.size > c.maxFileSizeBytes) {
      const maxMB = Math.floor(c.maxFileSizeBytes / MB);
      const fileMB = (item.file.size / MB).toFixed(1);
      issues.push({
        severity: "error",
        platform,
        code: "file_too_large",
        message: `${name} 최대 파일 크기 ${maxMB}MB를 넘어요 (${item.file.name}: ${fileMB}MB).`,
      });
    }

    if (
      mediaType === "IMAGE" &&
      itemIsVideo &&
      c.supportsImage &&
      item.durationSeconds !== undefined &&
      (item.durationSeconds < CAROUSEL_VIDEO_MIN_SEC ||
        item.durationSeconds > CAROUSEL_VIDEO_MAX_SEC)
    ) {
      const dur = Math.round(item.durationSeconds);
      issues.push({
        severity: "error",
        platform,
        code: "carousel_video_length",
        message: `${name} 캐러셀 안 영상은 ${CAROUSEL_VIDEO_MIN_SEC}~${CAROUSEL_VIDEO_MAX_SEC}초만 올릴 수 있어요 (${item.file.name}: ${dur}초).`,
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
        message: `${name} 영상 길이 한도를 넘어요 (${dur}초 > ${maxMin}분).`,
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
          message: `${name} 권장 비율(${c.recommendedAspectName})과 달라요. 잘리거나 여백이 생길 수 있어요.`,
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
        message: `${name} 권장 최소 해상도(${c.recommendedMinResolution.width}×${c.recommendedMinResolution.height})보다 작아요.`,
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

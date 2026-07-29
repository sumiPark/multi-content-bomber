export interface ExtractedFrame {
  blob: Blob;
  durationSeconds: number;
  width: number;
  height: number;
}

/**
 * Browser-only. Decodes a single video frame onto a canvas and exports it as a
 * JPEG blob.
 *
 * `resolveTime(duration)`가 어느 시점(초)을 디코드할지 결정한다. 호출 측이
 * duration을 모를 수 있으므로(메타데이터 로드 전), 콜백으로 받아 onloadedmetadata
 * 시점에 계산한다. 반환 시점은 [0, duration) 범위로 클램프된다.
 */
function extractFrame(
  file: File,
  resolveTime: (duration: number) => number,
): Promise<ExtractedFrame> {
  return new Promise<ExtractedFrame>((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;

    const url = URL.createObjectURL(file);
    let settled = false;

    const cleanup = () => {
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      video.load();
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    video.onerror = () => fail(new Error("영상 메타데이터를 읽지 못했습니다."));

    video.onloadedmetadata = () => {
      const duration = video.duration;
      const want = resolveTime(duration);
      // 마지막 프레임 직전까지만 — duration 정확히는 seek가 안 끝날 수 있음.
      const safeMax = Number.isFinite(duration) ? Math.max(0, duration - 0.05) : 0;
      video.currentTime = Math.min(Math.max(0, want), safeMax);
    };

    video.onseeked = () => {
      if (settled) return;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas 2D context unavailable");
        ctx.drawImage(video, 0, 0);
        canvas.toBlob(
          (blob) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (!blob) return reject(new Error("썸네일 생성 실패"));
            resolve({
              blob,
              durationSeconds: video.duration,
              width: video.videoWidth,
              height: video.videoHeight,
            });
          },
          "image/jpeg",
          0.85,
        );
      } catch (err) {
        fail(err instanceof Error ? err : new Error("프레임 추출 실패"));
      }
    };

    video.src = url;
  });
}

/**
 * 영상의 대표 프레임(앞부분)을 JPEG로 추출. GPT-4o Vision(영상 미지원) 분석 입력용.
 * 검은 첫 프레임을 피하려고 0.1초 또는 절반 지점 중 작은 값을 쓴다.
 */
export function extractFirstFrame(file: File): Promise<ExtractedFrame> {
  return extractFrame(file, (duration) =>
    Math.min(0.1, Math.max(0, duration / 2)),
  );
}

/**
 * 사용자가 고른 시점(초)의 프레임을 JPEG로 추출. 게시 커버(YouTube 썸네일)용.
 */
export function extractFrameAt(
  file: File,
  atSeconds: number,
): Promise<ExtractedFrame> {
  return extractFrame(file, () => atSeconds);
}

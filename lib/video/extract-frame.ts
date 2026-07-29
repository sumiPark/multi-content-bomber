export interface ExtractedFrame {
  blob: Blob;
  durationSeconds: number;
  width: number;
  height: number;
}

/**
 * Browser-only. 영상의 대표 프레임(앞부분)을 캔버스로 디코드해 JPEG blob으로 뽑는다.
 * GPT-4o Vision(영상 미지원) 분석 입력용.
 *
 * 검은 첫 프레임을 피하려고 0.1초 또는 절반 지점 중 작은 값을 쓴다.
 */
export function extractFirstFrame(file: File): Promise<ExtractedFrame> {
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
      const want = Math.min(0.1, Math.max(0, duration / 2));
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

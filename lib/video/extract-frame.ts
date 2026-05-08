export interface ExtractedFrame {
  blob: Blob;
  durationSeconds: number;
  width: number;
  height: number;
}

/**
 * Browser-only. Decodes the video's first frame onto a canvas and exports it
 * as a JPEG blob. Used to feed GPT-4o Vision (which doesn't accept video).
 */
export async function extractFirstFrame(file: File): Promise<ExtractedFrame> {
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
      // Seek slightly past 0 so a real frame is decoded (not the black frame).
      video.currentTime = Math.min(0.1, Math.max(0, video.duration / 2));
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

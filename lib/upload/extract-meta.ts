// 클라이언트에서 미디어 파일의 메타데이터(가로/세로/길이)만 가볍게 추출.
// 영상 첫 프레임을 캡처하는 extractFirstFrame()과 달리 캔버스를 안 쓰므로 빠르고
// 메모리 부담이 적다. 검증 단계에서 정확한 해상도/길이를 알기 위해 사용한다.

export interface ImageMeta {
  width: number;
  height: number;
}

export interface VideoMeta {
  width: number;
  height: number;
  durationSeconds: number;
}

export async function extractImageMeta(file: File): Promise<ImageMeta> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    const meta = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    return meta;
  }
  // Fallback: createImageBitmap 미지원 환경
  return new Promise<ImageMeta>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const meta = { width: img.naturalWidth, height: img.naturalHeight };
      URL.revokeObjectURL(url);
      resolve(meta);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("이미지 메타데이터 추출 실패"));
    };
    img.src = url;
  });
}

export async function extractVideoMeta(file: File): Promise<VideoMeta> {
  return new Promise<VideoMeta>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => {
      const meta: VideoMeta = {
        width: video.videoWidth,
        height: video.videoHeight,
        durationSeconds: Number.isFinite(video.duration) ? video.duration : 0,
      };
      URL.revokeObjectURL(url);
      resolve(meta);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("영상 메타데이터 추출 실패"));
    };
    video.src = url;
  });
}

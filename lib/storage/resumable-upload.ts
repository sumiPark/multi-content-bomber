import { DetailedError, Upload as TusUpload } from "tus-js-client";
import { createClient } from "@/lib/supabase/client";

// 큰 영상 올리기(브라우저 전용) — Supabase Storage의 tus(이어 올리기) 엔드포인트로 media 버킷에 올린다.
// 직접 촬영 화면(components/shoot/shoot-request-card.tsx)과 같은 방식이다. tus가 실패하면 한 번에 올리기로 다시 올린다.
// 스타일 쇼츠(/style-shorts)가 쓴다.

// media 버킷이 받는 영상 형식(0005)
export const VIDEO_TYPES: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov" };
// Supabase tus는 조각 크기가 정확히 6MB여야 한다
const CHUNK = 6 * 1024 * 1024;

/** 파일 형식 — 휴대폰이 형식을 비워 보내면 확장자로 판단한다. */
export function videoType(file: File): string | null {
  if (VIDEO_TYPES[file.type]) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (ext === "mp4") return "video/mp4";
  if (ext === "mov") return "video/quicktime";
  return null;
}

export function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)}MB`;
}

function describeUploadError(err: unknown): string {
  if (err instanceof DetailedError) {
    const res = err.originalResponse;
    if (res) {
      const body = (res.getBody() ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      return `응답 ${res.getStatus()}${body ? ` · ${body}` : ""}`;
    }
    const cause = err.causingError?.message;
    return `서버 응답 없음(연결이 끊기거나 막힘)${cause ? ` · ${cause.slice(0, 160)}` : ""}`;
  }
  return err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
}

async function uploadTus(file: File, type: string, objectName: string, onProgress: (sent: number, total: number) => void): Promise<string> {
  const supabase = createClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("로그인이 풀렸어요. 새로고침해 주세요.");
  return new Promise((resolve, reject) => {
    const upload = new TusUpload(file, {
      endpoint: `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/upload/resumable`,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: { authorization: `Bearer ${token}`, apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, "x-upsert": "false" },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      chunkSize: CHUNK,
      // 큰 파일은 오래 걸려 로그인 토큰이 도중에 만료될 수 있다 — 요청마다 새 토큰으로
      onBeforeRequest: async (req) => {
        const { data: fresh } = await supabase.auth.getSession();
        if (fresh.session?.access_token) req.setHeader("authorization", `Bearer ${fresh.session.access_token}`);
      },
      metadata: { bucketName: "media", objectName, contentType: type, cacheControl: "3600" },
      onProgress,
      onError: (err) => reject(new Error(describeUploadError(err))),
      onSuccess: () => resolve(objectName),
    });
    upload.start();
  });
}

/**
 * 영상 하나를 media 버킷의 folder 아래에 올리고 저장 경로를 돌려준다.
 * folder는 `${orgId}/${userId}/…` 형식이어야 한다(media 버킷 정책).
 */
export async function uploadVideo(file: File, folder: string, onProgress: (sent: number, total: number) => void): Promise<string> {
  const type = videoType(file);
  if (!type) throw new Error("MP4 · MOV 영상만 올릴 수 있어요.");
  const objectName = `${folder}/${crypto.randomUUID()}.${VIDEO_TYPES[type]}`;
  try {
    return await uploadTus(file, type, objectName, onProgress);
  } catch (err) {
    console.warn("[upload] 이어 올리기 실패, 한 번에 올리기로 다시 시도:", err);
    const { error } = await createClient().storage.from("media").upload(objectName, file, { contentType: type, upsert: false, cacheControl: "3600" });
    if (error) throw new Error(`올리지 못했어요: ${error.message.slice(0, 200)} (이어 올리기: ${err instanceof Error ? err.message : err})`);
    onProgress(file.size, file.size);
    return objectName;
  }
}

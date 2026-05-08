import { createClient } from "@/lib/supabase/client";

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

export interface UploadedMedia {
  path: string;
  bucket: "media";
}

interface UploadOneInput {
  file: File | Blob;
  contentType: string;
  organizationId: string;
  userId: string;
}

export async function uploadOne({
  file,
  contentType,
  organizationId,
  userId,
}: UploadOneInput): Promise<UploadedMedia> {
  const ext = MIME_TO_EXT[contentType];
  if (!ext) throw new Error(`지원하지 않는 형식 (${contentType})`);

  const path = `${organizationId}/${userId}/${crypto.randomUUID()}.${ext}`;
  const supabase = createClient();
  const { error } = await supabase.storage
    .from("media")
    .upload(path, file, { contentType, upsert: false });

  if (error) throw new Error(error.message);
  return { path, bucket: "media" };
}

interface UploadMediaInput {
  files: File[];
  organizationId: string;
  userId: string;
  onProgress?: (done: number, total: number) => void;
}

export async function uploadMedia({
  files,
  organizationId,
  userId,
  onProgress,
}: UploadMediaInput): Promise<UploadedMedia[]> {
  let done = 0;
  return Promise.all(
    files.map(async (file) => {
      const result = await uploadOne({
        file,
        contentType: file.type,
        organizationId,
        userId,
      });
      done += 1;
      onProgress?.(done, files.length);
      return result;
    }),
  );
}

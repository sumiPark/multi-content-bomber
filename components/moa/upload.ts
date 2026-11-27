import { createClient } from "@/lib/supabase/client";

// 모아링크 이미지 올리기 — 공개 버킷 moa/{조직}/{난수}.{확장자} (0063). 방문자가 바로 보는 이미지라 공개 주소를 돌려준다.

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
const MAX_BYTES = 5 * 1024 * 1024;

export async function uploadMoaImage(file: File, organizationId: string): Promise<string> {
  const ext = EXT[file.type];
  if (!ext) throw new Error("JPG · PNG · WEBP · GIF 이미지만 올릴 수 있어요.");
  if (file.size > MAX_BYTES) throw new Error("이미지는 5MB까지 올릴 수 있어요.");
  const path = `${organizationId}/${crypto.randomUUID()}.${ext}`;
  const supabase = createClient();
  const { error } = await supabase.storage.from("moa").upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw new Error(`이미지를 올리지 못했어요: ${error.message}`);
  return supabase.storage.from("moa").getPublicUrl(path).data.publicUrl;
}

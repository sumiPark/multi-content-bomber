// 인스타그램 사진 비율 맞추기 — API는 4:5~1.91:1 밖의 사진을 자르지 않고 400("The aspect ratio is not
// supported.")으로 거부한다(2026-11-20 joongdi 사진 4장 중 3장). 콘텐츠 생성에서 잘릴 모양을 보고 동의한
// 콘텐츠(metadata.ig_auto_fit)만 가운데 기준으로 잘라 사본을 올리고, 그 사본의 서명 URL로 바꿔 넘긴다.
// 동의가 없으면 인스타에 보내기 전에 이유를 적고 멈춘다(재시도해도 같은 결과라 영구 실패).
// 원본은 그대로 두고 다른 플랫폼은 원본을 쓴다. 자르는 영역 계산은 화면과 같은 lib/platforms/instagram-aspect.ts.

import path from "node:path";
import sharp from "sharp";
import { PublishError } from "@/lib/platforms";
import {
  describeRatio,
  IG_FEED_MAX_RATIO,
  igAutoFitAllowed,
  igFeedCrop,
  igFitPaths,
} from "@/lib/platforms/instagram-aspect";
import type { createServiceClient } from "@/lib/supabase/service";
import { warnIfError } from "@/lib/supabase/result";
import { mediaItemKinds } from "@/lib/upload/media-kind";
import type { Json } from "@/types/database";

type Service = ReturnType<typeof createServiceClient>;

// 인스타 피드는 가로 1440px까지만 보여 준다 — 그보다 크게 올려도 인스타가 줄인다.
const MAX_WIDTH = 1440;

/** 잘라 올린 사본 경로 — 원본 폴더 안 ig-fit/. 같은 원본은 늘 같은 경로라 재시도 때 덮어쓴다. */
function fitPathOf(original: string): string {
  const dir = path.posix.dirname(original);
  const base = path.posix.basename(original).replace(/\.[^.]+$/, "");
  return `${dir}/ig-fit/${base}.jpg`;
}

export async function fitInstagramImages(
  supabase: Service,
  bucket: string,
  signTtlSec: number,
  content: { id: string; media_urls: string[]; metadata: Json | null },
  signedUrls: string[],
): Promise<string[]> {
  const kinds = mediaItemKinds(content.media_urls);
  const allowed = igAutoFitAllowed(content.metadata);
  const out = [...signedUrls];
  const fitPaths: Record<string, string> = {};
  const bad: string[] = [];

  for (const [i, original] of content.media_urls.entries()) {
    if (kinds[i] !== "IMAGE") continue;
    const { data: blob, error } = await supabase.storage.from(bucket).download(original);
    if (error || !blob) {
      // 크기를 못 재면 원본 그대로 보낸다 — 비율이 맞으면 발행되고, 아니면 인스타가 이유를 돌려준다.
      console.warn(`[ig-fit] 사진을 받지 못해 비율 확인을 건너뜀 (${original}): ${error?.message ?? "빈 응답"}`);
      continue;
    }
    const buf = Buffer.from(await blob.arrayBuffer());
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) continue;
    // 휴대폰 사진은 회전 정보(EXIF 5~8)로 세워 보여 준다 — 인스타도 세운 모양으로 비율을 본다.
    const turned = (meta.orientation ?? 1) >= 5;
    const width = turned ? meta.height : meta.width;
    const height = turned ? meta.width : meta.height;
    const crop = igFeedCrop(width, height);
    if (!crop) continue;

    if (!allowed) {
      bad.push(`${i + 1}번째(${describeRatio(width, height)})`);
      continue;
    }

    // 회전을 먼저 반영한 뒤 자른다(crop 좌표는 세운 모양 기준).
    const upright = await sharp(buf).rotate().toBuffer();
    const fitted = await sharp(upright)
      .extract(crop)
      .resize({ width: MAX_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
    const fitPath = fitPathOf(original);
    const { error: upErr } = await supabase.storage
      .from(bucket)
      .upload(fitPath, fitted, { contentType: "image/jpeg", upsert: true });
    if (upErr) {
      throw new PublishError(`인스타 비율에 맞춘 사진을 저장하지 못했어요 (${i + 1}번째): ${upErr.message}`);
    }
    const { data: signed, error: signErr } = await supabase.storage
      .from(bucket)
      .createSignedUrl(fitPath, signTtlSec);
    if (signErr || !signed?.signedUrl) {
      throw new PublishError(`인스타 비율에 맞춘 사진의 주소를 만들지 못했어요 (${i + 1}번째): ${signErr?.message ?? "no url"}`);
    }
    out[i] = signed.signedUrl;
    fitPaths[original] = fitPath;
    console.log(
      `[ig-fit] ${i + 1}번째 사진 ${describeRatio(width, height)} → ${describeRatio(crop.width, crop.height)} (${fitPath})`,
    );
  }

  if (bad.length > 0) {
    throw new PublishError(
      `인스타그램은 4:5~${IG_FEED_MAX_RATIO}:1 비율의 사진만 받아요. ${bad.join(", ")} 사진이 범위를 벗어났어요. ` +
        "콘텐츠 생성에서 '잘라서 올려도 괜찮아요'에 동의해 다시 등록하거나, 사진을 잘라 다시 올려 주세요.",
      { permanent: true },
    );
  }

  // 잘라 올린 사본 경로를 콘텐츠에 남긴다 — 콘텐츠를 지울 때 사본도 함께 지운다.
  const prev = igFitPaths(content.metadata);
  const changed = Object.entries(fitPaths).some(([k, v]) => prev[k] !== v);
  if (changed) {
    const base =
      content.metadata && typeof content.metadata === "object" && !Array.isArray(content.metadata)
        ? (content.metadata as Record<string, Json | undefined>)
        : {};
    warnIfError(
      await supabase
        .from("contents")
        .update({ metadata: { ...base, ig_fit_paths: { ...prev, ...fitPaths } } })
        .eq("id", content.id),
      "[ig-fit] 잘라 올린 사본 경로 저장",
    );
  }

  return out;
}

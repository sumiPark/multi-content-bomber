"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  captionsSchema,
  generateCaptions,
  type Captions,
} from "@/lib/ai/caption-generator";
import type { Json } from "@/types/database";

const SIGNED_URL_TTL_SECONDS = 600;

const generateInputSchema = z.object({
  mediaType: z.enum(["IMAGE", "VIDEO"]),
  mediaPaths: z
    .array(z.string().min(1))
    .min(1, "미디어를 1개 이상 추가해주세요.")
    .max(10, "최대 10개까지 처리할 수 있습니다."),
  analyzePaths: z
    .array(z.string().min(1))
    .min(1)
    .max(10),
  metadata: z.record(z.string(), z.unknown()).default({}),
  description: z.string().max(500).optional(),
  presetId: z.string().uuid().optional(),
  platforms: z
    .array(z.enum(["YOUTUBE", "INSTAGRAM", "TIKTOK"]))
    .min(1, "플랫폼을 1개 이상 선택해주세요.")
    .max(3),
  internalTitle: z.string().max(200).optional(),
});

const updateInputSchema = z.object({
  contentId: z.string().uuid(),
  captions: captionsSchema,
});

const regenerateInputSchema = z.object({
  contentId: z.string().uuid(),
  mediaType: z.enum(["IMAGE", "VIDEO"]),
  analyzePaths: z.array(z.string().min(1)).min(1).max(10),
  description: z.string().max(500).optional(),
  presetId: z.string().uuid().optional(),
  platforms: z
    .array(z.enum(["YOUTUBE", "INSTAGRAM", "TIKTOK"]))
    .min(1)
    .max(3),
  previousCaptions: captionsSchema,
});

const createJobsInputSchema = z.object({
  contentId: z.string().uuid(),
  accountIds: z.array(z.string().uuid()).min(1),
  scheduledFor: z.string().nullable(),
});

const createBlankInputSchema = z.object({
  mediaType: z.enum(["IMAGE", "VIDEO"]),
  mediaPaths: z.array(z.string().min(1)).min(1).max(10),
  analyzePaths: z.array(z.string().min(1)).min(1).max(10),
  metadata: z.record(z.string(), z.unknown()).default({}),
  platforms: z
    .array(z.enum(["YOUTUBE", "INSTAGRAM", "TIKTOK"]))
    .min(1)
    .max(3),
  internalTitle: z.string().max(200).optional(),
});

const updateInternalTitleSchema = z.object({
  contentId: z.string().uuid(),
  internalTitle: z.string().max(200),
});

const deleteContentsInputSchema = z.object({
  contentIds: z.array(z.string().uuid()).min(1).max(200),
});

export type DeleteContentsResult =
  | { ok: true; deleted: number }
  | { ok: false; error: string };

export type GenerateCaptionsResult =
  | {
      ok: true;
      contentId: string;
      captions: Captions;
      savedAt: string;
      thumbnailUrls: string[];
    }
  | { ok: false; error: string };

export type UpdateCaptionsResult =
  | { ok: true; savedAt: string }
  | { ok: false; error: string };

export type CreatePublishJobsResult =
  | { ok: true; count: number }
  | { ok: false; error: string };

export type CreateBlankContentResult =
  | {
      ok: true;
      contentId: string;
      captions: Captions;
      savedAt: string;
      thumbnailUrls: string[];
    }
  | { ok: false; error: string };

export type RegenerateCaptionsResult =
  | {
      ok: true;
      contentId: string;
      captions: Captions;
      savedAt: string;
      thumbnailUrls: string[];
    }
  | { ok: false; error: string };

type Platform = "YOUTUBE" | "INSTAGRAM" | "TIKTOK";
type MediaType = "VIDEO" | "IMAGE";

function buildBlankCaptions(platforms: Platform[]): Captions {
  return {
    youtube: platforms.includes("YOUTUBE")
      ? { title: "", description: "", hashtags: [], category: "" }
      : undefined,
    instagram: platforms.includes("INSTAGRAM")
      ? { caption: "", hashtags: [], cover_text: "" }
      : undefined,
    tiktok: platforms.includes("TIKTOK")
      ? { caption: "", hashtags: [] }
      : undefined,
  };
}

function pickPostType(
  platform: Platform,
  mediaType: MediaType,
  count: number,
):
  | "SHORTS"
  | "REELS"
  | "FEED"
  | "CAROUSEL"
  | "PHOTO_MODE"
  | "VIDEO"
  | "PHOTO" {
  if (mediaType === "VIDEO") {
    if (platform === "YOUTUBE") return "SHORTS";
    if (platform === "INSTAGRAM") return "REELS";
    return "VIDEO";
  }
  if (platform === "YOUTUBE") return "PHOTO";
  if (platform === "INSTAGRAM") return count > 1 ? "CAROUSEL" : "FEED";
  return "PHOTO_MODE";
}

export async function generateCaptionsAction(
  input: z.infer<typeof generateInputSchema>,
): Promise<GenerateCaptionsResult> {
  const parsed = generateInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "잘못된 입력" };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "로그인이 필요합니다." };

  const { data: profile } = await supabase
    .from("profiles")
    .select("organization_id")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile?.organization_id) {
    return { ok: false, error: "소속된 조직이 없습니다." };
  }

  let presetInstructions: string | undefined;
  if (parsed.data.presetId) {
    const { data: preset } = await supabase
      .from("caption_presets")
      .select("instructions")
      .eq("id", parsed.data.presetId)
      .maybeSingle();
    presetInstructions = preset?.instructions ?? undefined;
  }

  const { data: signed, error: signedError } = await supabase.storage
    .from("media")
    .createSignedUrls(parsed.data.analyzePaths, SIGNED_URL_TTL_SECONDS);

  if (signedError || !signed) {
    return {
      ok: false,
      error: `서명 URL 생성 실패: ${signedError?.message ?? "unknown"}`,
    };
  }

  const failed = signed.find((s) => s.error || !s.signedUrl);
  if (failed) {
    return { ok: false, error: `서명 URL 생성 실패: ${failed.error}` };
  }

  let captions: Captions;
  try {
    // `failed` check above guarantees every entry has a non-null signedUrl.
    captions = await generateCaptions(
      signed.map((s) => s.signedUrl as string),
      {
        description: parsed.data.description,
        presetInstructions,
        platforms: parsed.data.platforms,
      },
    );
  } catch (err) {
    console.error("[generateCaptionsAction] OpenAI failed:", err);
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "AI 캡션 생성에 실패했습니다.",
    };
  }

  const internalTitle = parsed.data.internalTitle?.trim() || null;

  const { data: content, error: insertError } = await supabase
    .from("contents")
    .insert({
      organization_id: profile.organization_id,
      created_by: user.id,
      media_type: parsed.data.mediaType,
      media_urls: parsed.data.mediaPaths,
      metadata: parsed.data.metadata as Json,
      ai_captions: captions as unknown as Json,
      ai_analyzed_at: new Date().toISOString(),
      // @ts-expect-error internal_title은 0008 마이그레이션 이후 추가
      internal_title: internalTitle,
    })
    .select("id, updated_at")
    .single();

  if (insertError || !content) {
    return {
      ok: false,
      error: `저장 실패: ${insertError?.message ?? "unknown"}`,
    };
  }

  revalidatePath("/");
  revalidatePath("/contents");

  return {
    ok: true,
    contentId: content.id,
    captions,
    savedAt: content.updated_at,
    thumbnailUrls: signed.map((s) => s.signedUrl as string),
  };
}

export async function updateInternalTitleAction(
  input: z.infer<typeof updateInternalTitleSchema>,
): Promise<{ ok: true; savedAt: string } | { ok: false; error: string }> {
  const parsed = updateInternalTitleSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "잘못된 입력" };
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "로그인이 필요합니다." };

  const { data: updated, error } = await supabase
    .from("contents")
    .update({
      // @ts-expect-error internal_title은 0008 마이그레이션 이후 추가
      internal_title: parsed.data.internalTitle.trim() || null,
    })
    .eq("id", parsed.data.contentId)
    .select("updated_at")
    .single();

  if (error || !updated) {
    return { ok: false, error: `수정 실패: ${error?.message ?? "unknown"}` };
  }
  revalidatePath("/");
  revalidatePath("/contents");
  revalidatePath("/postings");
  return { ok: true, savedAt: updated.updated_at };
}

export async function updateCaptionsAction(
  input: z.infer<typeof updateInputSchema>,
): Promise<UpdateCaptionsResult> {
  const parsed = updateInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "잘못된 입력" };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "로그인이 필요합니다." };

  const { data: updated, error } = await supabase
    .from("contents")
    .update({ ai_captions: parsed.data.captions })
    .eq("id", parsed.data.contentId)
    .select("updated_at")
    .single();

  if (error || !updated) {
    return { ok: false, error: `수정 실패: ${error?.message ?? "unknown"}` };
  }

  revalidatePath("/");
  revalidatePath("/contents");
  revalidatePath("/postings");

  return { ok: true, savedAt: updated.updated_at };
}

export async function regenerateCaptionsAction(
  input: z.infer<typeof regenerateInputSchema>,
): Promise<RegenerateCaptionsResult> {
  const parsed = regenerateInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "잘못된 입력" };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "로그인이 필요합니다." };

  let presetInstructions: string | undefined;
  if (parsed.data.presetId) {
    const { data: preset } = await supabase
      .from("caption_presets")
      .select("instructions")
      .eq("id", parsed.data.presetId)
      .maybeSingle();
    presetInstructions = preset?.instructions ?? undefined;
  }

  const { data: signed, error: signedError } = await supabase.storage
    .from("media")
    .createSignedUrls(parsed.data.analyzePaths, SIGNED_URL_TTL_SECONDS);
  if (signedError || !signed) {
    return {
      ok: false,
      error: `서명 URL 생성 실패: ${signedError?.message ?? "unknown"}`,
    };
  }
  const failed = signed.find((s) => s.error || !s.signedUrl);
  if (failed) {
    return { ok: false, error: `서명 URL 생성 실패: ${failed.error}` };
  }

  let captions: Captions;
  try {
    captions = await generateCaptions(
      signed.map((s) => s.signedUrl as string),
      {
        description: parsed.data.description,
        presetInstructions,
        platforms: parsed.data.platforms,
        previousCaptions: parsed.data.previousCaptions,
      },
    );
  } catch (err) {
    console.error("[regenerateCaptionsAction] OpenAI failed:", err);
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "AI 캡션 재생성에 실패했습니다.",
    };
  }

  const { data: updated, error: updateError } = await supabase
    .from("contents")
    .update({
      ai_captions: captions as unknown as Json,
      ai_analyzed_at: new Date().toISOString(),
    })
    .eq("id", parsed.data.contentId)
    .select("id, updated_at")
    .single();

  if (updateError || !updated) {
    return {
      ok: false,
      error: `저장 실패: ${updateError?.message ?? "unknown"}`,
    };
  }

  revalidatePath("/");
  revalidatePath("/contents");
  revalidatePath("/postings");

  return {
    ok: true,
    contentId: updated.id,
    captions,
    savedAt: updated.updated_at,
    thumbnailUrls: signed.map((s) => s.signedUrl as string),
  };
}

export async function createBlankContentAction(
  input: z.infer<typeof createBlankInputSchema>,
): Promise<CreateBlankContentResult> {
  const parsed = createBlankInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "잘못된 입력" };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "로그인이 필요합니다." };

  const { data: profile } = await supabase
    .from("profiles")
    .select("organization_id")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile?.organization_id) {
    return { ok: false, error: "소속된 조직이 없습니다." };
  }

  const blank = buildBlankCaptions(parsed.data.platforms);
  const internalTitle = parsed.data.internalTitle?.trim() || null;

  const { data: content, error: insertError } = await supabase
    .from("contents")
    .insert({
      organization_id: profile.organization_id,
      created_by: user.id,
      media_type: parsed.data.mediaType,
      media_urls: parsed.data.mediaPaths,
      metadata: parsed.data.metadata as Json,
      ai_captions: blank as unknown as Json,
      ai_analyzed_at: null,
      // @ts-expect-error internal_title은 0008 마이그레이션 이후 추가
      internal_title: internalTitle,
    })
    .select("id, updated_at")
    .single();

  if (insertError || !content) {
    return {
      ok: false,
      error: `저장 실패: ${insertError?.message ?? "unknown"}`,
    };
  }

  const { data: thumbSigned } = await supabase.storage
    .from("media")
    .createSignedUrls(parsed.data.analyzePaths, SIGNED_URL_TTL_SECONDS);
  const thumbnailUrls =
    thumbSigned
      ?.map((s) => s.signedUrl)
      .filter((u): u is string => typeof u === "string" && u.length > 0) ?? [];

  revalidatePath("/");
  revalidatePath("/contents");

  return {
    ok: true,
    contentId: content.id,
    captions: blank,
    savedAt: content.updated_at,
    thumbnailUrls,
  };
}

export async function deleteContentsAction(
  input: z.infer<typeof deleteContentsInputSchema>,
): Promise<DeleteContentsResult> {
  const parsed = deleteContentsInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "잘못된 입력" };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "로그인이 필요합니다." };

  // RLS가 권한 없는 행을 자동 차단 — 우선 삭제 대상의 미디어 경로를 수집한다.
  const { data: targets, error: selectError } = await supabase
    .from("contents")
    .select("id, media_urls")
    .in("id", parsed.data.contentIds);

  if (selectError) {
    return { ok: false, error: `조회 실패: ${selectError.message}` };
  }
  if (!targets || targets.length === 0) {
    return { ok: false, error: "삭제할 콘텐츠를 찾을 수 없거나 권한이 없습니다." };
  }

  const deletableIds = targets.map((t) => t.id);
  const storagePaths = Array.from(
    new Set(
      targets.flatMap((t) => t.media_urls).filter((p): p is string => Boolean(p)),
    ),
  );

  // DB 먼저 삭제 (publish_jobs는 cascade). RLS가 권한 없는 id는 통과시키지 않으므로
  // 위에서 select된 deletableIds만 대상으로 한다.
  const { error: deleteError, count } = await supabase
    .from("contents")
    .delete({ count: "exact" })
    .in("id", deletableIds);

  if (deleteError) {
    return { ok: false, error: `삭제 실패: ${deleteError.message}` };
  }

  // Storage 파일 제거 — DB 삭제 후 best-effort. 실패해도 본 응답은 ok 처리하되 로그.
  if (storagePaths.length > 0) {
    const { error: storageError } = await supabase.storage
      .from("media")
      .remove(storagePaths);
    if (storageError) {
      console.warn(
        "[deleteContentsAction] storage cleanup failed:",
        storageError.message,
      );
    }
  }

  revalidatePath("/");
  revalidatePath("/contents");
  revalidatePath("/postings");
  revalidatePath("/uploads");

  return { ok: true, deleted: count ?? deletableIds.length };
}

export async function createPublishJobsAction(
  input: z.infer<typeof createJobsInputSchema>,
): Promise<CreatePublishJobsResult> {
  const parsed = createJobsInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "잘못된 입력" };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "로그인이 필요합니다." };

  const { data: content } = await supabase
    .from("contents")
    .select("media_type, media_urls")
    .eq("id", parsed.data.contentId)
    .maybeSingle();
  if (!content) return { ok: false, error: "콘텐츠를 찾을 수 없습니다." };

  const { data: accounts } = await supabase
    .from("social_accounts")
    .select("id, platform")
    .in("id", parsed.data.accountIds);
  if (!accounts || accounts.length === 0) {
    return { ok: false, error: "계정 조회 실패" };
  }

  const mediaCount = content.media_urls.length;
  const jobs = accounts.map((a) => ({
    content_id: parsed.data.contentId,
    social_account_id: a.id,
    post_type: pickPostType(
      a.platform as Platform,
      content.media_type as MediaType,
      mediaCount,
    ),
    scheduled_for: parsed.data.scheduledFor,
    is_ai_generated: true,
  }));

  const { error } = await supabase.from("publish_jobs").insert(jobs);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/");
  revalidatePath("/postings");
  revalidatePath("/uploads");
  return { ok: true, count: jobs.length };
}

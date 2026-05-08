"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  captionsSchema,
  generateCaptions,
  type Captions,
} from "@/lib/ai/caption-generator";

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
  metadata: z.record(z.unknown()).default({}),
  description: z.string().max(500).optional(),
  presetId: z.string().uuid().optional(),
});

const updateInputSchema = z.object({
  contentId: z.string().uuid(),
  captions: captionsSchema,
});

const createJobsInputSchema = z.object({
  contentId: z.string().uuid(),
  accountIds: z.array(z.string().uuid()).min(1),
  scheduledFor: z.string().nullable(),
});

export type GenerateCaptionsResult =
  | { ok: true; contentId: string; captions: Captions; savedAt: string }
  | { ok: false; error: string };

export type UpdateCaptionsResult =
  | { ok: true; savedAt: string }
  | { ok: false; error: string };

export type CreatePublishJobsResult =
  | { ok: true; count: number }
  | { ok: false; error: string };

type Platform = "YOUTUBE" | "INSTAGRAM" | "TIKTOK";
type MediaType = "VIDEO" | "IMAGE";

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
    captions = await generateCaptions(signed.map((s) => s.signedUrl), {
      description: parsed.data.description,
      presetInstructions,
    });
  } catch (err) {
    console.error("[generateCaptionsAction] OpenAI failed:", err);
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "AI 캡션 생성에 실패했습니다.",
    };
  }

  const { data: content, error: insertError } = await supabase
    .from("contents")
    .insert({
      organization_id: profile.organization_id,
      created_by: user.id,
      media_type: parsed.data.mediaType,
      media_urls: parsed.data.mediaPaths,
      metadata: parsed.data.metadata,
      ai_captions: captions,
      ai_analyzed_at: new Date().toISOString(),
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

  return {
    ok: true,
    contentId: content.id,
    captions,
    savedAt: content.updated_at,
  };
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

  return { ok: true, savedAt: updated.updated_at };
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

  revalidatePath("/uploads");
  return { ok: true, count: jobs.length };
}

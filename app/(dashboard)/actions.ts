"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  captionsSchema,
  generateCaptions,
  type Captions,
} from "@/lib/ai/caption-generator";
import type { CaptionAccount } from "@/lib/ai/prompts";
import { triggerPublishRun } from "@/lib/github-dispatch";
import type { ContentRule } from "@/lib/rules/check";
import { createServiceClient } from "@/lib/supabase/service";
import { itemThumbs, mediaItemKinds } from "@/lib/upload/media-kind";
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
  accountIds: z.array(z.string().uuid()).max(50).optional(),
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
  accountIds: z.array(z.string().uuid()).max(50).optional(),
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
  // 시리즈 댓글 자동화(0017/0019) — 계정 id → 이 발행을 다음 화로 올릴 시리즈와, 올라가면
  // 바로 이전 화 댓글에 답글을 달지(reply, 기본 꺼짐). 인스타 계정만.
  seriesByAccount: z
    .record(z.string().uuid(), z.object({ seriesId: z.string().uuid(), reply: z.boolean() }))
    .optional(),
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
  | { ok: true; deleted: number; notice?: string }
  | { ok: false; error: string };

export type GenerateCaptionsResult =
  | {
      ok: true;
      contentId: string;
      captions: Captions;
      reviewNotes: string[];
      savedAt: string;
      thumbnailUrls: string[];
    }
  | { ok: false; error: string };

export type UpdateCaptionsResult =
  | { ok: true; savedAt: string }
  | { ok: false; error: string };

export type CreatePublishJobsResult =
  | { ok: true; count: number; note?: string }
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
      reviewNotes: string[];
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
      ? { caption: "", hashtags: [] }
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

// 캡션에 계정 말투를 맞추고 광고 문구 규칙을 검사하려고 읽는다. 못 읽어도 캡션 생성은 멈추지 않는다.
async function loadCaptionContext(
  supabase: Awaited<ReturnType<typeof createClient>>,
  accountIds: string[] | undefined,
  platforms: Platform[],
): Promise<{ instagramAccounts: CaptionAccount[]; contentRules: ContentRule[] }> {
  if (!platforms.includes("INSTAGRAM")) {
    return { instagramAccounts: [], contentRules: [] };
  }

  const [accounts, rules] = await Promise.all([
    accountIds?.length
      ? supabase
          .from("social_accounts")
          .select("id, display_name")
          .eq("platform", "INSTAGRAM")
          .is("disconnected_at", null)
          .in("id", accountIds)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from("content_rules")
      .select("id, scope, rule_type, phrase, match_type, reason, suggestion")
      .eq("active", true)
      .eq("scope", "ALL")
      .eq("rule_type", "BANNED"),
  ]);
  if (accounts.error) console.warn("[captions] 계정 읽기 실패:", accounts.error.message);
  if (rules.error) console.warn("[captions] 광고 문구 규칙 읽기 실패:", rules.error.message);

  const accountRows = accounts.data ?? [];
  const concepts = accountRows.length
    ? await supabase
        .from("account_concepts")
        .select("social_account_id, shoot_role_focus, shoot_concept, shoot_tone")
        .in("social_account_id", accountRows.map((a) => a.id))
    : { data: [], error: null };
  if (concepts.error) console.warn("[captions] 계정 컨셉 읽기 실패:", concepts.error.message);

  return {
    instagramAccounts: accountRows.map((account) => {
      const concept = concepts.data?.find((c) => c.social_account_id === account.id);
      return {
        name: (account.display_name ?? "account").replace(/^@/, ""),
        roleFocus: concept?.shoot_role_focus ?? null,
        concept: concept?.shoot_concept ?? "",
        tone: concept?.shoot_tone ?? "",
      };
    }),
    contentRules: (rules.data ?? []).map((r) => ({
      id: r.id,
      scope: r.scope as ContentRule["scope"],
      ruleType: r.rule_type as ContentRule["ruleType"],
      phrase: r.phrase,
      matchType: r.match_type as ContentRule["matchType"],
      reason: r.reason,
      suggestion: r.suggestion,
    })),
  };
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
  let reviewNotes: string[];
  try {
    const context = await loadCaptionContext(
      supabase,
      parsed.data.accountIds,
      parsed.data.platforms,
    );
    // `failed` check above guarantees every entry has a non-null signedUrl.
    ({ captions, reviewNotes } = await generateCaptions(
      signed.map((s) => s.signedUrl as string),
      {
        mediaType: parsed.data.mediaType,
        description: parsed.data.description,
        presetInstructions,
        platforms: parsed.data.platforms,
        // analyzePaths는 mediaPaths와 같은 순서(영상 장만 첫 프레임으로 바꿈)라 원본 경로로 종류를 가른다
        itemKinds: mediaItemKinds(parsed.data.mediaPaths),
        ...context,
      },
    ));
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
    reviewNotes,
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

// ─────────────────────────────────────────────────────────────────────────────
// 임시 저장 (0033) — 보관함은 사람이 '임시 저장'을 누른 콘텐츠만 보여준다.
// ─────────────────────────────────────────────────────────────────────────────

const saveDraftSchema = z.object({
  contentId: z.string().uuid(),
  internalTitle: z.string().max(200),
  // 이어서 하기용 마법사 상태(lib/upload/draft.ts). 화면 전용이라 모양은 읽을 때 확인한다.
  state: z.record(z.string(), z.unknown()),
  // 이어서 하다가 계정 · 미디어를 바꿔 콘텐츠가 새로 만들어졌으면, 예전 임시 저장은 보관함에서 뺀다.
  replacesContentId: z.string().uuid().optional(),
});

export type SaveDraftResult =
  | { ok: true; draftSavedAt: string }
  | { ok: false; error: string };

export async function saveDraftAction(
  input: z.infer<typeof saveDraftSchema>,
): Promise<SaveDraftResult> {
  const parsed = saveDraftSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "잘못된 입력" };
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "로그인이 필요합니다." };

  // 이미 발행을 등록한 콘텐츠는 배포 관리 관할이라 임시 저장하지 않는다.
  const { count: jobCount, error: jobError } = await supabase
    .from("publish_jobs")
    .select("id", { count: "exact", head: true })
    .eq("content_id", parsed.data.contentId);
  if (jobError) {
    return { ok: false, error: `임시 저장하지 못했어요: ${jobError.message}` };
  }
  if ((jobCount ?? 0) > 0) {
    return { ok: false, error: "이미 발행을 등록한 콘텐츠예요. 배포 관리에서 확인하세요." };
  }

  const draftSavedAt = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from("contents")
    .update({
      draft_saved_at: draftSavedAt,
      draft_state: parsed.data.state as Json,
      internal_title: parsed.data.internalTitle.trim() || null,
    })
    .eq("id", parsed.data.contentId)
    .select("id")
    .single();
  if (error || !updated) {
    return {
      ok: false,
      error: `임시 저장하지 못했어요: ${error?.message ?? "콘텐츠를 찾을 수 없거나 권한이 없어요"}`,
    };
  }

  if (
    parsed.data.replacesContentId &&
    parsed.data.replacesContentId !== parsed.data.contentId
  ) {
    await clearDraftFlag(supabase, parsed.data.replacesContentId);
  }

  revalidatePath("/contents");
  return { ok: true, draftSavedAt };
}

// 보관함에서만 뺀다(지우지 않는다). 실패해도 발행 흐름은 막지 않는다 — 로그만.
async function clearDraftFlag(
  supabase: Awaited<ReturnType<typeof createClient>>,
  contentId: string,
) {
  const { error } = await supabase
    .from("contents")
    .update({ draft_saved_at: null })
    .eq("id", contentId);
  if (error) console.warn("[clearDraftFlag] failed:", error.message);
}

const clearDraftSchema = z.object({ contentId: z.string().uuid() });

/** 이어서 하던 임시 저장을 다른 콘텐츠로 발행했을 때, 예전 임시 저장을 보관함에서 뺀다. */
export async function clearDraftAction(
  input: z.infer<typeof clearDraftSchema>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = clearDraftSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "로그인이 필요합니다." };
  await clearDraftFlag(supabase, parsed.data.contentId);
  revalidatePath("/contents");
  return { ok: true };
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
  let reviewNotes: string[];
  try {
    const [context, { data: mediaRow }] = await Promise.all([
      loadCaptionContext(supabase, parsed.data.accountIds, parsed.data.platforms),
      // 다시 쓰기 입력엔 원본 경로가 없어 콘텐츠에서 읽는다 — 섞인 영상 장을 알려 주려고
      supabase.from("contents").select("media_urls").eq("id", parsed.data.contentId).maybeSingle(),
    ]);
    ({ captions, reviewNotes } = await generateCaptions(
      signed.map((s) => s.signedUrl as string),
      {
        mediaType: parsed.data.mediaType,
        description: parsed.data.description,
        presetInstructions,
        platforms: parsed.data.platforms,
        previousCaptions: parsed.data.previousCaptions,
        itemKinds: mediaRow ? mediaItemKinds(mediaRow.media_urls) : undefined,
        ...context,
      },
    ));
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
    reviewNotes,
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
    .select("id, media_urls, metadata")
    .in("id", parsed.data.contentIds);

  if (selectError) {
    return { ok: false, error: `조회 실패: ${selectError.message}` };
  }
  if (!targets || targets.length === 0) {
    return { ok: false, error: "삭제할 콘텐츠를 찾을 수 없거나 권한이 없습니다." };
  }

  // 이미 올라간 콘텐츠는 행을 지우면 발행 기록까지 cascade로 사라진다(publish_jobs). 그래서 파일과 캡션만 지우고
  // 기록(언제 · 어느 계정 · 게시물 링크)은 남긴다 — "이력 보존"과 개인정보 안내의 "언제든 삭제"를 같이 지킨다(2026-11-04).
  const { data: postedJobs, error: postedError } = await supabase
    .from("publish_jobs")
    .select("content_id")
    .in(
      "content_id",
      targets.map((t) => t.id),
    )
    .eq("status", "SUCCESS");
  if (postedError) {
    return { ok: false, error: `조회 실패: ${postedError.message}` };
  }
  const postedIds = new Set((postedJobs ?? []).map((j) => j.content_id));

  const erasedIds = new Set<string>();
  for (const t of targets.filter((x) => postedIds.has(x.id))) {
    const meta = (t.metadata && typeof t.metadata === "object" ? t.metadata : {}) as Record<string, unknown>;
    const rest = { ...meta };
    delete rest.thumbnail_path;
    delete rest.cover_path;
    delete rest.item_thumbs;
    const { data: erased, error: eraseError } = await supabase
      .from("contents")
      .update({ ai_captions: null, draft_saved_at: null, metadata: { ...rest, erased_at: new Date().toISOString() } as Json })
      .eq("id", t.id)
      .select("id");
    if (eraseError) {
      return { ok: false, error: `삭제 실패: ${eraseError.message}` };
    }
    if (erased?.length) erasedIds.add(t.id);
  }
  // 같은 콘텐츠의 남은 예약은 올릴 파일이 없어졌으니 취소한다
  if (erasedIds.size > 0) {
    await createServiceClient()
      .from("publish_jobs")
      .update({ status: "CANCELLED", cancelled_at: new Date().toISOString() })
      .in("content_id", Array.from(erasedIds))
      .in("status", ["PENDING", "RETRYING"]);
  }

  // DB 먼저 삭제 (publish_jobs는 cascade). 콘텐츠 삭제는 만든 사람이나 관리자만 된다(RLS, 0001) —
  // 실제로 지워진 행을 받아 그 행의 파일만 정리한다. 0건이면 "삭제됨"이라고 하지 않는다(2026-11-04).
  const removable = targets.filter((t) => !postedIds.has(t.id)).map((t) => t.id);
  const { data: deletedRows, error: deleteError } = removable.length
    ? await supabase.from("contents").delete().in("id", removable).select("id")
    : { data: [] as { id: string }[], error: null };

  if (deleteError) {
    return { ok: false, error: `삭제 실패: ${deleteError.message}` };
  }
  const deletedIds = new Set([...(deletedRows ?? []).map((r) => r.id), ...erasedIds]);
  if (deletedIds.size === 0) {
    return { ok: false, error: "지울 권한이 없어요. 콘텐츠는 만든 사람이나 관리자만 지울 수 있어요." };
  }

  const pathsOf = (t: { media_urls: string[]; metadata: unknown }) => {
    const meta = (t.metadata && typeof t.metadata === "object" ? t.metadata : {}) as Record<string, unknown>;
    // item_thumbs = 사진 게시물에 섞인 영상 장의 첫 프레임(lib/upload/media-kind.ts)
    return [...(t.media_urls ?? []), meta.thumbnail_path, meta.cover_path, meta.ig_cover_path, ...Object.values(itemThumbs(meta))].filter((x): x is string => typeof x === "string" && !!x);
  };
  const candidatePaths = Array.from(new Set(targets.filter((t) => deletedIds.has(t.id)).flatMap(pathsOf)));

  // 같은 파일을 쓰는 다른 콘텐츠가 남아 있으면 그 파일은 지우지 않는다 — 1단계에서 계정을 바꿔 다시 만든 콘텐츠 ·
  // 예약된 발행이 같은 파일을 쓸 수 있다(예전엔 지워져 예약 발행이 실패했다). 조직 전체를 보려고 service로 조회.
  let storagePaths = candidatePaths;
  if (candidatePaths.length > 0) {
    const service = createServiceClient();
    const { data: still } = await service.from("contents").select("media_urls, metadata").overlaps("media_urls", candidatePaths);
    const { data: stillMeta, error: metaErr } = await service
      .from("contents")
      .select("media_urls, metadata")
      .or(candidatePaths.map((x) => `metadata->>thumbnail_path.eq.${x},metadata->>cover_path.eq.${x}`).join(","));
    // 파일을 이미 지운 콘텐츠(erased_at)는 경로만 남아 있을 뿐 쓰지 않는다
    const inUse = (c: { metadata: unknown }) => !(c.metadata as { erased_at?: string } | null)?.erased_at;
    const keep = new Set([...(still ?? []), ...(stillMeta ?? [])].filter(inUse).flatMap(pathsOf));
    // 남은 콘텐츠를 확인하지 못했으면 지우지 않는 쪽으로 — 파일이 남는 건 정리 워커가 나중에 처리한다
    const unsure = !still || !!metaErr;
    storagePaths = unsure ? [] : candidatePaths.filter((x) => !keep.has(x));
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

  const skipped = targets.length - deletedIds.size;
  const notices = [
    ...(erasedIds.size > 0 ? [`이미 올라간 ${erasedIds.size}건은 파일과 캡션만 지우고 발행 기록은 남겼어요.`] : []),
    ...(skipped > 0 ? [`${skipped}건은 지울 권한이 없어 남겼어요 (만든 사람이나 관리자만 지울 수 있어요).`] : []),
  ];
  return {
    ok: true,
    deleted: deletedIds.size,
    ...(notices.length ? { notice: notices.join(" ") } : {}),
  };
}

export async function createPublishJobsAction(
  input: z.infer<typeof createJobsInputSchema>,
): Promise<CreatePublishJobsResult> {
  const parsed = createJobsInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "잘못된 입력" };
  }
  // 지난 시각으로 "예약"하면 바로 올라가 버렸다(2026-11-04) — 1분 여유를 두고 막는다. 바로 올리기는 scheduledFor가 null.
  if (parsed.data.scheduledFor && Date.parse(parsed.data.scheduledFor) < Date.now() - 60_000) {
    return { ok: false, error: "이미 지난 시각이에요. 예약 시각을 다시 고르거나 '바로 올리기'를 골라 주세요." };
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

  // 연결 해제(0016)된 계정으로는 새 발행을 만들지 않는다 — 토큰이 없어 실패만 쌓인다.
  const { data: accounts } = await supabase
    .from("social_accounts")
    .select("id, platform")
    .in("id", parsed.data.accountIds)
    .is("disconnected_at", null);
  if (!accounts || accounts.length === 0) {
    return { ok: false, error: "계정 조회 실패" };
  }

  // 중복 발행 가드 — 같은 콘텐츠에 대해 아직 처리가 안 끝난 job이 있는 계정은 제외한다.
  // (마법사 '완료'가 두 번 눌리면 5초 간격으로 같은 배치가 두 번 등록돼 릴스가 2개씩
  //  올라갔다. 클라이언트 잠금은 upload-wizard에서, 최종 방어선은 0013 unique index.)
  const { data: liveJobs } = await supabase
    .from("publish_jobs")
    .select("social_account_id")
    .eq("content_id", parsed.data.contentId)
    .in("status", ["PENDING", "PROCESSING", "RETRYING"])
    .is("deleted_at", null);

  const queuedAccountIds = new Set(
    (liveJobs ?? []).map((j) => j.social_account_id),
  );
  const targets = accounts.filter((a) => !queuedAccountIds.has(a.id));

  if (targets.length === 0) {
    return {
      ok: false,
      error:
        "이미 등록된 발행 작업이 있어요. 배포 관리에서 진행 상황을 확인해주세요.",
    };
  }

  // 시리즈는 그 계정의 것이어야 한다(시리즈는 계정 1개에 속함). 아니면 조용히 무시하지 않고
  // 막는다 — 다른 계정 시리즈 댓글에 알림이 가는 사고를 피하려고.
  const seriesByAccount = parsed.data.seriesByAccount ?? {};
  const seriesIds = Array.from(new Set(Object.values(seriesByAccount).map((v) => v.seriesId)));
  if (seriesIds.length > 0) {
    const { data: seriesRows } = await supabase
      .from("series")
      .select("id, social_account_id")
      .in("id", seriesIds)
      .is("deleted_at", null);
    const ownerById = new Map((seriesRows ?? []).map((s) => [s.id, s.social_account_id]));
    for (const [accountId, { seriesId }] of Object.entries(seriesByAccount)) {
      if (ownerById.get(seriesId) !== accountId) {
        return { ok: false, error: "선택한 시리즈를 찾을 수 없어요. 새로고침 후 다시 골라주세요." };
      }
    }
  }

  const mediaCount = content.media_urls.length;
  const jobs = targets.map((a) => ({
    content_id: parsed.data.contentId,
    social_account_id: a.id,
    post_type: pickPostType(
      a.platform as Platform,
      content.media_type as MediaType,
      mediaCount,
    ),
    scheduled_for: parsed.data.scheduledFor,
    is_ai_generated: true,
    // 시리즈를 고른 경우에만 키를 넣는다 — 0017 적용 전 DB에서도 일반 발행은 그대로 되게.
    ...(a.platform === "INSTAGRAM" && seriesByAccount[a.id]
      ? {
          series_id: seriesByAccount[a.id].seriesId,
          series_reply_enabled: seriesByAccount[a.id].reply,
        }
      : {}),
  }));

  const { error } = await supabase.from("publish_jobs").insert(jobs);
  if (error) {
    // 23505 = unique_violation. 위 가드와 insert 사이에 같은 요청이 한 번 더 들어온
    // 경합 상황 — 먼저 들어간 배치가 이미 유효하므로 실패가 아니라 "추가 안 함"으로 본다.
    if (error.code === "23505") {
      return {
        ok: true,
        count: 0,
        note: "이미 등록된 발행 작업이 있어 추가로 등록하지 않았어요.",
      };
    }
    return { ok: false, error: error.message };
  }

  // 즉시 발행이면 GitHub Actions를 그 자리에서 깨운다(repository_dispatch → process-due).
  // 예약 발행이면 트리거하지 않는다 — 30분 cron sweep이 scheduled_for를 보고 처리한다.
  // dispatch 실패는 비치명적: PENDING으로 남은 job을 다음 cron sweep이 ≤30분 내 집어간다.
  const isImmediate =
    !parsed.data.scheduledFor ||
    new Date(parsed.data.scheduledFor) <= new Date();

  revalidatePath("/");
  revalidatePath("/postings");
  revalidatePath("/uploads");

  if (isImmediate) {
    try {
      await triggerPublishRun(`content:${parsed.data.contentId}`);
    } catch (dispatchError) {
      console.error("[createPublishJobs] dispatch 실패:", dispatchError);
      return {
        ok: true,
        count: jobs.length,
        note: "발행 작업을 등록했어요. 즉시 실행 트리거에 실패해 잠시 후(최대 30분) 자동으로 게시됩니다.",
      };
    }
  }

  return { ok: true, count: jobs.length };
}

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  addEpisode,
  createAlertTask,
  EpisodeAlertError,
  getInstagramAuth,
} from "@/lib/episode-alerts/server";
import { validateTemplates } from "@/lib/episode-alerts/templates";
import { triggerEpisodeAlertRun } from "@/lib/github-dispatch";
import {
  getInstagramMedia,
  InstagramApiError,
  listInstagramMedia,
  type InstagramMedia,
} from "@/lib/platforms/instagram-comments";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

// 다음 화 알림 서버 액션. 새 테이블은 authenticated에 쓰기 정책이 없어(0017) 모든 쓰기는
// service_role로 하고, 권한(ADMIN/MANAGER)과 조직 범위는 여기서 직접 검증한다.

export type ActionResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

type Service = ReturnType<typeof createServiceClient>;

interface Auth {
  userId: string;
  organizationId: string;
  canManage: boolean;
}

async function authorize(requireManage: boolean): Promise<Auth | { error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "로그인이 필요합니다." };

  const { data: profile } = await supabase
    .from("profiles")
    .select("organization_id, role")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile?.organization_id) return { error: "소속된 조직이 없습니다." };

  const canManage = profile.role === "ADMIN" || profile.role === "MANAGER";
  if (requireManage && !canManage) {
    return { error: "다음 화 알림 설정은 관리자(ADMIN/MANAGER)만 바꿀 수 있어요." };
  }
  return { userId: user.id, organizationId: profile.organization_id, canManage };
}

// 인스타 API·도메인 오류를 사용자에게 보여줄 문구로.
function toMessage(err: unknown): string {
  if (err instanceof EpisodeAlertError) return err.message;
  if (err instanceof InstagramApiError) {
    if (err.kind === "TOKEN") return "계정 토큰이 만료됐어요. 계정 연동에서 다시 연결해주세요.";
    if (err.kind === "RATE_LIMIT") return "인스타 호출 한도에 걸렸어요. 잠시 뒤 다시 시도해주세요.";
    if (err.kind === "NOT_FOUND") return "인스타 게시물을 찾을 수 없어요. 지워졌는지 확인해주세요.";
    return `인스타 오류: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

async function dispatchSoft(reason: string) {
  // 트리거 실패는 비치명적 — 작업은 DB에 남고 다음 publish run 완료 때 이어진다.
  try {
    await triggerEpisodeAlertRun(reason);
  } catch (err) {
    console.error("[episode-alerts] dispatch 실패:", err);
  }
}

function revalidate() {
  revalidatePath("/episode-alerts");
  revalidatePath("/", "layout");
}

async function loadSeries(service: Service, seriesId: string, organizationId: string) {
  const { data } = await service
    .from("series")
    .select("id, name, organization_id, social_account_id, deleted_at")
    .eq("id", seriesId)
    .maybeSingle();
  if (!data || data.organization_id !== organizationId || data.deleted_at) return null;
  return data;
}

async function loadTask(service: Service, taskId: string, organizationId: string) {
  const { data } = await service
    .from("episode_alert_tasks")
    .select("*")
    .eq("id", taskId)
    .maybeSingle();
  if (!data || data.organization_id !== organizationId) return null;
  return data;
}

// 인스타 계정 확인 + 토큰. 다른 조직 계정이면 거절.
async function authForAccount(service: Service, accountId: string, organizationId: string) {
  const auth = await getInstagramAuth(service, accountId);
  if (auth.organizationId !== organizationId) {
    throw new EpisodeAlertError("계정을 찾을 수 없어요.");
  }
  return auth;
}

// 대량 id를 PATCH 쿼리스트링에 한 번에 실으면 URL 길이 한도를 넘는다 — 나눠서 처리.
async function excludePending(
  service: Service,
  taskId: string,
  reason: string,
  replyIds?: string[],
) {
  if (!replyIds) {
    await service
      .from("episode_alert_replies")
      .update({ status: "EXCLUDED", skip_reason: reason })
      .eq("task_id", taskId)
      .eq("status", "PENDING");
    return;
  }
  for (let i = 0; i < replyIds.length; i += 100) {
    await service
      .from("episode_alert_replies")
      .update({ status: "EXCLUDED", skip_reason: reason })
      .eq("task_id", taskId)
      .eq("status", "PENDING")
      .in("id", replyIds.slice(i, i + 100));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 인스타 게시물 불러오기 (회차 고르기용)
// ─────────────────────────────────────────────────────────────────────────────

export interface PickerMedia extends InstagramMedia {
  // 이미 이 계정의 어떤 시리즈 회차인지.
  usedIn: { seriesId: string; seriesName: string; episodeNo: number }[];
}

export async function listAccountMediaAction(input: {
  accountId: string;
  after?: string | null;
}): Promise<ActionResult<{ items: PickerMedia[]; nextCursor: string | null }>> {
  const parsed = z
    .object({ accountId: z.string().uuid(), after: z.string().max(500).nullish() })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };

  const auth = await authorize(false);
  if ("error" in auth) return { ok: false, error: auth.error };

  const service = createServiceClient();
  try {
    const ig = await authForAccount(service, parsed.data.accountId, auth.organizationId);
    const page = await listInstagramMedia(ig.token, { after: parsed.data.after, limit: 24 });

    const { data: used } = await service
      .from("series_episodes")
      .select("ig_media_id, episode_no, series!inner(id, name, social_account_id, deleted_at)")
      .in("ig_media_id", page.items.map((m) => m.id))
      .eq("series.social_account_id", parsed.data.accountId)
      .is("series.deleted_at", null);

    const items = page.items.map((m) => ({
      ...m,
      usedIn: (used ?? [])
        .filter((u) => u.ig_media_id === m.id)
        .map((u) => ({
          seriesId: u.series.id,
          seriesName: u.series.name,
          episodeNo: u.episode_no,
        })),
    }));
    return { ok: true, items, nextCursor: page.nextCursor };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 시리즈
// ─────────────────────────────────────────────────────────────────────────────

const nameSchema = z
  .string()
  .trim()
  .min(1, "시리즈 이름을 입력해주세요.")
  .max(60, "시리즈 이름은 60자 이내로 입력해주세요.");

export async function createSeriesAction(input: {
  accountId: string;
  name: string;
  mediaIds: string[];
}): Promise<ActionResult<{ seriesId: string }>> {
  const parsed = z
    .object({
      accountId: z.string().uuid(),
      name: nameSchema,
      mediaIds: z.array(z.string().min(1).max(64)).max(50),
    })
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "잘못된 입력" };
  }

  const auth = await authorize(true);
  if ("error" in auth) return { ok: false, error: auth.error };

  const service = createServiceClient();
  try {
    const ig = await authForAccount(service, parsed.data.accountId, auth.organizationId);

    const { data: series, error } = await service
      .from("series")
      .insert({
        organization_id: auth.organizationId,
        social_account_id: parsed.data.accountId,
        name: parsed.data.name,
        created_by: auth.userId,
      })
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") {
        return { ok: false, error: "이 계정에 같은 이름의 시리즈가 이미 있어요." };
      }
      return { ok: false, error: error.message };
    }

    // 고른 순서대로 1화, 2화… 이미 올라간 회차라 알림 작업은 만들지 않는다.
    for (const mediaId of parsed.data.mediaIds) {
      const media = await getInstagramMedia(mediaId, ig.token);
      await addEpisode(service, {
        seriesId: series.id,
        igMediaId: media.id,
        permalink: media.permalink,
        caption: media.caption,
        mediaType: media.mediaType,
        postedAt: media.timestamp,
      });
    }

    revalidate();
    return { ok: true, seriesId: series.id };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

export async function renameSeriesAction(input: {
  seriesId: string;
  name: string;
}): Promise<ActionResult> {
  const parsed = z.object({ seriesId: z.string().uuid(), name: nameSchema }).safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "잘못된 입력" };
  }
  const auth = await authorize(true);
  if ("error" in auth) return { ok: false, error: auth.error };

  const service = createServiceClient();
  const series = await loadSeries(service, parsed.data.seriesId, auth.organizationId);
  if (!series) return { ok: false, error: "시리즈를 찾을 수 없어요." };

  const { error } = await service
    .from("series")
    .update({ name: parsed.data.name })
    .eq("id", series.id);
  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: "이 계정에 같은 이름의 시리즈가 이미 있어요." };
    }
    return { ok: false, error: error.message };
  }
  revalidate();
  return { ok: true };
}

// 소프트 삭제 — 보낸 답글 기록은 남긴다. 진행 중인 알림은 멈춘다.
export async function deleteSeriesAction(input: { seriesId: string }): Promise<ActionResult> {
  const parsed = z.object({ seriesId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize(true);
  if ("error" in auth) return { ok: false, error: auth.error };

  const service = createServiceClient();
  const series = await loadSeries(service, parsed.data.seriesId, auth.organizationId);
  if (!series) return { ok: false, error: "시리즈를 찾을 수 없어요." };

  const nowIso = new Date().toISOString();
  const { data: open } = await service
    .from("episode_alert_tasks")
    .update({ status: "CANCELLED", completed_at: nowIso, locked_at: null })
    .eq("series_id", series.id)
    .in("status", ["COLLECTING", "AWAITING_APPROVAL", "SENDING"])
    .select("id");
  for (const t of open ?? []) await excludePending(service, t.id, "시리즈 삭제");

  const { error } = await service
    .from("series")
    .update({ deleted_at: nowIso })
    .eq("id", series.id);
  if (error) return { ok: false, error: error.message };

  revalidate();
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 회차
// ─────────────────────────────────────────────────────────────────────────────

export async function addEpisodeAction(input: {
  seriesId: string;
  mediaId: string;
  notify: boolean;
}): Promise<ActionResult<{ episodeNo: number; alert: "created" | "none" }>> {
  const parsed = z
    .object({
      seriesId: z.string().uuid(),
      mediaId: z.string().min(1).max(64),
      notify: z.boolean(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };

  const auth = await authorize(true);
  if ("error" in auth) return { ok: false, error: auth.error };

  const service = createServiceClient();
  try {
    const series = await loadSeries(service, parsed.data.seriesId, auth.organizationId);
    if (!series) return { ok: false, error: "시리즈를 찾을 수 없어요." };
    const ig = await authForAccount(service, series.social_account_id, auth.organizationId);

    const media = await getInstagramMedia(parsed.data.mediaId, ig.token);
    const episode = await addEpisode(service, {
      seriesId: series.id,
      igMediaId: media.id,
      permalink: media.permalink,
      caption: media.caption,
      mediaType: media.mediaType,
      postedAt: media.timestamp,
    });

    let alert: "created" | "none" = "none";
    if (parsed.data.notify) {
      const result = await createAlertTask(service, {
        episode,
        organizationId: auth.organizationId,
        socialAccountId: series.social_account_id,
        createdBy: auth.userId,
        force: true,
      });
      if (result.created) {
        alert = "created";
        await dispatchSoft("episode-added");
      }
    }

    revalidate();
    return { ok: true, episodeNo: episode.episode_no, alert };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

// 잘못 고른 회차를 되돌리는 용도. 맨 마지막 회차만, 알림을 보낸 적 없을 때만 뺄 수 있다.
export async function removeLastEpisodeAction(input: {
  episodeId: string;
}): Promise<ActionResult> {
  const parsed = z.object({ episodeId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize(true);
  if ("error" in auth) return { ok: false, error: auth.error };

  const service = createServiceClient();
  const { data: episode } = await service
    .from("series_episodes")
    .select("id, series_id, episode_no")
    .eq("id", parsed.data.episodeId)
    .maybeSingle();
  if (!episode) return { ok: false, error: "회차를 찾을 수 없어요." };
  const series = await loadSeries(service, episode.series_id, auth.organizationId);
  if (!series) return { ok: false, error: "시리즈를 찾을 수 없어요." };

  const { data: last } = await service
    .from("series_episodes")
    .select("id")
    .eq("series_id", series.id)
    .order("episode_no", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (last?.id !== episode.id) {
    return { ok: false, error: "마지막 회차만 뺄 수 있어요." };
  }

  const { data: tasks } = await service
    .from("episode_alert_tasks")
    .select("id")
    .or(`target_episode_id.eq.${episode.id},source_episode_id.eq.${episode.id}`);
  const taskIds = (tasks ?? []).map((t) => t.id);
  if (taskIds.length > 0) {
    const { count } = await service
      .from("episode_alert_replies")
      .select("id", { count: "exact", head: true })
      .in("task_id", taskIds)
      .eq("status", "SENT");
    if ((count ?? 0) > 0) {
      return { ok: false, error: "이미 알림을 보낸 회차라 뺄 수 없어요. 기록을 지키기 위해서예요." };
    }
    await service.from("episode_alert_tasks").delete().in("id", taskIds);
  }

  const { error } = await service.from("series_episodes").delete().eq("id", episode.id);
  if (error) return { ok: false, error: error.message };

  revalidate();
  return { ok: true };
}

// 알림 없이 추가된 회차(불러온 회차, 설정이 꺼져 있던 때)에 직접 알림을 만든다.
export async function notifyEpisodeAction(input: {
  episodeId: string;
}): Promise<ActionResult> {
  const parsed = z.object({ episodeId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize(true);
  if ("error" in auth) return { ok: false, error: auth.error };

  const service = createServiceClient();
  try {
    const { data: episode } = await service
      .from("series_episodes")
      .select("*")
      .eq("id", parsed.data.episodeId)
      .maybeSingle();
    if (!episode) return { ok: false, error: "회차를 찾을 수 없어요." };
    const series = await loadSeries(service, episode.series_id, auth.organizationId);
    if (!series) return { ok: false, error: "시리즈를 찾을 수 없어요." };
    await authForAccount(service, series.social_account_id, auth.organizationId);

    const result = await createAlertTask(service, {
      episode,
      organizationId: auth.organizationId,
      socialAccountId: series.social_account_id,
      createdBy: auth.userId,
      force: true,
    });
    if (!result.created) {
      return {
        ok: false,
        error:
          result.reason === "no-previous"
            ? "이전 회차가 없어서 알릴 대상이 없어요."
            : "이 회차는 이미 알림이 만들어져 있어요.",
      };
    }
    await dispatchSoft("episode-notify");
    revalidate();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 계정별 설정
// ─────────────────────────────────────────────────────────────────────────────

export async function saveAlertSettingsAction(input: {
  accountId: string;
  enabled: boolean;
  mode: "APPROVAL" | "AUTO";
  templates: string[];
  dailyLimit: number;
}): Promise<ActionResult> {
  const parsed = z
    .object({
      accountId: z.string().uuid(),
      enabled: z.boolean(),
      mode: z.enum(["APPROVAL", "AUTO"]),
      templates: z.array(z.string()).max(20),
      dailyLimit: z.number().int().min(1, "하루 최대 답글 수는 1 이상이어야 해요.").max(1000, "하루 최대 답글 수는 1000 이하로 정해주세요."),
    })
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "잘못된 입력" };
  }

  const templates = parsed.data.templates.map((t) => t.trim()).filter(Boolean);
  const { errors } = validateTemplates(templates);
  if (errors.length > 0) return { ok: false, error: errors[0] };

  const auth = await authorize(true);
  if ("error" in auth) return { ok: false, error: auth.error };

  const service = createServiceClient();
  const { data: account } = await service
    .from("social_accounts")
    .select("id, organization_id, platform")
    .eq("id", parsed.data.accountId)
    .maybeSingle();
  if (!account || account.organization_id !== auth.organizationId || account.platform !== "INSTAGRAM") {
    return { ok: false, error: "계정을 찾을 수 없어요." };
  }

  const { error } = await service.from("episode_alert_settings").upsert(
    {
      social_account_id: account.id,
      organization_id: auth.organizationId,
      enabled: parsed.data.enabled,
      mode: parsed.data.mode,
      templates,
      daily_limit: parsed.data.dailyLimit,
      updated_by: auth.userId,
    },
    { onConflict: "social_account_id" },
  );
  if (error) return { ok: false, error: error.message };

  revalidate();
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 알림 작업 — 확인 후 보내기 / 중단 / 다시 시도
// ─────────────────────────────────────────────────────────────────────────────

export async function approveAlertTaskAction(input: {
  taskId: string;
  excludeReplyIds: string[];
}): Promise<ActionResult<{ sending: number }>> {
  const parsed = z
    .object({
      taskId: z.string().uuid(),
      excludeReplyIds: z.array(z.string().uuid()).max(10_000),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize(true);
  if ("error" in auth) return { ok: false, error: auth.error };

  const service = createServiceClient();
  const task = await loadTask(service, parsed.data.taskId, auth.organizationId);
  if (!task) return { ok: false, error: "알림을 찾을 수 없어요." };
  if (task.status !== "AWAITING_APPROVAL") {
    return { ok: false, error: "이미 처리된 알림이에요. 새로고침해주세요." };
  }

  if (parsed.data.excludeReplyIds.length > 0) {
    await excludePending(service, task.id, "보내기 전에 제외", parsed.data.excludeReplyIds);
  }

  const { count } = await service
    .from("episode_alert_replies")
    .select("id", { count: "exact", head: true })
    .eq("task_id", task.id)
    .eq("status", "PENDING");
  const sending = count ?? 0;
  const nowIso = new Date().toISOString();

  const { error } = await service
    .from("episode_alert_tasks")
    .update(
      sending === 0
        ? { status: "DONE", completed_at: nowIso, locked_at: null }
        : { status: "SENDING", scheduled_for: nowIso, locked_at: null },
    )
    .eq("id", task.id)
    .eq("status", "AWAITING_APPROVAL");
  if (error) return { ok: false, error: error.message };

  if (sending > 0) await dispatchSoft("approved");
  revalidate();
  return { ok: true, sending };
}

export async function cancelAlertTaskAction(input: { taskId: string }): Promise<ActionResult> {
  const parsed = z.object({ taskId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize(true);
  if ("error" in auth) return { ok: false, error: auth.error };

  const service = createServiceClient();
  const task = await loadTask(service, parsed.data.taskId, auth.organizationId);
  if (!task) return { ok: false, error: "알림을 찾을 수 없어요." };

  const { data: cancelled, error } = await service
    .from("episode_alert_tasks")
    .update({ status: "CANCELLED", completed_at: new Date().toISOString(), locked_at: null })
    .eq("id", task.id)
    .in("status", ["COLLECTING", "AWAITING_APPROVAL", "SENDING"])
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!cancelled || cancelled.length === 0) {
    return { ok: false, error: "이미 끝난 알림이에요." };
  }
  await excludePending(service, task.id, "보내기 중단");

  revalidate();
  return { ok: true };
}

export async function retryAlertTaskAction(input: { taskId: string }): Promise<ActionResult> {
  const parsed = z.object({ taskId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize(true);
  if ("error" in auth) return { ok: false, error: auth.error };

  const service = createServiceClient();
  const task = await loadTask(service, parsed.data.taskId, auth.organizationId);
  if (!task) return { ok: false, error: "알림을 찾을 수 없어요." };
  if (task.status !== "FAILED") return { ok: false, error: "실패한 알림만 다시 시도할 수 있어요." };

  try {
    // 토큰을 다시 연결했는지 먼저 확인 — 안 했으면 바로 같은 이유로 실패한다.
    await authForAccount(service, task.social_account_id, auth.organizationId);
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }

  // 수집 단계에서 실패했으면(대상이 없거나, 확인 후 보내기인데 아직 아무것도 처리 안 함)
  // 다시 수집부터. 수집은 같은 댓글을 두 번 넣지 않아 반복해도 안전하다.
  const { data: rows } = await service
    .from("episode_alert_replies")
    .select("status")
    .eq("task_id", task.id)
    .in("status", ["SENT", "EXCLUDED", "PENDING"])
    .limit(1000);
  const statuses = new Set((rows ?? []).map((r) => r.status));
  const nothingHandled = !statuses.has("SENT") && !statuses.has("EXCLUDED");
  const nextStatus =
    (rows ?? []).length === 0 || (task.mode === "APPROVAL" && nothingHandled)
      ? "COLLECTING"
      : "SENDING";

  const { error } = await service
    .from("episode_alert_tasks")
    .update({
      status: nextStatus,
      error_count: 0,
      last_error: null,
      completed_at: null,
      locked_at: null,
      scheduled_for: new Date().toISOString(),
    })
    .eq("id", task.id)
    .eq("status", "FAILED");
  if (error) return { ok: false, error: error.message };

  await dispatchSoft("retry");
  revalidate();
  return { ok: true };
}

// 보낸 기록 자세히 보기.
export interface ReplyDetail {
  id: string;
  username: string | null;
  commentText: string | null;
  status: "PENDING" | "SENT" | "SKIPPED" | "EXCLUDED" | "FAILED";
  reason: string | null;
  replyText: string | null;
  sentAt: string | null;
}

export async function getTaskRepliesAction(input: {
  taskId: string;
}): Promise<ActionResult<{ replies: ReplyDetail[]; truncated: boolean }>> {
  const parsed = z.object({ taskId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize(false);
  if ("error" in auth) return { ok: false, error: auth.error };

  // RLS(조직 범위)로 읽는다.
  const supabase = await createClient();
  const LIMIT = 1000;
  const { data, error } = await supabase
    .from("episode_alert_replies")
    .select("id, commenter_username, comment_text, status, skip_reason, error, reply_text, sent_at, commented_at")
    .eq("task_id", parsed.data.taskId)
    .order("commented_at", { ascending: false, nullsFirst: false })
    .limit(LIMIT + 1);
  if (error) return { ok: false, error: error.message };

  const rows = data ?? [];
  return {
    ok: true,
    truncated: rows.length > LIMIT,
    replies: rows.slice(0, LIMIT).map((r) => ({
      id: r.id,
      username: r.commenter_username,
      commentText: r.comment_text,
      status: r.status,
      reason: r.status === "FAILED" ? r.error : r.skip_reason,
      replyText: r.reply_text,
      sentAt: r.sent_at,
    })),
  };
}

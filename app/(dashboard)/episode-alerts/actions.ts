"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import {
  addEpisode,
  disableEpisodeReplies,
  enableEpisodeReplies,
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

// 시리즈 댓글 자동화 서버 액션. 새 테이블은 authenticated에 쓰기 정책이 없어(0017) 모든 쓰기는
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
    return { error: "시리즈 댓글 자동화 설정은 관리자(ADMIN/MANAGER)만 바꿀 수 있어요." };
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

// 답글 워크플로 깨우기. 응답을 붙잡지 않게 응답을 보낸 뒤에 실행한다(after).
// 트리거 실패는 비치명적 — 작업은 DB에 남고 다음 publish run 완료 때 이어진다.
function dispatchSoft(reason: string) {
  after(async () => {
    try {
      await triggerEpisodeAlertRun(reason);
    } catch (err) {
      console.error("[episode-alerts] dispatch 실패:", err);
    }
  });
}

// 서버 액션에서 revalidatePath를 부르면 갱신된 화면이 액션 응답에 같이 실려 온다 —
// 클라이언트에서 router.refresh()를 또 부를 필요가 없다.
function revalidate() {
  revalidatePath("/episode-alerts");
  // 업로드 마법사의 "다음 화로 올리기" 선택지(시리즈·다음 회차 번호).
  revalidatePath("/upload");
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

// 회차 + 그 시리즈를 한 번에(DB 왕복 1번). 다른 조직이거나 지워진 시리즈면 null.
async function loadEpisodeWithSeries(
  service: Service,
  episodeId: string,
  organizationId: string,
) {
  const { data } = await service
    .from("series_episodes")
    .select("*, series!inner(id, name, organization_id, social_account_id, deleted_at)")
    .eq("id", episodeId)
    .maybeSingle();
  if (!data) return null;
  const { series, ...episode } = data;
  if (series.organization_id !== organizationId || series.deleted_at) return null;
  return { episode, series };
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

// 시리즈 답글 문구 — 빈 줄은 버리고, 오류가 있으면 첫 오류를 돌려준다.
function cleanTemplates(
  templates: string[],
): { ok: true; templates: string[] } | { ok: false; error: string } {
  const cleaned = templates.map((t) => t.trim()).filter(Boolean);
  const { errors } = validateTemplates(cleaned);
  if (errors.length > 0) return { ok: false, error: errors[0] };
  return { ok: true, templates: cleaned };
}

const nameSchema = z
  .string()
  .trim()
  .min(1, "시리즈 이름을 입력해주세요.")
  .max(60, "시리즈 이름은 60자 이내로 입력해주세요.");

export async function createSeriesAction(input: {
  accountId: string;
  name: string;
  templates: string[];
  mediaIds: string[];
}): Promise<ActionResult<{ seriesId: string }>> {
  const parsed = z
    .object({
      accountId: z.string().uuid(),
      name: nameSchema,
      templates: z.array(z.string()).max(20),
      mediaIds: z.array(z.string().min(1).max(64)).max(50),
    })
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "잘못된 입력" };
  }
  const templates = cleanTemplates(parsed.data.templates);
  if (!templates.ok) return { ok: false, error: templates.error };

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
        reply_templates: templates.templates,
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

// 시리즈별 답글 문구 저장. 보내는 중인 작업도 다음 답글부터 새 문구를 쓴다.
export async function updateSeriesTemplatesAction(input: {
  seriesId: string;
  templates: string[];
}): Promise<ActionResult> {
  const parsed = z
    .object({ seriesId: z.string().uuid(), templates: z.array(z.string()).max(20) })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const templates = cleanTemplates(parsed.data.templates);
  if (!templates.ok) return { ok: false, error: templates.error };

  const auth = await authorize(true);
  if ("error" in auth) return { ok: false, error: auth.error };

  const service = createServiceClient();
  const series = await loadSeries(service, parsed.data.seriesId, auth.organizationId);
  if (!series) return { ok: false, error: "시리즈를 찾을 수 없어요." };

  const { error } = await service
    .from("series")
    .update({ reply_templates: templates.templates })
    .eq("id", series.id);
  if (error) return { ok: false, error: error.message };

  revalidate();
  return { ok: true };
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
    .in("status", ["COLLECTING", "SENDING"])
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

// 회차 추가 — 답글은 꺼진 상태로 시작한다(0019). 켜는 건 회차 목록의 스위치로.
export async function addEpisodeAction(input: {
  seriesId: string;
  mediaId: string;
}): Promise<ActionResult<{ episodeNo: number }>> {
  const parsed = z
    .object({ seriesId: z.string().uuid(), mediaId: z.string().min(1).max(64) })
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

    revalidate();
    return { ok: true, episodeNo: episode.episode_no };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

export async function removeLastEpisodeAction(input: {
  episodeId: string;
}): Promise<ActionResult> {
  const parsed = z.object({ episodeId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize(true);
  if ("error" in auth) return { ok: false, error: auth.error };

  const service = createServiceClient();
  const loaded = await loadEpisodeWithSeries(service, parsed.data.episodeId, auth.organizationId);
  if (!loaded) return { ok: false, error: "회차를 찾을 수 없어요." };
  const { episode, series } = loaded;

  const [{ data: last }, { data: tasks }] = await Promise.all([
    service
      .from("series_episodes")
      .select("id")
      .eq("series_id", series.id)
      .order("episode_no", { ascending: false })
      .limit(1)
      .maybeSingle(),
    service
      .from("episode_alert_tasks")
      .select("id")
      .or(`target_episode_id.eq.${episode.id},source_episode_id.eq.${episode.id}`),
  ]);
  if (last?.id !== episode.id) {
    return { ok: false, error: "마지막 회차만 뺄 수 있어요." };
  }

  const taskIds = (tasks ?? []).map((t) => t.id);
  if (taskIds.length > 0) {
    const { count } = await service
      .from("episode_alert_replies")
      .select("id", { count: "exact", head: true })
      .in("task_id", taskIds)
      .eq("status", "SENT");
    if ((count ?? 0) > 0) {
      return { ok: false, error: "이미 답글을 보낸 회차라 뺄 수 없어요. 기록을 지키기 위해서예요." };
    }
    await service.from("episode_alert_tasks").delete().in("id", taskIds);
  }

  const { error } = await service.from("series_episodes").delete().eq("id", episode.id);
  if (error) return { ok: false, error: error.message };

  revalidate();
  return { ok: true };
}

// 회차 답글 켜기/끄기. 켜면 직전 화에 댓글 단 사람들에게 바로 답글을 보내기 시작하고,
// 끄면 남은 답글을 멈춘다(이미 보낸 답글은 그대로).
export async function setEpisodeReplyAction(input: {
  episodeId: string;
  enabled: boolean;
}): Promise<ActionResult> {
  const parsed = z
    .object({ episodeId: z.string().uuid(), enabled: z.boolean() })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize(true);
  if ("error" in auth) return { ok: false, error: auth.error };

  const service = createServiceClient();
  try {
    const loaded = await loadEpisodeWithSeries(service, parsed.data.episodeId, auth.organizationId);
    if (!loaded) return { ok: false, error: "회차를 찾을 수 없어요." };
    const { episode, series } = loaded;

    if (!parsed.data.enabled) {
      await disableEpisodeReplies(service, episode.id);
      revalidate();
      return { ok: true };
    }

    // 켜기 전에 토큰부터 확인 — 만료된 계정이면 켜자마자 실패만 쌓인다.
    await authForAccount(service, series.social_account_id, auth.organizationId);
    const result = await enableEpisodeReplies(service, {
      episode,
      organizationId: auth.organizationId,
      socialAccountId: series.social_account_id,
      createdBy: auth.userId,
    });
    if (!result.started && result.reason === "no-previous") {
      return { ok: false, error: "첫 회차는 답글을 달 이전 화가 없어요." };
    }
    if (result.started) dispatchSoft("episode-reply-on");
    revalidate();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 계정별 설정 — 하루 최대 답글 수
// ─────────────────────────────────────────────────────────────────────────────

export async function saveDailyLimitAction(input: {
  accountId: string;
  dailyLimit: number;
}): Promise<ActionResult> {
  const parsed = z
    .object({
      accountId: z.string().uuid(),
      dailyLimit: z
        .number()
        .int()
        .min(1, "하루 최대 답글 수는 1 이상이어야 해요.")
        .max(1000, "하루 최대 답글 수는 1000 이하로 정해주세요."),
    })
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "잘못된 입력" };
  }

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
// 답글 작업 — 다시 시도 / 기록
// ─────────────────────────────────────────────────────────────────────────────

export async function retryAlertTaskAction(input: { taskId: string }): Promise<ActionResult> {
  const parsed = z.object({ taskId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize(true);
  if ("error" in auth) return { ok: false, error: auth.error };

  const service = createServiceClient();
  const task = await loadTask(service, parsed.data.taskId, auth.organizationId);
  if (!task) return { ok: false, error: "답글 작업을 찾을 수 없어요." };
  if (task.status !== "FAILED") return { ok: false, error: "실패한 답글 작업만 다시 시도할 수 있어요." };

  try {
    // 토큰을 다시 연결했는지 먼저 확인 — 안 했으면 바로 같은 이유로 실패한다.
    await authForAccount(service, task.social_account_id, auth.organizationId);
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }

  // 수집 단계에서 실패했으면(아직 대상이 없음) 다시 모으기부터, 아니면 남은 대상 보내기.
  // 수집은 같은 댓글·같은 사람을 두 번 넣지 않아 반복해도 안전하다.
  const { count: replyCount } = await service
    .from("episode_alert_replies")
    .select("id", { count: "exact", head: true })
    .eq("task_id", task.id);
  const nextStatus = (replyCount ?? 0) === 0 ? "COLLECTING" : "SENDING";

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

  dispatchSoft("retry");
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

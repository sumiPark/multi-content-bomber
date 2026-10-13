import { decryptToken } from "@/lib/crypto";
import type { createServiceClient } from "@/lib/supabase/service";
import type { Database } from "@/types/database";

// 시리즈 댓글 자동화 — 서버 액션과 워커가 같이 쓰는 로직. service_role 클라이언트 전용.

type Service = ReturnType<typeof createServiceClient>;
type EpisodeRow = Database["public"]["Tables"]["series_episodes"]["Row"];
type TaskRow = Database["public"]["Tables"]["episode_alert_tasks"]["Row"];

// 계정별 설정은 하루 최대 답글 수 하나. 답글은 항상 바로 보내고(0019), 문구는 시리즈마다
// 따로 정한다(series.reply_templates, 0018).
export interface AlertSettings {
  dailyLimit: number;
  // 아직 한 번도 저장하지 않아 기본값을 보여주는 중인지.
  isDefault: boolean;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  dailyLimit: 200,
  isDefault: true,
};

// 회차 답글을 끌 때 남은 대상에 붙이는 사유. 다시 켜면 이 사유로 빠진 대상만 되살린다.
export const REPLY_OFF_REASON = "답글 끔";

// 사용자에게 그대로 보여줄 수 있는 문구를 담은 에러.
export class EpisodeAlertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EpisodeAlertError";
  }
}

export async function loadAlertSettings(
  service: Service,
  socialAccountId: string,
): Promise<AlertSettings> {
  const { data } = await service
    .from("episode_alert_settings")
    .select("daily_limit")
    .eq("social_account_id", socialAccountId)
    .maybeSingle();
  if (!data) return DEFAULT_ALERT_SETTINGS;
  return { dailyLimit: data.daily_limit, isDefault: false };
}

export interface InstagramAccountAuth {
  id: string;
  organizationId: string;
  platformAccountId: string;
  token: string;
}

// 인스타 계정의 복호화된 토큰. 해제·만료 상태면 사용자가 할 일을 담아 던진다.
export async function getInstagramAuth(
  service: Service,
  socialAccountId: string,
): Promise<InstagramAccountAuth> {
  const { data: account } = await service
    .from("social_accounts")
    .select(
      "id, organization_id, platform, platform_account_id, is_active, disconnected_at, access_token_encrypted",
    )
    .eq("id", socialAccountId)
    .maybeSingle();

  if (!account) throw new EpisodeAlertError("계정을 찾을 수 없어요.");
  if (account.platform !== "INSTAGRAM") {
    throw new EpisodeAlertError("시리즈 댓글 자동화는 인스타그램 계정만 쓸 수 있어요.");
  }
  if (account.disconnected_at) {
    throw new EpisodeAlertError("연결이 해제된 계정이에요. 계정 연동에서 다시 연결해주세요.");
  }
  if (!account.is_active || !account.access_token_encrypted) {
    throw new EpisodeAlertError("계정 토큰이 만료됐어요. 계정 연동에서 다시 연결해주세요.");
  }
  return {
    id: account.id,
    organizationId: account.organization_id,
    platformAccountId: account.platform_account_id,
    token: decryptToken(account.access_token_encrypted),
  };
}

export interface AddEpisodeInput {
  seriesId: string;
  igMediaId: string;
  permalink?: string | null;
  caption?: string | null;
  mediaType?: string | null;
  postedAt?: string | null;
  contentId?: string | null;
  publishJobId?: string | null;
}

// 다음 회차 번호를 DB가 원자적으로 매긴다. 같은 게시물이 이미 회차면 그 행을 돌려준다.
export async function addEpisode(
  service: Service,
  input: AddEpisodeInput,
): Promise<EpisodeRow> {
  const { data, error } = await service.rpc("add_series_episode", {
    p_series_id: input.seriesId,
    p_ig_media_id: input.igMediaId,
    p_permalink: input.permalink ?? null,
    // 캡션은 목록 표시용 — 너무 길면 자른다.
    p_caption: input.caption ? input.caption.slice(0, 500) : null,
    p_media_type: input.mediaType ?? null,
    p_posted_at: input.postedAt ?? null,
    p_content_id: input.contentId ?? null,
    p_publish_job_id: input.publishJobId ?? null,
  });
  if (error || !data) {
    throw new Error(`회차 추가 실패: ${error?.message ?? "응답 없음"}`);
  }
  return data;
}

export type CreateTaskResult =
  | { created: true; task: TaskRow }
  | { created: false; reason: "no-previous" | "exists"; task?: TaskRow };

/**
 * 새 회차(episode)에 대한 답글 작업을 만든다. 직전 회차(번호가 더 작은 것 중 가장 큰 것)의
 * 댓글 단 사람들이 대상이다. 새 회차 하나당 작업은 하나뿐이다(target_episode_id unique).
 */
export async function createAlertTask(
  service: Service,
  args: {
    episode: EpisodeRow;
    organizationId: string;
    socialAccountId: string;
    createdBy: string | null;
  },
): Promise<CreateTaskResult> {
  // 서로 독립이라 한 번에 묻는다(DB 왕복 줄이기).
  const [{ data: previous }, { data: existing }] = await Promise.all([
    service
      .from("series_episodes")
      .select("id")
      .eq("series_id", args.episode.series_id)
      .lt("episode_no", args.episode.episode_no)
      .order("episode_no", { ascending: false })
      .limit(1)
      .maybeSingle(),
    service
      .from("episode_alert_tasks")
      .select("*")
      .eq("target_episode_id", args.episode.id)
      .maybeSingle(),
  ]);
  if (!previous) return { created: false, reason: "no-previous" };
  if (existing) return { created: false, reason: "exists", task: existing };

  const { data: task, error } = await service
    .from("episode_alert_tasks")
    .insert({
      organization_id: args.organizationId,
      series_id: args.episode.series_id,
      social_account_id: args.socialAccountId,
      source_episode_id: previous.id,
      target_episode_id: args.episode.id,
      created_by: args.createdBy,
    })
    .select("*")
    .single();

  if (error) {
    // 23505 = 동시에 같은 회차로 작업이 만들어진 경합. 먼저 만든 쪽이 유효하다.
    if (error.code === "23505") {
      const { data: raced } = await service
        .from("episode_alert_tasks")
        .select("*")
        .eq("target_episode_id", args.episode.id)
        .maybeSingle();
      return { created: false, reason: "exists", task: raced ?? undefined };
    }
    throw new Error(`답글 작업 생성 실패: ${error.message}`);
  }
  return { created: true, task };
}

export type EnableResult =
  | { started: true }
  | { started: false; reason: "no-previous" | "already-running" };

/**
 * 회차 답글 켜기. 직전 화에 댓글 단 사람들에게 바로 보내도록 작업을 만들거나 되살린다.
 *   - 작업이 없으면 새로 만든다(COLLECTING → 워커가 모아서 바로 보냄).
 *   - 껐다 켜거나(CANCELLED), 실패했거나(FAILED), 다 보냈던(DONE) 작업은 다시 모은다.
 *     끌 때 빠졌던 대상은 되살리고, 그 사이 새로 댓글 단 사람도 더한다. 이미 답글을 받은
 *     사람은 다시 받지 않는다(수집 단계에서 같은 사람 제외).
 * 실제로 보내는 건 워커다 — 호출측이 워크플로를 깨운다.
 */
export async function enableEpisodeReplies(
  service: Service,
  args: {
    episode: EpisodeRow;
    organizationId: string;
    socialAccountId: string;
    createdBy: string | null;
  },
): Promise<EnableResult> {
  const created = await createAlertTask(service, args);
  // 첫 회차는 답글을 달 이전 화가 없다 — 켜지 않는다.
  if (!created.created && created.reason === "no-previous") {
    return { started: false, reason: "no-previous" };
  }
  await service
    .from("series_episodes")
    .update({ reply_enabled: true })
    .eq("id", args.episode.id);
  if (created.created) return { started: true };

  const task = created.task;
  if (!task) return { started: false, reason: "already-running" };
  if (task.status === "COLLECTING" || task.status === "SENDING") {
    return { started: false, reason: "already-running" };
  }

  await service
    .from("episode_alert_replies")
    .update({ status: "PENDING", skip_reason: null })
    .eq("task_id", task.id)
    .eq("status", "EXCLUDED")
    .eq("skip_reason", REPLY_OFF_REASON);
  await service
    .from("episode_alert_tasks")
    .update({
      status: "COLLECTING",
      error_count: 0,
      last_error: null,
      completed_at: null,
      locked_at: null,
      scheduled_for: new Date().toISOString(),
    })
    .eq("id", task.id);
  return { started: true };
}

/**
 * 회차 답글 끄기. 보내는 중이면 멈추고 남은 대상은 빼둔다(다시 켜면 되살아남).
 * 이미 보낸 답글은 그대로다.
 */
export async function disableEpisodeReplies(service: Service, episodeId: string) {
  await service.from("series_episodes").update({ reply_enabled: false }).eq("id", episodeId);

  const { data: task } = await service
    .from("episode_alert_tasks")
    .update({
      status: "CANCELLED",
      completed_at: new Date().toISOString(),
      locked_at: null,
    })
    .eq("target_episode_id", episodeId)
    .in("status", ["COLLECTING", "SENDING"])
    .select("id")
    .maybeSingle();
  if (task) {
    await service
      .from("episode_alert_replies")
      .update({ status: "EXCLUDED", skip_reason: REPLY_OFF_REASON })
      .eq("task_id", task.id)
      .eq("status", "PENDING");
  }
}

/**
 * 발행 워커 훅 — "다음 화로 올리기"를 고른 인스타 발행이 성공하면 호출된다.
 * 회차로 기록하고, 업로드할 때 답글을 켜고 올렸으면(replyEnabled) 바로 답글을 시작한다.
 * 꺼두고 올렸으면 회차만 기록한다(나중에 화면에서 켤 수 있음).
 * 실패해도 발행 결과에는 영향을 주지 않도록 호출측에서 잡는다.
 */
export async function recordPublishedEpisode(
  service: Service,
  args: {
    seriesId: string;
    socialAccountId: string;
    igMediaId: string;
    permalink: string | null;
    caption: string | null;
    mediaType: string | null;
    contentId: string;
    publishJobId: string;
    replyEnabled: boolean;
  },
): Promise<EnableResult | null> {
  const { data: series } = await service
    .from("series")
    .select("id, organization_id, social_account_id, deleted_at")
    .eq("id", args.seriesId)
    .maybeSingle();
  // 발행 사이에 시리즈가 지워졌거나 다른 계정 시리즈면 회차로 기록하지 않는다.
  if (!series || series.deleted_at || series.social_account_id !== args.socialAccountId) {
    return null;
  }

  const episode = await addEpisode(service, {
    seriesId: series.id,
    igMediaId: args.igMediaId,
    permalink: args.permalink,
    caption: args.caption,
    mediaType: args.mediaType,
    postedAt: new Date().toISOString(),
    contentId: args.contentId,
    publishJobId: args.publishJobId,
  });

  if (!args.replyEnabled) return null;
  return enableEpisodeReplies(service, {
    episode,
    organizationId: series.organization_id,
    socialAccountId: series.social_account_id,
    createdBy: null,
  });
}

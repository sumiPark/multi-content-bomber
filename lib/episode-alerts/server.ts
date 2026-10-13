import { decryptToken } from "@/lib/crypto";
import type { createServiceClient } from "@/lib/supabase/service";
import type { Database } from "@/types/database";

// 시리즈 댓글 자동화 — 서버 액션과 워커가 같이 쓰는 로직. service_role 클라이언트 전용.

type Service = ReturnType<typeof createServiceClient>;
type EpisodeRow = Database["public"]["Tables"]["series_episodes"]["Row"];
type TaskRow = Database["public"]["Tables"]["episode_alert_tasks"]["Row"];

export type AlertMode = "APPROVAL" | "AUTO";

// 계정별 발송 설정. 답글 문구는 시리즈마다 따로 정한다(series.reply_templates, 0018).
export interface AlertSettings {
  mode: AlertMode;
  dailyLimit: number;
  // 아직 한 번도 저장하지 않아 기본값을 보여주는 중인지.
  isDefault: boolean;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  mode: "APPROVAL",
  dailyLimit: 200,
  isDefault: true,
};

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
    .select("mode, daily_limit")
    .eq("social_account_id", socialAccountId)
    .maybeSingle();
  if (!data) return DEFAULT_ALERT_SETTINGS;
  return {
    mode: data.mode,
    dailyLimit: data.daily_limit,
    isDefault: false,
  };
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
 * 보내는 방식(확인 후/바로)은 만들 때의 계정 설정을 스냅샷으로 남긴다.
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
  const settings = await loadAlertSettings(service, args.socialAccountId);

  const { data: previous } = await service
    .from("series_episodes")
    .select("id")
    .eq("series_id", args.episode.series_id)
    .lt("episode_no", args.episode.episode_no)
    .order("episode_no", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!previous) return { created: false, reason: "no-previous" };

  const { data: existing } = await service
    .from("episode_alert_tasks")
    .select("*")
    .eq("target_episode_id", args.episode.id)
    .maybeSingle();
  if (existing) return { created: false, reason: "exists", task: existing };

  const { data: task, error } = await service
    .from("episode_alert_tasks")
    .insert({
      organization_id: args.organizationId,
      series_id: args.episode.series_id,
      social_account_id: args.socialAccountId,
      source_episode_id: previous.id,
      target_episode_id: args.episode.id,
      mode: settings.mode,
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

/**
 * 발행 워커 훅 — "다음 화로 올리기"를 고른 인스타 발행이 성공하면 호출된다.
 * 회차로 기록하고, 직전 회차 댓글 단 사람들 대상 답글 작업을 만든다.
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
  },
): Promise<CreateTaskResult | null> {
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

  return createAlertTask(service, {
    episode,
    organizationId: series.organization_id,
    socialAccountId: series.social_account_id,
    createdBy: null,
  });
}

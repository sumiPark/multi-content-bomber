// server-only는 쓰지 않는다 — 워커(tsx + plain Node)에서 import하면 throw한다.
// 브라우저 번들 차단은 아래 instagram-comments의 server-guard가 맡는다.
import type { createServiceClient } from "@/lib/supabase/service";
import {
  getInstagramMe,
  listAllComments,
} from "@/lib/platforms/instagram-comments";
import type { Database } from "@/types/database";
import { EpisodeAlertError, type InstagramAccountAuth } from "./server";

// 시리즈 댓글 자동화 — 직전 화 댓글을 모아 답글 대상(PENDING)/건너뜀(SKIPPED)으로 기록한다.
// GitHub 답글 워커(처음 켰을 때)와 /api/cron/episode-replies(켜진 동안 새 댓글 확인)가 같이 쓴다.
// 같은 댓글·같은 사람은 두 번 넣지 않아 몇 번을 다시 돌려도 안전하다.

type Service = ReturnType<typeof createServiceClient>;
type TaskRow = Database["public"]["Tables"]["episode_alert_tasks"]["Row"];
type ReplyInsert = Database["public"]["Tables"]["episode_alert_replies"]["Insert"];

const INSERT_BATCH = 500;

// 반환: 이 작업에 남아 있는 답글 대상(PENDING) 수.
export async function collectCandidates(
  service: Service,
  task: TaskRow,
  auth: InstagramAccountAuth,
): Promise<number> {
  const { data: episodes } = await service
    .from("series_episodes")
    .select("id, ig_media_id, posted_at, created_at")
    .in("id", [task.source_episode_id, task.target_episode_id]);
  const source = episodes?.find((e) => e.id === task.source_episode_id);
  const target = episodes?.find((e) => e.id === task.target_episode_id);
  if (!source || !target) throw new EpisodeAlertError("회차 정보를 찾을 수 없어요.");

  // 내 댓글/내 답글 판별. 댓글 from.id는 저장된 platform_account_id(= /me의 id)가 아니라
  // /me의 user_id와 같다(실측). 셋 다, 그리고 사용자 이름까지 같이 비교한다.
  const me = await getInstagramMe(auth.token);
  const ownIds = new Set(
    [me.id, me.userId, auth.platformAccountId].filter((v): v is string => !!v),
  );
  const ownName = me.username.toLowerCase();
  const isOwn = (fromId: string | null, username: string | null) =>
    (fromId !== null && ownIds.has(fromId)) ||
    (username !== null && username.toLowerCase() === ownName);

  // 새 회차가 올라간 뒤에 우리 계정이 단 답글이 있으면 이미 알린 것으로 본다.
  const announcedSince = Date.parse(target.posted_at ?? target.created_at);

  const comments = await listAllComments(source.ig_media_id, auth.token);

  // 답글(parentId 있음)은 대상이 아니다 — 인스타는 최상위 댓글에만 답글을 허용한다.
  // 대신 내 답글은 "이미 알림을 단 댓글"을 거르는 데 쓴다.
  const lastOwnReplyAt = new Map<string, number>();
  for (const c of comments) {
    if (!c.parentId || !isOwn(c.fromId, c.username)) continue;
    const at = Date.parse(c.timestamp);
    if (at > (lastOwnReplyAt.get(c.parentId) ?? 0)) lastOwnReplyAt.set(c.parentId, at);
  }
  const topLevel = comments.filter((c) => !c.parentId);

  // 같은 사람에게는 한 번만. 다시 켜서 또 모을 때도 이미 대상이었던 사람은 빼고,
  // 그 사이 새로 댓글 단 사람만 더한다.
  const { data: existing } = await service
    .from("episode_alert_replies")
    .select("commenter_ig_id, commenter_username")
    .eq("task_id", task.id);
  const seen = new Set<string>(
    (existing ?? [])
      .map((r) => r.commenter_ig_id ?? r.commenter_username?.toLowerCase() ?? null)
      .filter((v): v is string => !!v),
  );
  const rows: ReplyInsert[] = topLevel.map((c) => {
    const base: ReplyInsert = {
      task_id: task.id,
      ig_comment_id: c.id,
      commenter_ig_id: c.fromId,
      commenter_username: c.username,
      comment_text: c.text.slice(0, 1000),
      commented_at: c.timestamp,
    };
    if (isOwn(c.fromId, c.username)) {
      return { ...base, status: "SKIPPED", skip_reason: "내 댓글" };
    }
    if (c.hidden) return { ...base, status: "SKIPPED", skip_reason: "숨긴 댓글" };

    // 최신순이라 같은 사람의 가장 최근 댓글에만 답글을 단다.
    const who = c.fromId ?? c.username?.toLowerCase() ?? c.id;
    if (seen.has(who)) {
      return { ...base, status: "SKIPPED", skip_reason: "같은 사람의 다른 댓글" };
    }
    seen.add(who);

    if (!c.username) {
      return { ...base, status: "SKIPPED", skip_reason: "사용자 이름을 알 수 없음" };
    }
    if ((lastOwnReplyAt.get(c.id) ?? 0) >= announcedSince) {
      return { ...base, status: "SKIPPED", skip_reason: "이미 답글을 달았어요" };
    }
    return { ...base, status: "PENDING" };
  });

  // 재수집(이전 시도가 중간에 실패)에도 같은 댓글이 두 번 들어가지 않게 무시 upsert.
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const { error } = await service
      .from("episode_alert_replies")
      .upsert(rows.slice(i, i + INSERT_BATCH), {
        onConflict: "task_id,ig_comment_id",
        ignoreDuplicates: true,
      });
    if (error) throw new Error(`답글 대상 저장 실패: ${error.message}`);
  }

  const { count } = await service
    .from("episode_alert_replies")
    .select("id", { count: "exact", head: true })
    .eq("task_id", task.id)
    .eq("status", "PENDING");

  console.log(
    `[episode-alerts] ${task.id} 수집 | 최상위 댓글 ${topLevel.length}개 → 대상 ${count ?? 0}명`,
  );
  return count ?? 0;
}

// server-only는 쓰지 않는다 — 워커(tsx + plain Node)에서 import하면 throw한다.
// 브라우저 번들 차단은 아래 instagram-comments의 server-guard가 맡는다.
import type { createServiceClient } from "@/lib/supabase/service";
import {
  getInstagramMe,
  listAllComments,
  type InstagramComment,
} from "@/lib/platforms/instagram-comments";
import type { Database } from "@/types/database";
import {
  excludeInactiveOlder,
  loadAutoReplyIds,
  loadCommentsClaimedBy,
  loadNewerExpandedTasks,
  loadTaskScope,
} from "./scope";
import type { InstagramAccountAuth } from "./server";

// 시리즈 댓글 자동화 — 대상 회차 댓글을 모아 답글 대상(PENDING)/건너뜀(SKIPPED)으로 기록한다.
// 대상 회차는 보통 직전 화 하나, "이전 화 댓글에도 보내기"면 1~(N-1)화 전체(scope.ts).
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
  const scope = await loadTaskScope(service, task);
  const { target } = scope;
  await excludeInactiveOlder(service, task, scope);

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
  const whoOf = (c: InstagramComment) => c.fromId ?? c.username?.toLowerCase() ?? c.id;

  // 새 회차가 올라간 뒤에 우리 계정이 손으로 단 답글이 있으면 이미 알린 것으로 본다.
  const announcedSince = Date.parse(target.posted_at ?? target.created_at);

  const newerTasks = await loadNewerExpandedTasks(service, task, scope);
  const [autoReplyIds, claimedByNewer, { data: existing }] = await Promise.all([
    loadAutoReplyIds(service, task.series_id),
    loadCommentsClaimedBy(service, newerTasks),
    service
      .from("episode_alert_replies")
      .select("commenter_ig_id, commenter_username, status")
      .eq("task_id", task.id),
  ]);

  // 같은 사람에게는 한 번만. 다시 모을 때도 이미 대상이었던 사람은 빼고, 그 사이 새로 댓글 단
  // 사람만 더한다. 값은 그 사람의 다른 댓글을 건너뛸 때 보여줄 이유.
  const seen = new Map<string, string>();
  for (const r of existing ?? []) {
    const key = r.commenter_ig_id ?? r.commenter_username?.toLowerCase();
    if (!key) continue;
    seen.set(
      key,
      r.status === "SENT" ? `이미 ${target.episode_no}화 답글을 받았어요` : "같은 사람의 다른 댓글",
    );
  }

  // 이 회차에 이미 댓글 단 사람은 소식을 이미 본 것이다.
  const targetComments = await listAllComments(target.ig_media_id, auth.token);
  const sawTarget = new Set(
    targetComments.filter((c) => !isOwn(c.fromId, c.username)).map(whoOf),
  );

  const rows: ReplyInsert[] = [];
  let topLevelCount = 0;
  for (const source of scope.sources) {
    const comments = await listAllComments(source.ig_media_id, auth.token);

    // 답글(parentId 있음)은 대상이 아니다 — 인스타는 최상위 댓글에만 답글을 허용한다.
    // 대신 내가 손으로 단 답글은 "이미 알림을 단 댓글"을 거르는 데 쓴다.
    const lastManualReplyAt = new Map<string, number>();
    for (const c of comments) {
      if (!c.parentId || !isOwn(c.fromId, c.username) || autoReplyIds.has(c.id)) continue;
      const at = Date.parse(c.timestamp);
      if (at > (lastManualReplyAt.get(c.parentId) ?? 0)) lastManualReplyAt.set(c.parentId, at);
    }

    for (const c of comments) {
      if (c.parentId) continue;
      topLevelCount++;
      const base: ReplyInsert = {
        task_id: task.id,
        source_episode_id: source.id,
        ig_comment_id: c.id,
        commenter_ig_id: c.fromId,
        commenter_username: c.username,
        comment_text: c.text.slice(0, 1000),
        commented_at: c.timestamp,
      };
      const skip = (reason: string): ReplyInsert => ({ ...base, status: "SKIPPED", skip_reason: reason });

      if (isOwn(c.fromId, c.username)) {
        rows.push(skip("내 댓글"));
        continue;
      }
      if (c.hidden) {
        rows.push(skip("숨긴 댓글"));
        continue;
      }

      // 최신 화부터, 화 안에서는 최신순이라 같은 사람의 가장 최근 댓글에만 답글을 단다.
      const who = whoOf(c);
      const prior = seen.get(who);
      if (prior) {
        rows.push(skip(prior));
        continue;
      }
      seen.set(who, "같은 사람의 다른 댓글");

      if (!c.username) {
        rows.push(skip("사용자 이름을 알 수 없음"));
      } else if (sawTarget.has(who)) {
        rows.push(skip(`이미 ${target.episode_no}화에 댓글을 달았어요`));
      } else if (claimedByNewer.has(c.id)) {
        rows.push(skip(`${claimedByNewer.get(c.id)}화 답글로 대신해요`));
      } else if ((lastManualReplyAt.get(c.id) ?? 0) >= announcedSince) {
        rows.push(skip("이미 답글을 달았어요"));
      } else {
        rows.push({ ...base, status: "PENDING" });
      }
    }
  }

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

  const scopeText = scope.sources.map((s) => s.episode_no).join(",");
  console.log(
    `[episode-alerts] ${task.id} 수집 | ${scopeText}화 최상위 댓글 ${topLevelCount}개 → 대상 ${count ?? 0}명`,
  );
  return count ?? 0;
}

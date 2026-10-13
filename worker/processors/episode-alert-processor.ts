import { createServiceClient } from "@/lib/supabase/service";
import {
  EpisodeAlertError,
  getInstagramAuth,
  loadAlertSettings,
  type InstagramAccountAuth,
} from "@/lib/episode-alerts/server";
import {
  effectiveTemplates,
  pickTemplate,
  renderTemplate,
} from "@/lib/episode-alerts/templates";
import {
  getInstagramMe,
  InstagramApiError,
  listAllComments,
  replyToComment,
} from "@/lib/platforms/instagram-comments";
import type { Database } from "@/types/database";

// ─────────────────────────────────────────────────────────────────────────────
// 다음 화 알림 작업 처리 (episode_alert_tasks 상태 머신).
//
//   COLLECTING ─ 직전 화 댓글 수집 → 답글 대상(PENDING)/건너뜀(SKIPPED) 기록
//       ├─ 확인 후 보내기(APPROVAL) → AWAITING_APPROVAL (사람이 "보내기"를 누르면 SENDING)
//       └─ 바로 보내기(AUTO)       → SENDING
//   SENDING ─ 간격을 두고 대댓글 등록. 하루 상한/시간 예산에 걸리면 다음 run으로 넘김.
//       └─ 대상이 다 끝나면 DONE
//
// 작업 단위 오류: 토큰 만료·연결 해제 → FAILED(재연결 후 "다시 시도"),
//   호출 한도 → 1시간 뒤, 인스타 활동 제한(368) → 24시간 뒤, 그 외 → 15분 뒤 (3번까지).
// 댓글 단위 오류: 댓글이 지워짐 → 그 건만 SKIPPED, 그 외 → 그 건만 FAILED.
// ─────────────────────────────────────────────────────────────────────────────

type Service = ReturnType<typeof createServiceClient>;
type TaskRow = Database["public"]["Tables"]["episode_alert_tasks"]["Row"];
type ReplyInsert = Database["public"]["Tables"]["episode_alert_replies"]["Insert"];

// 답글 사이 간격. 같은 문구를 짧은 간격으로 대량 등록하면 인스타가 스팸으로 보고 활동을
// 제한할 수 있다(공개 기준 없음). 무작위로 띄워 사람이 다는 속도에 가깝게.
const SEND_INTERVAL_MIN_MS = 10_000;
const SEND_INTERVAL_MAX_MS = 20_000;
// 한 번에 DB에서 꺼내 보낼 대상 수.
const SEND_BATCH = 20;
// 댓글 단위 실패가 연달아 이만큼 나면 작업을 멈춘다 (문구/권한 문제일 가능성).
const MAX_CONSECUTIVE_FAILURES = 5;
// 작업 단위 일반 오류 재시도 한도.
const MAX_TASK_ERRORS = 3;
const RATE_LIMIT_BACKOFF_MS = 60 * 60_000;
const BLOCKED_BACKOFF_MS = 24 * 60 * 60_000;
const ERROR_BACKOFF_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const INSERT_BATCH = 500;

export type TaskOutcome =
  | "awaiting-approval" // 확인 대기로 넘어감
  | "done" // 끝
  | "continue" // 시간 예산에 걸림 — 바로 다음 run이 이어서
  | "deferred" // 하루 상한·한도·오류로 나중에
  | "failed";

const nowIso = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randomInterval = () =>
  SEND_INTERVAL_MIN_MS +
  Math.floor(Math.random() * (SEND_INTERVAL_MAX_MS - SEND_INTERVAL_MIN_MS));

export async function processEpisodeAlertTask(
  service: Service,
  task: TaskRow,
  deadlineAt: number,
): Promise<TaskOutcome> {
  try {
    const auth = await getInstagramAuth(service, task.social_account_id);

    if (task.status === "COLLECTING") {
      const pending = await collectCandidates(service, task, auth);
      if (pending === 0) {
        await finish(service, task.id);
        return "done";
      }
      if (task.mode === "APPROVAL") {
        await updateTask(service, task.id, {
          status: "AWAITING_APPROVAL",
          locked_at: null,
          error_count: 0,
          last_error: null,
        });
        return "awaiting-approval";
      }
      await updateTask(service, task.id, { status: "SENDING", error_count: 0, last_error: null });
    }

    return await sendReplies(service, task, auth, deadlineAt);
  } catch (err) {
    return handleTaskError(service, task, err);
  }
}

// 잠금만 풀어 다음 run이 바로 이어받게 한다 (시간 예산에 걸려 손대지 못한 작업).
export async function releaseTask(service: Service, taskId: string) {
  await updateTask(service, taskId, { locked_at: null });
}

// ─────────────────────────────────────────────────────────────────────────────
// 수집
// ─────────────────────────────────────────────────────────────────────────────

async function collectCandidates(
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

  const seen = new Set<string>();
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

// ─────────────────────────────────────────────────────────────────────────────
// 발송
// ─────────────────────────────────────────────────────────────────────────────

async function sendReplies(
  service: Service,
  task: TaskRow,
  auth: InstagramAccountAuth,
  deadlineAt: number,
): Promise<TaskOutcome> {
  const settings = await loadAlertSettings(service, task.social_account_id);
  const templates = effectiveTemplates(settings.templates);

  const [{ data: series }, { data: target }] = await Promise.all([
    service.from("series").select("name").eq("id", task.series_id).maybeSingle(),
    service
      .from("series_episodes")
      .select("episode_no")
      .eq("id", task.target_episode_id)
      .maybeSingle(),
  ]);
  if (!series || !target) throw new EpisodeAlertError("시리즈 정보를 찾을 수 없어요.");

  // 문구는 순서대로 돌려쓴다 — run이 나뉘어도 이어지게 이미 보낸 수에서 시작.
  const { count: sentSoFar } = await service
    .from("episode_alert_replies")
    .select("id", { count: "exact", head: true })
    .eq("task_id", task.id)
    .eq("status", "SENT");
  let rotation = sentSoFar ?? 0;

  let remainingToday = settings.dailyLimit - (await sentInLastDay(service, task.social_account_id));
  let consecutiveFailures = 0;
  let sentThisRun = 0;

  for (;;) {
    if (remainingToday <= 0) {
      const resumeAt = await dailyWindowReopensAt(service, task.social_account_id);
      await updateTask(service, task.id, {
        locked_at: null,
        scheduled_for: resumeAt,
        last_error: null,
      });
      console.log(`[episode-alerts] ${task.id} 하루 상한 도달 — ${resumeAt}에 이어서`);
      return "deferred";
    }
    if (Date.now() + SEND_INTERVAL_MAX_MS + 5_000 > deadlineAt) {
      await updateTask(service, task.id, { locked_at: null, scheduled_for: nowIso() });
      console.log(`[episode-alerts] ${task.id} 시간 예산 소진 — 보냄 ${sentThisRun}개, 다음 run이 이어서`);
      return "continue";
    }

    const { data: batch, error } = await service
      .from("episode_alert_replies")
      .select("id, ig_comment_id, commenter_username")
      .eq("task_id", task.id)
      .eq("status", "PENDING")
      .order("commented_at", { ascending: false, nullsFirst: false })
      .limit(Math.min(SEND_BATCH, remainingToday));
    if (error) throw new Error(`답글 대상 조회 실패: ${error.message}`);
    if (!batch || batch.length === 0) {
      await finish(service, task.id);
      console.log(`[episode-alerts] ${task.id} 완료 — 이번 run 보냄 ${sentThisRun}개`);
      return "done";
    }

    for (const row of batch) {
      if (Date.now() + SEND_INTERVAL_MAX_MS + 5_000 > deadlineAt) break;

      // 발송 도중 사용자가 "중단"하면 남은 대상이 EXCLUDED로 바뀐다. 이미 꺼내둔 배치라도
      // 보내기 직전에 한 번 더 확인한다(답글 간격이 길어 조회 비용은 무시할 만하다).
      const { data: fresh } = await service
        .from("episode_alert_replies")
        .select("status")
        .eq("id", row.id)
        .maybeSingle();
      if (fresh?.status !== "PENDING") continue;

      const text = renderTemplate(pickTemplate(templates, rotation), {
        username: row.commenter_username ?? "",
        series: series.name,
        episode: target.episode_no,
      });

      try {
        const reply = await replyToComment(row.ig_comment_id, text, auth.token);
        await updateReply(service, row.id, {
          status: "SENT",
          reply_ig_id: reply.id,
          reply_text: text,
          sent_at: nowIso(),
          error: null,
        });
        rotation++;
        sentThisRun++;
        remainingToday--;
        consecutiveFailures = 0;
      } catch (err) {
        if (err instanceof InstagramApiError && err.kind === "NOT_FOUND") {
          await updateReply(service, row.id, {
            status: "SKIPPED",
            skip_reason: "댓글이 지워졌거나 답글을 달 수 없어요",
          });
        } else if (
          err instanceof InstagramApiError &&
          (err.kind === "TOKEN" || err.kind === "RATE_LIMIT" || err.kind === "BLOCKED")
        ) {
          // 계정 단위 문제 — 이 댓글은 PENDING 그대로 두고 작업 전체를 멈춘다.
          throw err;
        } else {
          const message = err instanceof Error ? err.message : String(err);
          await updateReply(service, row.id, { status: "FAILED", error: message.slice(0, 500) });
          consecutiveFailures++;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            throw new Error(`답글이 연달아 ${MAX_CONSECUTIVE_FAILURES}번 실패했어요: ${message}`);
          }
        }
      }

      if (remainingToday <= 0) break;
      await sleep(randomInterval());
    }
  }
}

// 이 계정이 최근 24시간 동안 보낸 답글 수 (모든 작업 합산).
async function sentInLastDay(service: Service, socialAccountId: string): Promise<number> {
  const since = new Date(Date.now() - DAY_MS).toISOString();
  const { count } = await service
    .from("episode_alert_replies")
    .select("id, episode_alert_tasks!inner(social_account_id)", {
      count: "exact",
      head: true,
    })
    .eq("status", "SENT")
    .gte("sent_at", since)
    .eq("episode_alert_tasks.social_account_id", socialAccountId);
  return count ?? 0;
}

// 하루 상한이 다시 열리는 시각 = 24시간 창 안의 가장 오래된 발송 + 24시간.
async function dailyWindowReopensAt(service: Service, socialAccountId: string): Promise<string> {
  const since = new Date(Date.now() - DAY_MS).toISOString();
  const { data } = await service
    .from("episode_alert_replies")
    .select("sent_at, episode_alert_tasks!inner(social_account_id)")
    .eq("status", "SENT")
    .gte("sent_at", since)
    .eq("episode_alert_tasks.social_account_id", socialAccountId)
    .order("sent_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const oldest = data?.sent_at ? Date.parse(data.sent_at) : Date.now();
  return new Date(oldest + DAY_MS + 60_000).toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// 오류 처리 / 상태 갱신
// ─────────────────────────────────────────────────────────────────────────────

async function handleTaskError(
  service: Service,
  task: TaskRow,
  err: unknown,
): Promise<TaskOutcome> {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[episode-alerts] ${task.id} 오류:`, message);

  if (err instanceof EpisodeAlertError) {
    await fail(service, task.id, message);
    return "failed";
  }

  if (err instanceof InstagramApiError) {
    if (err.kind === "TOKEN") {
      // 발행 워커와 같은 정책 — 계정을 비활성으로 표시해 재연결을 유도한다.
      await service
        .from("social_accounts")
        .update({ is_active: false, updated_at: nowIso() })
        .eq("id", task.social_account_id);
      await fail(
        service,
        task.id,
        "계정 토큰이 만료됐어요. 계정 연동에서 다시 연결한 뒤 '다시 시도'를 눌러주세요.",
      );
      return "failed";
    }
    if (err.kind === "RATE_LIMIT") {
      await defer(service, task.id, RATE_LIMIT_BACKOFF_MS, "인스타 호출 한도에 걸려 1시간 뒤 이어서 보내요.");
      return "deferred";
    }
    if (err.kind === "BLOCKED") {
      await defer(
        service,
        task.id,
        BLOCKED_BACKOFF_MS,
        "인스타가 이 계정의 댓글 활동을 잠시 제한했어요. 24시간 뒤 이어서 보내요.",
      );
      return "deferred";
    }
  }

  const errorCount = task.error_count + 1;
  if (errorCount >= MAX_TASK_ERRORS) {
    await updateTask(service, task.id, { error_count: errorCount });
    await fail(service, task.id, message.slice(0, 500));
    return "failed";
  }
  await updateTask(service, task.id, { error_count: errorCount });
  await defer(service, task.id, ERROR_BACKOFF_MS, message.slice(0, 500));
  return "deferred";
}

async function updateTask(
  service: Service,
  taskId: string,
  patch: Database["public"]["Tables"]["episode_alert_tasks"]["Update"],
) {
  // 처리 중에 사용자가 취소한 작업은 워커가 DONE/SENDING 등으로 되살리지 않는다.
  const { error } = await service
    .from("episode_alert_tasks")
    .update(patch)
    .eq("id", taskId)
    .neq("status", "CANCELLED");
  if (error) console.error(`[episode-alerts] ${taskId} 상태 갱신 실패:`, error.message);
}

async function updateReply(
  service: Service,
  replyId: string,
  patch: Database["public"]["Tables"]["episode_alert_replies"]["Update"],
) {
  const { error } = await service.from("episode_alert_replies").update(patch).eq("id", replyId);
  if (error) console.error(`[episode-alerts] 답글 ${replyId} 갱신 실패:`, error.message);
}

async function finish(service: Service, taskId: string) {
  await updateTask(service, taskId, {
    status: "DONE",
    completed_at: nowIso(),
    locked_at: null,
    last_error: null,
  });
}

async function fail(service: Service, taskId: string, message: string) {
  await updateTask(service, taskId, {
    status: "FAILED",
    completed_at: nowIso(),
    locked_at: null,
    last_error: message,
  });
}

async function defer(service: Service, taskId: string, delayMs: number, message: string) {
  await updateTask(service, taskId, {
    locked_at: null,
    scheduled_for: new Date(Date.now() + delayMs).toISOString(),
    last_error: message,
  });
}

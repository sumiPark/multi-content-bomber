import { createServiceClient } from "@/lib/supabase/service";
import { collectCandidates } from "@/lib/episode-alerts/collect";
import {
  excludeInactiveOlder,
  loadNewerExpandedTasks,
  loadTaskScope,
  type NewerTask,
} from "@/lib/episode-alerts/scope";
import {
  EpisodeAlertError,
  getInstagramAuth,
  loadAlertSettings,
  REPLY_OFF_REASON,
  type InstagramAccountAuth,
} from "@/lib/episode-alerts/server";
import {
  effectiveTemplates,
  pickTemplate,
  renderTemplate,
} from "@/lib/episode-alerts/templates";
import {
  InstagramApiError,
  replyToComment,
} from "@/lib/platforms/instagram-comments";
import type { Database } from "@/types/database";

// ─────────────────────────────────────────────────────────────────────────────
// 시리즈 댓글 자동화 작업 처리 (episode_alert_tasks 상태 머신).
//
//   COLLECTING ─ 대상 회차 댓글 수집(보통 직전 화, "이전 화에도"면 1~N-1화 — scope.ts)
//       → 답글 대상(PENDING)/건너뜀(SKIPPED) 기록 → 바로 SENDING
//   SENDING ─ 간격을 두고 대댓글 등록. 하루 상한/시간 예산에 걸리면 다음 run으로 넘김.
//       └─ 대상이 다 끝나면 DONE
//   회차 답글을 끄면 CANCELLED(남은 대상은 EXCLUDED). 끄는 순간 모으던 중이었으면 뒤늦게 들어온
//   대상이 남으므로, 보내기 전 배치마다 스위치를 다시 보고 꺼져 있으면 빼고 멈춘다.
//
// 작업 단위 오류: 토큰 만료·연결 해제 → FAILED(재연결 후 "다시 시도"),
//   호출 한도 → 1시간 뒤, 인스타 활동 제한(368) → 24시간 뒤, 그 외 → 15분 뒤 (3번까지).
// 댓글 단위 오류: 댓글이 지워짐 → 그 건만 SKIPPED, 그 외 → 그 건만 FAILED.
// ─────────────────────────────────────────────────────────────────────────────

type Service = ReturnType<typeof createServiceClient>;
type TaskRow = Database["public"]["Tables"]["episode_alert_tasks"]["Row"];

// 답글 사이 간격. 짧은 시간에 몰아서 달면 인스타가 스팸으로 보고 댓글 활동을 제한한다.
// Meta가 공개한 기준은 없고, 실무 관찰치는 시간당 30~60개·하루 150~200개(2026-10 조사).
// 1~2분 무작위면 평균 시간당 40개 — 관찰치 가운데에 두고, 간격도 일정하지 않게.
const SEND_INTERVAL_MIN_MS = 60_000;
const SEND_INTERVAL_MAX_MS = 120_000;
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

export type TaskOutcome =
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

    // 모을 대상이 0명이어도 발송 단계로 넘긴다 — 모으는 사이 "이전 화 댓글에도"를 켰으면
    // 발송 단계가 그걸 보고 다시 모은다. 보낼 게 없으면 거기서 바로 완료된다.
    if (task.status === "COLLECTING") {
      await collectCandidates(service, task, auth);
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
// 발송
// ─────────────────────────────────────────────────────────────────────────────

async function sendReplies(
  service: Service,
  task: TaskRow,
  auth: InstagramAccountAuth,
  deadlineAt: number,
): Promise<TaskOutcome> {
  const settings = await loadAlertSettings(service, task.social_account_id);

  const { data: series } = await service
    .from("series")
    .select("name, reply_templates")
    .eq("id", task.series_id)
    .maybeSingle();
  if (!series) throw new EpisodeAlertError("시리즈 정보를 찾을 수 없어요.");
  // 답글 문구는 시리즈별(0018). 보내는 시점의 문구를 쓴다.
  const templates = effectiveTemplates(series.reply_templates);

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
  // 이전 화 댓글까지 모았는지 — 처음 집어온 task 행 기준. 보내는 사이 켜지면 아래에서 모은다.
  let collectedOlder = task.include_older;

  for (;;) {
    // 배치마다 지금 상태를 다시 본다(처음 집어온 task 행은 낡았을 수 있다).
    //   · 답글을 껐으면 남은 대상을 빼고 멈춘다 — 끄는 순간 모으던 중이라 끄기가 미처 못 뺀 대상까지
    //   · "이전 화 댓글에도"를 켰으면(다시 모으기) 그 자리에서 이전 화 댓글을 모아 이어서 보낸다
    //   · 이전 화를 껐거나 다음 화가 올라왔으면 이전 화 쪽 남은 대상을 뺀다
    //   · 뒤 회차의 "이전 화에도" 작업이 맡은 댓글은 그쪽 소식으로 대신한다(scope.ts)
    const current = await loadLiveTask(service, task);
    if (!current) {
      await stopTurnedOff(service, task.id);
      console.log(`[episode-alerts] ${task.id} 답글이 꺼져 멈춤 — 이번 run 보냄 ${sentThisRun}개`);
      return "done";
    }
    if (current.status !== "SENDING" && current.status !== "COLLECTING") {
      // 다른 곳에서 끝낸 작업 — 잠금만 풀고 손 뗀다.
      await releaseTask(service, task.id);
      return "done";
    }
    if (current.status === "COLLECTING" || (current.include_older && !collectedOlder)) {
      await collectCandidates(service, current, auth);
      collectedOlder = current.include_older;
      await service
        .from("episode_alert_tasks")
        .update({ status: "SENDING" })
        .eq("id", task.id)
        .eq("status", "COLLECTING");
    }
    const scope = await loadTaskScope(service, current);
    await excludeInactiveOlder(service, current, scope);
    const newerTasks = await loadNewerExpandedTasks(service, current, scope);

    if (Date.now() + SEND_INTERVAL_MAX_MS + 5_000 > deadlineAt) {
      await updateTask(service, task.id, { locked_at: null, scheduled_for: nowIso() });
      console.log(`[episode-alerts] ${task.id} 시간 예산 소진 — 보냄 ${sentThisRun}개, 다음 run이 이어서`);
      return "continue";
    }

    // 최근 화 댓글부터, 같은 화 안에서는 최근 댓글부터 — 하루 상한에 걸려도 최근 독자가 먼저 받는다.
    const { data: batch, error } = await service
      .from("episode_alert_replies")
      .select("id, ig_comment_id, commenter_username, series_episodes(episode_no)")
      .eq("task_id", task.id)
      .eq("status", "PENDING")
      .order("series_episodes(episode_no)", { ascending: false, nullsFirst: false })
      .order("commented_at", { ascending: false, nullsFirst: false })
      .limit(SEND_BATCH);
    if (error) throw new Error(`답글 대상 조회 실패: ${error.message}`);
    if (!batch || batch.length === 0) {
      // 그 사이 상태가 바뀌었으면(이전 화 다시 모으기·끔) 완료로 덮지 않고 위에서 다시 본다.
      const { data: finished, error: finishError } = await service
        .from("episode_alert_tasks")
        .update({ status: "DONE", completed_at: nowIso(), locked_at: null, last_error: null })
        .eq("id", task.id)
        .eq("status", "SENDING")
        .select("id")
        .maybeSingle();
      if (finishError) throw new Error(`작업 완료 처리 실패: ${finishError.message}`);
      if (!finished) continue;
      console.log(`[episode-alerts] ${task.id} 완료 — 이번 run 보냄 ${sentThisRun}개`);
      return "done";
    }
    // 보낼 게 있을 때만 하루 상한을 본다 — 남은 게 없으면 위에서 바로 완료.
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

      const newerNo = await claimedByNewer(service, newerTasks, row.ig_comment_id);
      if (newerNo !== null) {
        await updateReply(service, row.id, {
          status: "SKIPPED",
          skip_reason: `${newerNo}화 답글로 대신해요`,
        });
        continue;
      }

      const text = renderTemplate(pickTemplate(templates, rotation), {
        username: row.commenter_username ?? "",
        series: series.name,
        episode: scope.target.episode_no,
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

// 지금 작업 행. 답글을 껐으면(회차 스위치 꺼짐·작업 꺼짐·회차 빠짐) null.
async function loadLiveTask(service: Service, task: TaskRow): Promise<TaskRow | null> {
  const [taskResult, episodeResult] = await Promise.all([
    service.from("episode_alert_tasks").select("*").eq("id", task.id).maybeSingle(),
    service
      .from("series_episodes")
      .select("reply_enabled")
      .eq("id", task.target_episode_id)
      .maybeSingle(),
  ]);
  // 조회 실패를 "꺼짐"으로 착각해 작업을 꺼버리지 않게 — 일반 오류로 다음에 다시 시도한다.
  const failed = taskResult.error ?? episodeResult.error;
  if (failed) throw new Error(`작업 상태 확인 실패: ${failed.message}`);
  const current = taskResult.data;
  const episode = episodeResult.data;
  if (!current || current.status === "CANCELLED" || !episode?.reply_enabled) return null;
  return current;
}

// 답글이 꺼진 작업 정리 — 끄기(disableEpisodeReplies)와 같은 모양으로 남겨 다시 켜면 되살아나게.
async function stopTurnedOff(service: Service, taskId: string) {
  await service
    .from("episode_alert_replies")
    .update({ status: "EXCLUDED", skip_reason: REPLY_OFF_REASON })
    .eq("task_id", taskId)
    .eq("status", "PENDING");
  // 새 댓글 확인 중에 꺼서 확인 쪽이 SENDING으로 되돌린 경우도 꺼짐으로 맞춘다.
  await service
    .from("episode_alert_tasks")
    .update({ status: "CANCELLED", completed_at: nowIso(), locked_at: null })
    .eq("id", taskId)
    .in("status", ["COLLECTING", "SENDING"]);
}

// 뒤 회차의 "이전 화에도" 작업이 이 댓글을 맡았으면(보낼 예정이거나 보냄) 그 회차 번호.
// 같은 댓글에는 최신화 소식 하나만 — 두 작업이 동시에 모았을 때를 보내기 직전에 막는다.
async function claimedByNewer(
  service: Service,
  newerTasks: NewerTask[],
  igCommentId: string,
): Promise<number | null> {
  if (newerTasks.length === 0) return null;
  const { data } = await service
    .from("episode_alert_replies")
    .select("task_id")
    .in("task_id", newerTasks.map((t) => t.id))
    .eq("ig_comment_id", igCommentId)
    .in("status", ["PENDING", "SENT"])
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return newerTasks.find((t) => t.id === data.task_id)?.episodeNo ?? null;
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

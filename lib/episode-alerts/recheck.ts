import type { createServiceClient } from "@/lib/supabase/service";
import { getInstagramMedia, InstagramApiError } from "@/lib/platforms/instagram-comments";
import { collectCandidates } from "./collect";
import { loadTaskScope } from "./scope";
import { getInstagramAuth } from "./server";

// 시리즈 댓글 자동화 — 답글이 켜져 있는 동안 대상 회차의 새 댓글 찾기(0020).
// 대상 회차는 보통 직전 화, "이전 화 댓글에도 보내기"면 1~(N-1)화 전체(0023, scope.ts).
// Supabase pg_cron이 5분마다 /api/cron/episode-replies를 부르면 이 함수가 돈다.
//
//   · 다 보낸(DONE) 작업 중 지켜보기 기한(watch_until)이 남은 것을 골라
//   · 대상 게시물 댓글 수(합)가 지난번과 달라졌을 때만 댓글을 다시 모으고(새 사람만 더해짐)
//   · 보낼 사람이 생기면 SENDING으로 돌려 GitHub 답글 워커를 깨우게 한다.
//   · 덤으로, 보내야 하는데 워커가 몇 분째 안 집어간 작업이 있어도 워커를 깨운다
//     (하루 상한으로 미뤄둔 발송이 다시 열린 경우 등 — 예전엔 발행 run을 기다렸다).

type Service = ReturnType<typeof createServiceClient>;

// pg_cron 주기(5분)보다 조금 짧게 — 같은 작업을 한 주기에 두 번 보지 않게.
const RECHECK_MIN_INTERVAL_MS = 4 * 60_000;
// 한 번에 확인할 작업 수. 남은 건 다음 주기에(오래 안 본 것부터).
const RECHECK_BATCH = 20;
// 워커가 이만큼 지나도 안 집어간 발송은 깨워야 할 대상으로 본다.
const OVERDUE_MS = 3 * 60_000;

export interface RecheckResult {
  checked: number;
  newTargets: number;
  overdue: number;
  // GitHub 답글 워커를 깨워야 하는지.
  dispatch: boolean;
}

export async function recheckWatchedTasks(
  service: Service,
  deadlineAt: number,
): Promise<RecheckResult> {
  const now = new Date();
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - RECHECK_MIN_INTERVAL_MS).toISOString();
  const recentlyChecked = `last_checked_at.is.null,last_checked_at.lt.${cutoff}`;

  const [{ data: watched }, { count: overdue }] = await Promise.all([
    service
      .from("episode_alert_tasks")
      .select("*")
      .eq("status", "DONE")
      .gt("watch_until", nowIso)
      .or(recentlyChecked)
      .order("last_checked_at", { ascending: true, nullsFirst: true })
      .limit(RECHECK_BATCH),
    service
      .from("episode_alert_tasks")
      .select("id", { count: "exact", head: true })
      .in("status", ["COLLECTING", "SENDING"])
      .lte("scheduled_for", new Date(now.getTime() - OVERDUE_MS).toISOString())
      .is("locked_at", null),
  ]);

  let checked = 0;
  let newTargets = 0;

  for (const task of watched ?? []) {
    if (Date.now() > deadlineAt) break;

    // 선점 — 겹쳐 돈 다른 호출이 이미 봤으면 건너뛴다.
    const { data: claimed } = await service
      .from("episode_alert_tasks")
      .update({ last_checked_at: nowIso })
      .eq("id", task.id)
      .eq("status", "DONE")
      .or(recentlyChecked)
      .select("id")
      .maybeSingle();
    if (!claimed) continue;
    checked++;

    try {
      const auth = await getInstagramAuth(service, task.social_account_id);
      const scope = await loadTaskScope(service, task);

      // 댓글 수가 그대로면 전체를 다시 읽지 않는다(게시물마다 인스타 호출 1번으로 끝).
      // "같음"으로 비교한다 — 다음 화가 올라와 대상 회차가 줄면 합도 달라져 한 번 다시 모은다.
      const medias = await Promise.all(
        scope.sources.map((s) => getInstagramMedia(s.ig_media_id, auth.token)),
      );
      const count = medias.some((m) => m.commentsCount === null)
        ? null
        : medias.reduce((sum, m) => sum + (m.commentsCount ?? 0), 0);
      if (count !== null && task.last_comment_count !== null && count === task.last_comment_count) {
        continue;
      }

      const pending = await collectCandidates(service, task, auth);
      await service
        .from("episode_alert_tasks")
        .update({ last_comment_count: count })
        .eq("id", task.id);

      if (pending > 0) {
        const { data: reopened } = await service
          .from("episode_alert_tasks")
          .update({
            status: "SENDING",
            scheduled_for: new Date().toISOString(),
            completed_at: null,
            last_error: null,
          })
          .eq("id", task.id)
          .eq("status", "DONE")
          .select("id")
          .maybeSingle();
        if (reopened) newTargets += pending;
      }
    } catch (err) {
      // 한 작업의 실패가 다른 작업 확인을 막지 않게 기록만 남긴다. 토큰 만료는 계정을 다시
      // 연결할 때까지 매번 실패하지만, 인스타 호출 1~2번이라 부담은 없다.
      const message =
        err instanceof InstagramApiError && err.kind === "TOKEN"
          ? "계정 토큰이 만료돼 새 댓글을 확인하지 못했어요. 계정을 다시 연결해주세요."
          : `새 댓글 확인 실패: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[episode-replies-recheck] ${task.id}:`, message);
      await service
        .from("episode_alert_tasks")
        .update({ last_error: message.slice(0, 500) })
        .eq("id", task.id);
    }
  }

  return {
    checked,
    newTargets,
    overdue: overdue ?? 0,
    dispatch: newTargets > 0 || (overdue ?? 0) > 0,
  };
}

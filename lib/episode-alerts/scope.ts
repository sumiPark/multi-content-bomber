// server-only는 쓰지 않는다 — 워커(tsx + plain Node)에서도 import한다.
import type { createServiceClient } from "@/lib/supabase/service";
import type { Database } from "@/types/database";
import { EpisodeAlertError } from "./server";

// 시리즈 댓글 자동화 — 답글 작업이 어느 회차 댓글을 대상으로 하는지(0023).
//   · 기본: 직전 화(source_episode_id) 하나 — "다음 화 올라왔어요"
//   · 이전 화 댓글에도 보내기(include_older): 이 회차가 최신화인 동안 1~(N-1)화 전체.
//     다음 화가 올라오면 "N화 올라왔어요"는 철 지난 소식이라 이전 화 쪽은 멈추고 직전 화만 남는다.
// 같은 댓글에는 최신화 소식 하나 — 뒤 회차의 "이전 화에도" 작업이 맡은 댓글은 앞 회차 작업이 건너뛴다.

type Service = ReturnType<typeof createServiceClient>;
type TaskRow = Database["public"]["Tables"]["episode_alert_tasks"]["Row"];

const PAGE = 1000;

export interface ScopeEpisode {
  id: string;
  episode_no: number;
  ig_media_id: string;
  posted_at: string | null;
  created_at: string;
}

export interface TaskScope {
  target: ScopeEpisode;
  // 댓글을 모을 회차 — 최신 화부터. 같은 사람은 가장 최근 화에 단 댓글에 답글을 단다.
  sources: ScopeEpisode[];
  // 이전 회차까지 넓힌 상태가 지금 유효한지 (include_older이고 이 회차가 최신화).
  olderActive: boolean;
  // 이 회차 뒤에 올라온 최신화 번호. 이 회차가 최신화면 null.
  newerEpisodeNo: number | null;
  episodeNoById: Map<string, number>;
}

export async function loadTaskScope(service: Service, task: TaskRow): Promise<TaskScope> {
  const { data, error } = await service
    .from("series_episodes")
    .select("id, episode_no, ig_media_id, posted_at, created_at")
    .eq("series_id", task.series_id)
    .order("episode_no", { ascending: false });
  if (error) throw new Error(`회차 조회 실패: ${error.message}`);

  const episodes = data ?? [];
  const target = episodes.find((e) => e.id === task.target_episode_id);
  const source = episodes.find((e) => e.id === task.source_episode_id);
  if (!target || !source) throw new EpisodeAlertError("회차 정보를 찾을 수 없어요.");

  const latest = episodes[0];
  const isLatest = latest.id === target.id;
  const olderActive = task.include_older && isLatest;
  return {
    target,
    sources: olderActive ? episodes.filter((e) => e.episode_no < target.episode_no) : [source],
    olderActive,
    newerEpisodeNo: isLatest ? null : latest.episode_no,
    episodeNoById: new Map(episodes.map((e) => [e.id, e.episode_no])),
  };
}

// "이전 화에도" 작업인데 다음 화가 올라왔으면, 이전 화 댓글에 남은 답글은 보내지 않는다.
export async function excludeOutdatedOlder(service: Service, task: TaskRow, scope: TaskScope) {
  if (!task.include_older || scope.newerEpisodeNo === null) return;
  await service
    .from("episode_alert_replies")
    .update({ status: "EXCLUDED", skip_reason: `${scope.newerEpisodeNo}화가 올라와 멈췄어요` })
    .eq("task_id", task.id)
    .eq("status", "PENDING")
    .neq("source_episode_id", task.source_episode_id);
}

export interface NewerTask {
  id: string;
  episodeNo: number;
}

// 이 작업보다 뒤 회차의 "이전 화에도" 작업들. 앞 회차 작업과 같은 댓글을 맡을 수 있다.
export async function loadNewerExpandedTasks(
  service: Service,
  task: TaskRow,
  scope: TaskScope,
): Promise<NewerTask[]> {
  const { data, error } = await service
    .from("episode_alert_tasks")
    .select("id, target_episode_id")
    .eq("series_id", task.series_id)
    .eq("include_older", true)
    .neq("id", task.id);
  if (error) throw new Error(`답글 작업 조회 실패: ${error.message}`);
  return (data ?? [])
    .map((t) => ({ id: t.id, episodeNo: scope.episodeNoById.get(t.target_episode_id) ?? 0 }))
    .filter((t) => t.episodeNo > scope.target.episode_no);
}

// 뒤 회차 작업이 맡은(보낼 예정이거나 보낸) 댓글 → 그 회차 번호.
export async function loadCommentsClaimedBy(
  service: Service,
  tasks: NewerTask[],
): Promise<Map<string, number>> {
  const claimed = new Map<string, number>();
  if (tasks.length === 0) return claimed;
  const episodeNoByTask = new Map(tasks.map((t) => [t.id, t.episodeNo]));
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await service
      .from("episode_alert_replies")
      .select("ig_comment_id, task_id")
      .in("task_id", tasks.map((t) => t.id))
      .in("status", ["PENDING", "SENT"])
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`답글 대상 조회 실패: ${error.message}`);
    for (const r of data ?? []) {
      const no = episodeNoByTask.get(r.task_id) ?? 0;
      if (no > (claimed.get(r.ig_comment_id) ?? 0)) claimed.set(r.ig_comment_id, no);
    }
    if (!data || data.length < PAGE) break;
  }
  return claimed;
}

// 이 시리즈에서 우리가 자동으로 보낸 답글 id. "손으로 단 답글" 판정에서 뺀다 — 3화 댓글에 단
// "4화 올라왔어요"를 5화 소식으로 착각해 5화 답글을 건너뛰지 않도록.
export async function loadAutoReplyIds(service: Service, seriesId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await service
      .from("episode_alert_replies")
      .select("reply_ig_id, episode_alert_tasks!inner(series_id)")
      .eq("episode_alert_tasks.series_id", seriesId)
      .not("reply_ig_id", "is", null)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`보낸 답글 조회 실패: ${error.message}`);
    for (const r of data ?? []) if (r.reply_ig_id) ids.add(r.reply_ig_id);
    if (!data || data.length < PAGE) break;
  }
  return ids;
}

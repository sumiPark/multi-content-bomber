"use client";

import { useState, useTransition } from "react";
import { ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import {
  getTaskRepliesAction,
  retryAlertTaskAction,
  type ReplyDetail,
} from "@/app/(dashboard)/episode-alerts/actions";
import { Button } from "@/components/ui/button";
import { RelativeTime } from "@/components/ui/relative-time";
import { cn } from "@/lib/utils";
import { REPLY_STATUS, TASK_STATUS, type TaskStatus } from "./labels";

export interface TaskStats {
  total: number;
  pending: number;
  sent: number;
  skipped: number;
  excluded: number;
  failed: number;
  // 그중 이전 회차 댓글에 보낸 수 (이전 화 댓글에도 보내기, 0023).
  sentOlder: number;
}

export interface TaskView {
  id: string;
  seriesName: string;
  seriesDeleted: boolean;
  sourceEpisodeNo: number | null;
  targetEpisodeNo: number | null;
  targetEpisodeId: string;
  status: TaskStatus;
  // 최신화 소식을 이전 회차 댓글에도 보냈는지(0023). 대상은 1~sourceEpisodeNo화.
  includeOlder: boolean;
  // 업로드하면서 답글을 켜고 올린 작업인지 (화면에서 스위치로 켠 게 아니라).
  auto: boolean;
  scheduledFor: string;
  // 하루 상한·호출 한도로 다음 발송이 미래로 미뤄진 상태인지 (서버에서 계산).
  deferred: boolean;
  // 답글이 켜져 있어 직전 화 새 댓글을 지켜보는 중인지 (켠 뒤 7일, 0020).
  watching: boolean;
  // 7일 지켜보기가 끝났는지 — 다 보낸 회차는 이때 답글이 자동으로 꺼진다(0021).
  watchExpired: boolean;
  lastError: string | null;
  createdAt: string;
  completedAt: string | null;
  stats: TaskStats;
}

// 답글 대상 회차 — "4화" 또는 이전 화에도 보냈으면 "1~4화".
export function sourceRangeText(task: Pick<TaskView, "includeOlder" | "sourceEpisodeNo">): string {
  if (task.sourceEpisodeNo === null) return "직전 화";
  return task.includeOlder && task.sourceEpisodeNo > 1
    ? `1~${task.sourceEpisodeNo}화`
    : `${task.sourceEpisodeNo}화`;
}

export function StatusPill({ status }: { status: TaskStatus }) {
  const s = TASK_STATUS[status];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        s.className,
      )}
    >
      {s.label}
    </span>
  );
}

export function AlertHistory({
  history,
  canManage,
}: {
  history: TaskView[];
  canManage: boolean;
}) {
  return (
    <section className="space-y-3" aria-labelledby="alert-history-title">
      <div>
        <h2 id="alert-history-title" className="text-base font-semibold">
          보낸 기록
        </h2>
        <p className="text-xs text-muted-foreground">최근 30건이에요.</p>
      </div>
      {history.length === 0 ? (
        <p className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          아직 보낸 답글이 없어요.
        </p>
      ) : (
        <ul className="space-y-2">
          {history.map((t) => (
            <li key={t.id}>
              <HistoryItem task={t} canManage={canManage} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function HistoryItem({ task, canManage }: { task: TaskView; canManage: boolean }) {
  const [open, setOpen] = useState(false);
  const [replies, setReplies] = useState<ReplyDetail[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const { stats } = task;
  const toSend = stats.sent + stats.pending;
  const progress = toSend > 0 ? Math.round((stats.sent / toSend) * 100) : 0;

  async function toggleDetail() {
    const next = !open;
    setOpen(next);
    if (next && replies === null) {
      setLoading(true);
      const result = await getTaskRepliesAction({ taskId: task.id });
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setReplies(result.replies);
      setTruncated(result.truncated);
    }
  }

  function retry() {
    setError(null);
    startTransition(async () => {
      const result = await retryAlertTaskAction({ taskId: task.id });
      if (!result.ok) {
        setError(result.error);
        return;
      }
    });
  }

  const counts: { label: string; value: number }[] = [
    { label: "보냄", value: stats.sent },
    { label: "그중 이전 화", value: stats.sentOlder },
    { label: "남음", value: stats.pending },
    { label: "건너뜀", value: stats.skipped },
    { label: "제외", value: stats.excluded },
    { label: "실패", value: stats.failed },
  ].filter((c, i) => i === 0 || c.value > 0);

  return (
    <div className="space-y-2 rounded-md border bg-background p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusPill status={task.status} />
        <p className="min-w-0 text-sm font-medium">
          {task.seriesName} {task.targetEpisodeNo}화
          <span className="font-normal text-muted-foreground">
            {" "}→ {sourceRangeText(task)} 댓글
          </span>
        </p>
        <span className="text-xs text-muted-foreground">
          · {task.auto ? "업로드하면서 켬" : "직접 켬"} · <RelativeTime iso={task.createdAt} />
        </span>
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs tabular-nums text-muted-foreground">
        {counts.map((c) => (
          <span key={c.label}>
            {c.label} <span className="font-medium text-foreground">{c.value.toLocaleString()}</span>
          </span>
        ))}
      </div>

      {(task.status === "SENDING" || (task.status === "DONE" && toSend > 0)) && (
        <div
          className="h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="보낸 비율"
        >
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress}%` }} />
        </div>
      )}

      {task.watching && task.status === "DONE" && (
        <p className="text-xs text-muted-foreground">
          새 댓글이 달리면 5분 안에 확인해서 이어서 보내요 (켠 뒤 7일 동안).
        </p>
      )}
      {task.watchExpired && task.status === "DONE" && (
        <p className="text-xs text-muted-foreground">
          7일이 지나 새 댓글 확인을 마치고 답글을 껐어요. 다시 켜면 그 사이 새로 댓글 단 사람에게 이어서 보내요.
        </p>
      )}
      {task.deferred && (
        <p className="text-xs text-muted-foreground">
          다음 발송: <RelativeTime iso={task.scheduledFor} />
        </p>
      )}
      {task.lastError && (
        <p
          className={cn(
            "text-xs",
            task.status === "FAILED" ? "text-destructive" : "text-amber-700 dark:text-amber-300",
          )}
        >
          {task.lastError}
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="xs" onClick={toggleDetail}>
          {open ? <ChevronUp /> : <ChevronDown />} 자세히
        </Button>
        {canManage && task.status === "FAILED" && (
          <Button variant="outline" size="xs" onClick={retry} disabled={isPending}>
            다시 시도
          </Button>
        )}
      </div>

      {open && (
        <div className="rounded-md border">
          {loading && (
            <p className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> 불러오는 중…
            </p>
          )}
          {replies && replies.length === 0 && (
            <p className="px-3 py-4 text-sm text-muted-foreground">아직 대상이 없어요.</p>
          )}
          {replies && replies.length > 0 && (
            <ul className="max-h-80 divide-y overflow-y-auto">
              {replies.map((r) => (
                <li key={r.id} className="space-y-0.5 px-3 py-2">
                  <p className="flex items-baseline gap-2 text-sm">
                    <span className={cn("shrink-0 text-xs font-medium", REPLY_STATUS[r.status].className)}>
                      {REPLY_STATUS[r.status].label}
                    </span>
                    <span className="truncate font-medium">@{r.username ?? "알 수 없음"}</span>
                    {r.sentAt && (
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        <RelativeTime iso={r.sentAt} />
                      </span>
                    )}
                  </p>
                  {r.commentText && (
                    <p className="line-clamp-1 text-xs text-muted-foreground">
                      {task.includeOlder && r.sourceEpisodeNo ? `${r.sourceEpisodeNo}화 댓글` : "댓글"}:{" "}
                      {r.commentText}
                    </p>
                  )}
                  {r.replyText && <p className="line-clamp-2 text-xs">답글: {r.replyText}</p>}
                  {r.reason && r.status !== "SENT" && (
                    <p className="text-xs text-muted-foreground">이유: {r.reason}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
          {truncated && (
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">최근 1,000건만 보여줘요.</p>
          )}
        </div>
      )}
    </div>
  );
}

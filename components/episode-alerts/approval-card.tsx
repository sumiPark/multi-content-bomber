"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import {
  approveAlertTaskAction,
  cancelAlertTaskAction,
} from "@/app/(dashboard)/episode-alerts/actions";
import { Button } from "@/components/ui/button";
import { RelativeTime } from "@/components/ui/relative-time";
import { pickTemplate, renderTemplate } from "@/lib/episode-alerts/templates";
import type { TaskView } from "./alert-history";

export interface CandidateView {
  id: string;
  username: string | null;
  text: string | null;
  commentedAt: string | null;
}

export interface ApprovalView {
  task: TaskView;
  // 이 작업 시리즈의 답글 문구 (미리보기용).
  templates: string[];
  candidates: CandidateView[];
}

export function ApprovalCard({
  approval,
  dailyLimit,
  canManage,
}: {
  approval: ApprovalView;
  dailyLimit: number;
  canManage: boolean;
}) {
  const router = useRouter();
  const { task, candidates, templates } = approval;
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(
      (c) =>
        (c.username ?? "").toLowerCase().includes(q) ||
        (c.text ?? "").toLowerCase().includes(q),
    );
  }, [candidates, query]);

  const count = candidates.length - excluded.size;
  const allVisibleOn = visible.length > 0 && visible.every((c) => !excluded.has(c.id));
  const firstIncluded = candidates.find((c) => !excluded.has(c.id));
  const preview = firstIncluded
    ? renderTemplate(pickTemplate(templates, 0), {
        username: firstIncluded.username ?? "",
        series: task.seriesName,
        episode: task.targetEpisodeNo ?? "",
      })
    : null;
  const days = Math.ceil(count / dailyLimit);

  function toggle(id: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleVisible() {
    setExcluded((prev) => {
      const next = new Set(prev);
      for (const c of visible) {
        if (allVisibleOn) next.add(c.id);
        else next.delete(c.id);
      }
      return next;
    });
  }

  function send() {
    setError(null);
    startTransition(async () => {
      const result = await approveAlertTaskAction({
        taskId: task.id,
        excludeReplyIds: Array.from(excluded),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function skip() {
    if (!window.confirm("이번 회차는 답글을 보내지 않을까요? 대상 목록은 기록에 남아요.")) return;
    setError(null);
    startTransition(async () => {
      const result = await cancelAlertTaskAction({ taskId: task.id });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <section
      aria-label="확인 대기"
      className="space-y-4 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4"
    >
      <div className="space-y-1">
        <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">확인 대기</p>
        <h2 className="text-lg font-semibold">
          {task.seriesName} {task.targetEpisodeNo}화가 올라갔어요
        </h2>
        <p className="text-sm text-muted-foreground">
          {task.sourceEpisodeNo}화에 댓글 단 {candidates.length.toLocaleString()}명에게 보낼 준비가
          됐어요. 빼고 싶은 사람은 체크를 풀어주세요.
        </p>
      </div>

      {preview && (
        <div className="rounded-md border bg-background px-3 py-2 text-sm">
          <span className="mr-2 text-xs text-muted-foreground">이렇게 달려요</span>
          {preview}
          <span className="mt-1 block text-[11px] text-muted-foreground">
            “{task.seriesName}” 시리즈 문구 {templates.length}개를 돌려가며 써요. 문구는 시리즈 카드에서 바꿀 수 있어요.
          </span>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              id={`approval-search-${task.id}`}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="아이디나 댓글 내용으로 찾기"
              className="w-full rounded-md border bg-background py-1.5 pl-8 pr-2.5 text-sm"
            />
          </div>
          <Button variant="outline" size="sm" onClick={toggleVisible} disabled={!canManage || visible.length === 0}>
            {allVisibleOn ? "보이는 사람 모두 빼기" : "보이는 사람 모두 넣기"}
          </Button>
        </div>

        <ul className="max-h-80 divide-y overflow-y-auto rounded-md border bg-background">
          {visible.map((c) => {
            const on = !excluded.has(c.id);
            return (
              <li key={c.id}>
                <label className="flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-accent/30">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!canManage}
                    onChange={() => toggle(c.id)}
                    className="mt-0.5 size-4 shrink-0"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-medium">@{c.username}</span>
                      {c.commentedAt && (
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          <RelativeTime iso={c.commentedAt} />
                        </span>
                      )}
                    </span>
                    <span className="line-clamp-2 text-xs text-muted-foreground">{c.text}</span>
                  </span>
                </label>
              </li>
            );
          })}
          {visible.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">찾는 사람이 없어요.</li>
          )}
        </ul>
      </div>

      <div className="space-y-1 text-xs text-muted-foreground">
        <p>스팸으로 보이지 않게 10~20초 간격으로 하나씩 달아요.</p>
        {count > dailyLimit && (
          <p>
            하루 최대 {dailyLimit}개씩 보내서 {days}일에 걸쳐 나눠 보내요. (설정에서 바꿀 수 있어요)
          </p>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {canManage ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={skip} disabled={isPending}>
            이번엔 안 보내기
          </Button>
          <Button onClick={send} disabled={isPending}>
            {isPending
              ? "처리 중…"
              : count > 0
                ? `${count.toLocaleString()}명에게 보내기`
                : "아무에게도 보내지 않고 끝내기"}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">보내기는 관리자(ADMIN/MANAGER)만 할 수 있어요.</p>
      )}
    </section>
  );
}

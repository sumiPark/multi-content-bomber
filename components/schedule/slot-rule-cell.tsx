"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { deleteSlotAction, removalImpactAction, updateSlotRuleAction, type ScheduleResult } from "@/app/(dashboard)/schedule/actions";
import { ConfirmDialog } from "@/components/schedule/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// 편성표 칸 하나 — 시각 · 방식 · 주제 고치기, 켜기/끄기, 지우기(앞으로의 기획 · 예약이 있으면 경고 뒤 취소).

export interface SlotRuleCellData {
  id: string;
  time: string;
  track: string;
  topic: string | null;
  active: boolean;
}

export function TrackBadge({ track }: { track: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-full px-2 text-xs font-semibold",
        track === "B" ? "bg-lv-ai-soft text-lv-ai" : "bg-lv-shoot-soft text-lv-shoot",
      )}
    >
      {track === "B" ? "AI 자동" : "직접 촬영"}
    </span>
  );
}

export function useScheduleRun() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const run = (fn: () => Promise<ScheduleResult>, after?: () => void) =>
    startTransition(async () => {
      setError(null);
      setMessage(null);
      const r = await fn();
      if (r.ok) {
        if (r.message) setMessage(r.message);
        after?.();
        router.refresh();
      } else setError(r.error);
    });
  return { isPending, error, message, run, setError };
}

const selectClass = "h-8 rounded-md border border-input bg-card px-2 text-[13px] focus-visible:outline-2 focus-visible:outline-primary";

export function SlotRuleCell({ rule, canManage }: { rule: SlotRuleCellData; canManage: boolean }) {
  const { isPending, error, message, run } = useScheduleRun();
  const [editing, setEditing] = useState(false);
  const [time, setTime] = useState(rule.time);
  const [track, setTrack] = useState(rule.track);
  const [topic, setTopic] = useState(rule.topic ?? "");
  const [confirm, setConfirm] = useState<{ plans: number; scheduled: number } | null>(null);
  const [checking, startChecking] = useTransition();

  const reset = () => {
    setTime(rule.time);
    setTrack(rule.track);
    setTopic(rule.topic ?? "");
    setEditing(false);
  };

  const askDelete = () =>
    startChecking(async () => {
      const r = await removalImpactAction({ ruleId: rule.id });
      setConfirm(r.ok ? { plans: r.plans, scheduled: r.scheduled } : { plans: 0, scheduled: 0 });
    });

  return (
    <div className={cn("space-y-2 rounded-lg border bg-card p-3", !rule.active && "bg-surface-2")}>
      {editing ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(
              () =>
                updateSlotRuleAction({
                  ruleId: rule.id,
                  topic: topic.trim() || null,
                  ...(time !== rule.time ? { time } : {}),
                  ...(track !== rule.track ? { track: track as "A" | "B" } : {}),
                }),
              () => setEditing(false),
            );
          }}
        >
          <div className="flex flex-wrap gap-1.5">
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="올릴 시각" className={cn(selectClass, "tabular-nums")} required />
            <select value={track} onChange={(e) => setTrack(e.target.value)} aria-label="방식" className={selectClass}>
              <option value="B">AI 자동</option>
              <option value="A">직접 촬영</option>
            </select>
          </div>
          <Input value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={60} placeholder="칸 주제 (예: 성분 비교)" aria-label="칸 주제" className="h-8" />
          {(time !== rule.time || track !== rule.track) && (
            <p className="text-xs text-muted-foreground">
              {time !== rule.time && "앞으로의 기획도 새 시각으로 옮겨요(예약된 발행은 예약 시각도). "}
              {track !== rule.track && "이미 기획이 있는 날은 예전 방식 그대로예요."}
            </p>
          )}
          <div className="flex gap-1.5">
            <Button type="submit" size="sm" disabled={isPending}>
              저장
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={isPending} onClick={reset}>
              취소
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <b className="text-[15px] tabular-nums">{rule.time}</b>
              <TrackBadge track={rule.track} />
            </span>
            {canManage ? (
              <button
                type="button"
                role="switch"
                aria-checked={rule.active}
                aria-label={rule.active ? `${rule.time} 칸 끄기` : `${rule.time} 칸 켜기`}
                disabled={isPending}
                onClick={() => run(() => updateSlotRuleAction({ ruleId: rule.id, active: !rule.active }))}
                className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50", rule.active ? "bg-primary" : "bg-surface-3")}
              >
                <span className={cn("absolute top-0.5 size-4 rounded-full bg-card shadow-sm transition-[left]", rule.active ? "left-[18px]" : "left-0.5")} />
              </button>
            ) : (
              <span className="text-xs text-muted-foreground">{rule.active ? "켜짐" : "꺼짐"}</span>
            )}
          </div>
          <div className="flex items-start justify-between gap-1">
            <p className={cn("min-w-0 text-[13px]", rule.topic ? "text-foreground" : "text-faint")}>{rule.topic ?? "주제 없음"}</p>
            {canManage && (
              <span className="flex shrink-0">
                <Button size="icon" variant="ghost" className="size-7" aria-label={`${rule.time} 칸 고치기`}
                  onClick={() => {
                    reset();
                    setEditing(true);
                  }}
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-risk" aria-label={`${rule.time} 칸 지우기`} disabled={checking || isPending} onClick={askDelete}>
                  <Trash2 className="size-3.5" />
                </Button>
              </span>
            )}
          </div>
          {!rule.active && <p className="text-xs text-muted-foreground">꺼짐 — 기획하지 않아요</p>}
        </>
      )}
      {message && <p className="text-xs text-ok">{message}</p>}
      {error && <p className="text-xs text-risk">{error}</p>}

      <ConfirmDialog
        open={confirm !== null}
        title={`${rule.time} 칸을 지울까요?`}
        danger={(confirm?.plans ?? 0) > 0}
        confirmLabel={confirm && confirm.plans > 0 ? "그래도 지우고 모두 취소" : "지우기"}
        pending={isPending}
        onClose={() => setConfirm(null)}
        onConfirm={() => run(() => deleteSlotAction({ ruleId: rule.id }), () => setConfirm(null))}
      >
        {confirm && confirm.scheduled > 0 && (
          <p className="rounded-md bg-risk-soft px-3 py-2 font-semibold text-risk">예약된 발행이 {confirm.scheduled}건 있어요. 지우면 예약이 취소돼 올라가지 않아요.</p>
        )}
        {confirm && confirm.plans > 0 ? (
          <p>이 칸의 앞으로 기획 {confirm.plans}개를 모두 취소해요. 지난 기록은 남아요.</p>
        ) : (
          <p>앞으로 만들어 둔 기획은 없어요. 다음 기획부터 이 칸을 채우지 않아요.</p>
        )}
      </ConfirmDialog>
    </div>
  );
}

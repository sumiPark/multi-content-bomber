"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Pencil } from "lucide-react";
import { updateSlotRuleAction } from "@/app/(dashboard)/schedule/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// 편성표 칸 설정 한 칸 — 주제 고치기 · 켜기/끄기. 방식 · 시각은 보여 주기만 한다.

export interface SlotRuleCellData {
  id: string;
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

export function SlotRuleCell({ rule, canManage }: { rule: SlotRuleCellData; canManage: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [topic, setTopic] = useState(rule.topic ?? "");
  const [error, setError] = useState<string | null>(null);

  const save = (patch: { topic?: string | null; active?: boolean }, after?: () => void) =>
    startTransition(async () => {
      setError(null);
      const r = await updateSlotRuleAction({ ruleId: rule.id, ...patch });
      if (r.ok) {
        after?.();
        router.refresh();
      } else setError(r.error);
    });

  return (
    <div className={cn("space-y-2", !rule.active && "opacity-60")}>
      <div className="flex items-center justify-between gap-2">
        <TrackBadge track={rule.track} />
        {canManage ? (
          <button
            type="button"
            role="switch"
            aria-checked={rule.active}
            aria-label={rule.active ? "이 칸 끄기" : "이 칸 켜기"}
            disabled={isPending}
            onClick={() => save({ active: !rule.active })}
            className={cn(
              "relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50",
              rule.active ? "bg-primary" : "bg-surface-3",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 size-4 rounded-full bg-card shadow-sm transition-[left]",
                rule.active ? "left-[18px]" : "left-0.5",
              )}
            />
          </button>
        ) : (
          <span className="text-xs text-muted-foreground">{rule.active ? "켜짐" : "꺼짐"}</span>
        )}
      </div>

      {editing ? (
        <form
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            save({ topic: topic.trim() || null }, () => setEditing(false));
          }}
        >
          <Input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            maxLength={60}
            placeholder="예: 성분 비교"
            aria-label="칸 주제"
            autoFocus
            className="h-8"
          />
          <div className="flex gap-1.5">
            <Button type="submit" size="sm" disabled={isPending}>
              저장
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={isPending}
              onClick={() => {
                setTopic(rule.topic ?? "");
                setEditing(false);
                setError(null);
              }}
            >
              취소
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex items-start justify-between gap-1">
          <p className={cn("min-w-0 text-[13px]", rule.topic ? "text-foreground" : "text-faint")}>{rule.topic ?? "주제 없음"}</p>
          {canManage && (
            <Button size="icon" variant="ghost" className="size-7 shrink-0" aria-label="주제 고치기" onClick={() => setEditing(true)}>
              <Pencil className="size-3.5" />
            </Button>
          )}
        </div>
      )}
      {error && <p className="text-xs text-risk">{error}</p>}
    </div>
  );
}

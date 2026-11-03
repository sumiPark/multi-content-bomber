"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Check, History, Pencil, RotateCcw, X } from "lucide-react";
import {
  applyFeedbackAction,
  rejectFeedbackAction,
  rollbackPlaybookAction,
  savePlaybookAction,
  setApprovalModeAction,
  type AgentsResult,
} from "@/app/(dashboard)/agents/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RelativeTime } from "@/components/ui/relative-time";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// 에이전트 · 학습 화면의 조작 — 반영 방식 스위치 · 플레이북 고치기 / 되돌리기 · 피드백 제안 반영 / 거절.

function useRun() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const run = (fn: () => Promise<AgentsResult>, message: (r: AgentsResult & { ok: true }) => string, after?: () => void) =>
    startTransition(async () => {
      setError(null);
      setDone(null);
      const r = await fn();
      if (r.ok) {
        setDone(message(r));
        after?.();
        router.refresh();
      } else setError(r.error);
    });
  return { isPending, error, done, run };
}

export function ApprovalSwitch({ agent, mode, canManage }: { agent: string; mode: "HUMAN" | "AUTO"; canManage: boolean }) {
  const { isPending, error, run } = useRun();
  const options: { value: "HUMAN" | "AUTO"; label: string }[] = [
    { value: "HUMAN", label: "사람 승인" },
    { value: "AUTO", label: "자동 승인" },
  ];
  return (
    <div className="space-y-1">
      <div role="radiogroup" aria-label="피드백 반영 방식" className="inline-flex rounded-md border bg-surface-2 p-0.5">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={mode === o.value}
            disabled={!canManage || isPending}
            onClick={() => mode !== o.value && run(() => setApprovalModeAction({ agent, mode: o.value }), () => "")}
            className={cn(
              "h-7 rounded-[6px] px-2.5 text-xs transition-colors disabled:cursor-not-allowed",
              mode === o.value ? "bg-card font-semibold text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
      {error && <p className="text-xs text-risk">{error}</p>}
    </div>
  );
}

export interface PlaybookVersion {
  version: number;
  body: string;
  note: string | null;
  sourceLabel: string;
  who: string | null;
  createdAt: string;
}

export function PlaybookEditor({
  agent,
  current,
  history,
  canManage,
  usesPlaybook,
}: {
  agent: string;
  current: PlaybookVersion | null;
  history: PlaybookVersion[];
  canManage: boolean;
  usesPlaybook: boolean;
}) {
  const { isPending, error, done, run } = useRun();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(current?.body ?? "");
  const [note, setNote] = useState("");
  const changed = body.trim() !== (current?.body ?? "").trim();

  return (
    <div className="space-y-4">
      {editing ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(
              () => savePlaybookAction({ agent, body, note }),
              (r) => `v${r.version}로 저장했어요. 다음 실행부터 이 지침을 써요.`,
              () => {
                setEditing(false);
                setNote("");
              },
            );
          }}
        >
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={10}
            maxLength={4000}
            aria-label="플레이북 추가 지침"
            placeholder={"예)\n- 첫 문장은 질문형을 먼저 쓴다\n- 과일은 당도 · 산지보다 먹는 장면을 먼저 보여 준다"}
            className="font-[inherit] text-[13px] leading-relaxed"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="바꾼 이유 (선택)" aria-label="바꾼 이유" className="max-w-md" />
            <Button type="submit" size="sm" disabled={isPending || !changed}>
              새 버전으로 저장
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={isPending}
              onClick={() => {
                setBody(current?.body ?? "");
                setEditing(false);
              }}
            >
              취소
            </Button>
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">{Array.from(body).length.toLocaleString("ko-KR")} / 4,000</span>
          </div>
        </form>
      ) : (
        <div className="space-y-2">
          {current?.body.trim() ? (
            <pre className="whitespace-pre-wrap rounded-md border bg-surface-2 px-3.5 py-3 font-[inherit] text-[13px] leading-relaxed">{current.body}</pre>
          ) : (
            <p className="rounded-md border border-dashed px-3.5 py-3 text-[13px] text-muted-foreground">
              추가 지침이 없어요. 지금은 코드에 있는 기본 규칙(근거 문구만 쓰기 · 금지 표현 피하기 · 계정 역할)만으로 일해요.
            </p>
          )}
          {canManage && usesPlaybook && (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              <Pencil className="size-3.5" /> 추가 지침 고치기
            </Button>
          )}
        </div>
      )}
      {done && <p className="text-xs text-ok">{done}</p>}
      {error && <p className="text-xs text-risk">{error}</p>}

      <div>
        <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <History className="size-3.5" /> 버전 기록
        </p>
        {history.length === 0 ? (
          <p className="text-xs text-faint">아직 버전이 없어요.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {history.map((h, i) => (
              <li key={h.version} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5 text-[13px]">
                <span className="font-semibold tabular-nums">v{h.version}</span>
                {i === 0 && <span className="rounded-full bg-brand-soft px-2 py-0.5 text-xs font-semibold text-primary">지금 쓰는 것</span>}
                <span className="text-muted-foreground">
                  {h.sourceLabel}
                  {h.who ? ` · ${h.who}` : ""} · <RelativeTime iso={h.createdAt} />
                </span>
                {h.note && <span className="min-w-0 truncate text-ink-2">{h.note}</span>}
                {canManage && i > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    disabled={isPending}
                    onClick={() => {
                      if (!window.confirm(`v${h.version}의 지침으로 되돌릴까요? 새 버전으로 남아요.`)) return;
                      run(() => rollbackPlaybookAction({ agent, version: h.version }), (r) => `v${h.version} 내용으로 되돌려 v${r.version}로 저장했어요.`);
                    }}
                  >
                    <RotateCcw className="size-3.5" /> 이 버전으로 되돌리기
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export interface FeedbackData {
  id: string;
  agentName: string;
  title: string;
  proposedBody: string;
  currentBody: string;
  evidence: { summary?: string; sample?: number; baseline?: string; metric?: string };
  createdAt: string;
}

export function FeedbackCard({ fb, canManage }: { fb: FeedbackData; canManage: boolean }) {
  const { isPending, error, run } = useRun();
  const [mode, setMode] = useState<"view" | "edit" | "reject">("view");
  const [body, setBody] = useState(fb.proposedBody);
  const [reason, setReason] = useState("");

  return (
    <article className="space-y-3 rounded-lg border p-4">
      <header className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-warn-soft px-2 py-0.5 text-xs font-semibold text-warn">승인 대기</span>
        <span className="text-xs text-muted-foreground">{fb.agentName}</span>
        <h3 className="text-[15px] font-semibold">{fb.title}</h3>
        <span className="ml-auto text-xs text-muted-foreground">
          <RelativeTime iso={fb.createdAt} />
        </span>
      </header>
      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <p className="mb-1 text-xs font-semibold text-muted-foreground">지금</p>
          <pre className="min-h-16 whitespace-pre-wrap rounded-md border bg-surface-2 px-3 py-2.5 font-[inherit] text-[13px] leading-relaxed">
            {fb.currentBody.trim() || "(추가 지침 없음)"}
          </pre>
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold text-muted-foreground">바뀐 뒤</p>
          {mode === "edit" ? (
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} maxLength={4000} aria-label="반영할 지침" className="text-[13px]" />
          ) : (
            <pre className="min-h-16 whitespace-pre-wrap rounded-md border border-primary/30 bg-brand-soft px-3 py-2.5 font-[inherit] text-[13px] leading-relaxed">{fb.proposedBody}</pre>
          )}
        </div>
      </div>
      {(fb.evidence.summary || fb.evidence.sample != null) && (
        <p className="text-[13px] text-ink-2">
          근거: {fb.evidence.summary}
          {fb.evidence.sample != null && ` · 표본 ${fb.evidence.sample}개`}
          {fb.evidence.baseline && ` · ${fb.evidence.baseline}`}
        </p>
      )}
      {canManage && (
        <div className="space-y-2">
          {mode === "reject" && (
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="거절 이유 — 다음 제안에 반영돼요" aria-label="거절 이유" autoFocus />
          )}
          <div className="flex flex-wrap gap-2">
            {mode === "view" && (
              <>
                <Button size="sm" disabled={isPending} onClick={() => run(() => applyFeedbackAction({ feedbackId: fb.id }), (r) => `v${r.version}로 반영했어요`)}>
                  <Check className="size-3.5" /> 반영
                </Button>
                <Button size="sm" variant="outline" disabled={isPending} onClick={() => setMode("edit")}>
                  <Pencil className="size-3.5" /> 고쳐서 반영
                </Button>
                <Button size="sm" variant="ghost" disabled={isPending} onClick={() => setMode("reject")}>
                  <X className="size-3.5" /> 거절
                </Button>
              </>
            )}
            {mode === "edit" && (
              <>
                <Button size="sm" disabled={isPending || !body.trim()} onClick={() => run(() => applyFeedbackAction({ feedbackId: fb.id, body }), (r) => `v${r.version}로 반영했어요`)}>
                  고친 내용으로 반영
                </Button>
                <Button size="sm" variant="ghost" disabled={isPending} onClick={() => setMode("view")}>
                  취소
                </Button>
              </>
            )}
            {mode === "reject" && (
              <>
                <Button size="sm" variant="destructive" disabled={isPending} onClick={() => run(() => rejectFeedbackAction({ feedbackId: fb.id, reason }), () => "거절했어요")}>
                  거절하기
                </Button>
                <Button size="sm" variant="ghost" disabled={isPending} onClick={() => setMode("view")}>
                  취소
                </Button>
              </>
            )}
          </div>
        </div>
      )}
      {error && <p className="text-xs text-risk">{error}</p>}
    </article>
  );
}

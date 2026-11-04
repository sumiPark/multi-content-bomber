"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { addBenchmarkAction, removeBenchmarkAction } from "@/app/(dashboard)/analytics/benchmark-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";

// 다른 계정 비교 — 비교 계정 추가 · 빼기.

type Group = "SAME" | "ADJACENT" | "LARGE";

export function AddBenchmarkForm({ socialAccountId }: { socialAccountId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [username, setUsername] = useState("");
  const [group, setGroup] = useState<Group>("SAME");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = () =>
    startTransition(async () => {
      setMessage(null);
      const r = await addBenchmarkAction({ socialAccountId, username, groupType: group, reason });
      if (r.ok) {
        setUsername("");
        setReason("");
        setMessage({ ok: true, text: "추가했어요. 1~2분 뒤 새로고침하면 숫자가 보여요. 개인 계정은 조회되지 않아요." });
        router.refresh();
      } else {
        setMessage({ ok: false, text: r.error });
      }
    });

  return (
    <form
      className="space-y-3 rounded-lg border bg-card p-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="text-sm font-semibold">비교 계정 추가</p>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,260px)_auto_minmax(0,1fr)_auto] lg:items-end">
        <div className="space-y-1.5">
          <Label htmlFor={`bm-user-${socialAccountId}`}>인스타 아이디 또는 프로필 주소</Label>
          <Input id={`bm-user-${socialAccountId}`} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="@아이디" required />
        </div>
        <div className="space-y-1.5">
          <p className="text-sm font-medium">구분</p>
          <Segmented
            ariaLabel="비교 계정 구분"
            value={group}
            onChange={setGroup}
            options={[
              { value: "SAME", label: "같은 분야" },
              { value: "ADJACENT", label: "비슷한 시청자" },
              { value: "LARGE", label: "큰 계정" },
            ]}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`bm-reason-${socialAccountId}`}>왜 참고하나요? (선택)</Label>
          <Input id={`bm-reason-${socialAccountId}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="예: 후기형 릴스가 잘 나와요" />
        </div>
        <Button type="submit" disabled={isPending || !username.trim()}>
          <Plus className="size-4" aria-hidden />
          {isPending ? "추가하는 중…" : "추가"}
        </Button>
      </div>
      {message && <p className={message.ok ? "text-xs text-ok" : "text-xs text-risk"}>{message.text}</p>}
    </form>
  );
}

export function RemoveBenchmarkButton({ linkId, username }: { linkId: string; username: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!asking) {
    return (
      <Button type="button" variant="ghost" size="sm" onClick={() => setAsking(true)} aria-label={`${username} 비교 목록에서 빼기`}>
        빼기
      </Button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1">
      {error && <span className="text-xs text-risk">{error}</span>}
      <Button
        type="button"
        variant="destructive"
        size="sm"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            const r = await removeBenchmarkAction({ linkId });
            if (r.ok) router.refresh();
            else setError(r.error);
          })
        }
      >
        빼기 확인
      </Button>
      <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={() => setAsking(false)}>
        취소
      </Button>
    </span>
  );
}

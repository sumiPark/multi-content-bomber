"use client";

import { useState } from "react";
import { UserMinus, UserPlus, X } from "lucide-react";
import { disableShootAccountAction, enableShootAccountAction, updateScopesAction } from "@/app/(dashboard)/schedule/actions";
import { ScopeChecks, type ScopeOptionData } from "@/components/schedule/account-schedule";
import { useScheduleRun } from "@/components/schedule/slot-rule-cell";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

// 촬영 설정의 부품 — 기획을 만들 계정 추가 · 빼기, 쓸 상품 바꾸기. 쓸 상품은 AI 자동 업로드와 함께 쓴다.

export function ShootAddAccount({ candidates, options }: { candidates: { id: string; name: string; scopes: string[] }[]; options: ScopeOptionData[] }) {
  const { isPending, error, run, setError } = useScheduleRun();
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);

  if (!open)
    return (
      <div className="space-y-1">
        <Button variant="outline" onClick={() => setOpen(true)} disabled={candidates.length === 0}>
          <UserPlus className="size-4" /> 계정 추가
        </Button>
        {candidates.length === 0 && <p className="text-xs text-muted-foreground">연결된 인스타그램 계정을 모두 추가했어요.</p>}
      </div>
    );

  return (
    <form
      className="w-full max-w-xl space-y-4 rounded-lg border border-primary/40 bg-brand-soft/40 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!accountId) return setError("계정을 골라 주세요.");
        run(
          () => enableShootAccountAction({ accountId, scopes }),
          () => {
            setOpen(false);
            setAccountId("");
            setScopes([]);
          },
        );
      }}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-[15px] font-semibold">기획을 만들 계정 추가</h3>
        <Button type="button" size="icon" variant="ghost" className="size-8" aria-label="닫기" onClick={() => setOpen(false)}>
          <X className="size-4" />
        </Button>
      </div>
      <label className="block space-y-1.5">
        <span className="text-[13px] font-semibold">인스타그램 계정</span>
        <select
          value={accountId}
          onChange={(e) => {
            setAccountId(e.target.value);
            // AI 자동에서 쓰던 계정은 쓸 상품을 미리 채운다
            setScopes(candidates.find((c) => c.id === e.target.value)?.scopes ?? []);
          }}
          className="block h-9 w-full max-w-xs rounded-md border border-input bg-card px-2.5 text-[13px] focus-visible:outline-2 focus-visible:outline-primary"
          required
        >
          <option value="">고르기</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              @{c.name}
            </option>
          ))}
        </select>
      </label>
      <div className="space-y-1.5">
        <p className="text-[13px] font-semibold">쓸 상품</p>
        <ScopeChecks options={options} value={scopes} onChange={setScopes} />
        <p className="text-xs text-muted-foreground">AI 자동 업로드와 함께 쓰는 설정이에요.</p>
      </div>
      {error && <p className="text-xs text-risk">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={isPending || scopes.length === 0}>
          추가
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          취소
        </Button>
      </div>
    </form>
  );
}

export function ShootAccountHeader({
  accountId,
  name,
  scopes,
  options,
  canManage,
}: {
  accountId: string;
  name: string;
  scopes: string[];
  options: ScopeOptionData[];
  canManage: boolean;
}) {
  const { isPending, error, run } = useScheduleRun();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(scopes);
  const [askOff, setAskOff] = useState(false);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        {editing ? (
          <div className="space-y-2">
            <ScopeChecks options={options} value={value} onChange={setValue} />
            <div className="flex gap-1.5">
              <Button size="sm" disabled={isPending || value.length === 0} onClick={() => run(() => updateScopesAction({ accountId, scopes: value }), () => setEditing(false))}>
                저장
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={isPending}
                onClick={() => {
                  setValue(scopes);
                  setEditing(false);
                }}
              >
                취소
              </Button>
            </div>
          </div>
        ) : (
          <p className="flex flex-wrap items-center gap-1.5 text-[13px] text-muted-foreground">
            쓸 상품
            {scopes.map((k) => (
              <span key={k} className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-2">
                {options.find((o) => o.key === k)?.label ?? k}
              </span>
            ))}
            {canManage && (
              <button type="button" className="text-xs text-primary underline-offset-2 hover:underline" onClick={() => setEditing(true)}>
                바꾸기
              </button>
            )}
            <span className="text-xs">(AI 자동 업로드와 함께 써요)</span>
          </p>
        )}
        {canManage && (
          <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-risk" disabled={isPending} onClick={() => setAskOff(true)}>
            <UserMinus className="size-4" /> 계정 빼기
          </Button>
        )}
      </div>
      {error && <p className="text-xs text-risk">{error}</p>}
      <ConfirmDialog
        open={askOff}
        title={`@${name} 계정의 기획을 멈출까요?`}
        confirmLabel="빼기"
        pending={isPending}
        onClose={() => setAskOff(false)}
        onConfirm={() => run(() => disableShootAccountAction({ accountId }), () => setAskOff(false))}
      >
        <p>고르기 전 기획은 목록에서 빠지고 새 기획을 만들지 않아요. 이미 고른 기획과 저장한 컨셉은 그대로예요.</p>
      </ConfirmDialog>
    </div>
  );
}

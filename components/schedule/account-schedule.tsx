"use client";

import { useState, useTransition } from "react";
import { Plus, UserMinus, UserPlus, X } from "lucide-react";
import { addAccountAction, addSlotAction, removalImpactAction, removeAccountAction, updateScopesAction } from "@/app/(dashboard)/schedule/actions";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SlotRuleCell, useScheduleRun, type SlotRuleCellData } from "@/components/schedule/slot-rule-cell";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// 자동 콘텐츠 설정 — 계정마다 쓸 상품 · 하루 칸, 계정 넣기 · 빼기. 규칙(하루 최대 칸 · 칸 사이 간격)은
// 서버(lib/schedule/slot-admin.ts)가 다시 확인하고, 여기서는 미리 알려 주기만 한다.

export interface ScopeOptionData {
  key: string;
  label: string;
}

export interface LimitsData {
  maxSlots: number;
  minGapHours: number;
}

const selectClass = "h-9 rounded-md border border-input bg-card px-2.5 text-[13px] focus-visible:outline-2 focus-visible:outline-primary";

export function ScopeChecks({ options, value, onChange }: { options: ScopeOptionData[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="쓸 상품">
      {options.map((o) => {
        const on = value.includes(o.key);
        return (
          <label
            key={o.key}
            className={cn(
              "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary",
              on ? "border-primary bg-brand-soft font-semibold text-primary" : "border-input bg-card hover:bg-surface-2",
            )}
          >
            <input type="checkbox" className="sr-only" checked={on} onChange={(e) => onChange(e.target.checked ? [...value, o.key] : value.filter((k) => k !== o.key))} />
            {on && "✓ "}
            {o.label}
          </label>
        );
      })}
    </div>
  );
}

export function AccountScheduleCard({
  accountId,
  name,
  scopes,
  rules,
  options,
  limits,
  canManage,
  hideName,
}: {
  accountId: string;
  name: string;
  scopes: string[];
  rules: SlotRuleCellData[];
  options: ScopeOptionData[];
  limits: LimitsData;
  canManage: boolean;
  hideName?: boolean;
}) {
  const { isPending, error, run, setError } = useScheduleRun();
  const [editScopes, setEditScopes] = useState(false);
  const [scopeValue, setScopeValue] = useState(scopes);
  const [adding, setAdding] = useState(false);
  const [newTime, setNewTime] = useState("");
  const [confirm, setConfirm] = useState<{ plans: number; scheduled: number } | null>(null);
  const [checking, startChecking] = useTransition();
  const full = rules.length >= limits.maxSlots;

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4" aria-label={`@${name} 쓸 상품과 하루 칸`}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          {!hideName && <h3 className="text-[15px] font-semibold">@{name}</h3>}
          {editScopes ? (
            <div className="space-y-2">
              <ScopeChecks options={options} value={scopeValue} onChange={setScopeValue} />
              <div className="flex gap-1.5">
                <Button size="sm" disabled={isPending || scopeValue.length === 0} onClick={() => run(() => updateScopesAction({ accountId, scopes: scopeValue }), () => setEditScopes(false))}>
                  저장
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={isPending}
                  onClick={() => {
                    setScopeValue(scopes);
                    setEditScopes(false);
                  }}
                >
                  취소
                </Button>
              </div>
            </div>
          ) : (
            <p className="flex flex-wrap items-center gap-1.5 text-[13px] text-muted-foreground">
              쓸 상품
              {scopes.length ? (
                scopes.map((k) => (
                  <span key={k} className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-2">
                    {options.find((o) => o.key === k)?.label ?? k}
                  </span>
                ))
              ) : (
                <span className="text-risk">없음 — 골라야 기획해요</span>
              )}
              {canManage && (
                <button
                  type="button"
                  className="text-xs text-primary underline-offset-2 hover:underline"
                  onClick={() => {
                    setScopeValue(scopes);
                    setEditScopes(true);
                  }}
                >
                  바꾸기
                </button>
              )}
            </p>
          )}
        </div>
        {canManage && (
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-risk"
            disabled={checking || isPending}
            onClick={() =>
              startChecking(async () => {
                const r = await removalImpactAction({ accountId });
                // 확인하지 못했으면 "기획 없음"으로 안내하지 않고 지우기를 막는다(2026-11-04)
                if (!r.ok) return setError(`앞으로의 기획을 확인하지 못했어요: ${r.error}`);
                setConfirm({ plans: r.plans, scheduled: r.scheduled });
              })
            }
          >
            <UserMinus className="size-4" /> 계정 빼기
          </Button>
        )}
      </header>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {rules.map((r) => (
          <SlotRuleCell key={r.id} rule={r} canManage={canManage} />
        ))}
        {canManage &&
          !full &&
          (adding ? (
            <form
              className="space-y-2 rounded-lg border border-dashed p-3"
              onSubmit={(e) => {
                e.preventDefault();
                run(() => addSlotAction({ accountId, time: newTime, track: "B" }), () => {
                  setAdding(false);
                  setNewTime("");
                });
              }}
            >
              <input type="time" value={newTime} onChange={(e) => setNewTime(e.target.value)} aria-label="새 칸 시각" required className={cn(selectClass, "h-8 tabular-nums")} />
              <div className="flex gap-1.5">
                <Button type="submit" size="sm" disabled={isPending || !newTime}>
                  추가
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
                  취소
                </Button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="flex min-h-24 items-center justify-center gap-1.5 rounded-lg border border-dashed text-[13px] text-muted-foreground hover:bg-surface-2 hover:text-foreground"
            >
              <Plus className="size-4" /> 칸 추가
            </button>
          ))}
      </div>
      <p className="text-xs text-muted-foreground">
        이 계정이 올리는 시각이에요. 계정마다 따로 정해요. 하루 {limits.maxSlots}칸까지, 칸 사이는 {limits.minGapHours}시간 이상이고, 올리기 2시간 전에 상품 확인을 알려 드려요.
        {full && canManage && " 칸이 다 찼어요. 칸을 지우면 새로 추가할 수 있어요."}
      </p>
      {error && <p className="text-xs text-risk">{error}</p>}

      <ConfirmDialog
        open={confirm !== null}
        title={`@${name} 계정을 자동 콘텐츠에서 뺄까요?`}
        danger={(confirm?.plans ?? 0) > 0}
        confirmLabel={confirm && confirm.plans > 0 ? "그래도 빼고 모두 취소" : "빼기"}
        pending={isPending}
        onClose={() => setConfirm(null)}
        onConfirm={() => run(() => removeAccountAction({ accountId }), () => setConfirm(null))}
      >
        {confirm && confirm.scheduled > 0 && (
          <p className="rounded-md bg-risk-soft px-3 py-2 font-semibold text-risk">예약된 발행이 {confirm.scheduled}건 있어요. 빼면 예약이 취소돼 올라가지 않아요.</p>
        )}
        <p>
          {confirm && confirm.plans > 0 ? `앞으로의 기획 ${confirm.plans}개를 모두 취소하고, ` : ""}이 계정의 칸 {rules.length}개를 지워요. 지난 기획 · 발행 기록은
          남고, 계정 연결도 그대로예요.
        </p>
      </ConfirmDialog>
    </section>
  );
}

const DEFAULT_SLOTS = [
  { time: "08:00", track: "B" },
  { time: "21:00", track: "B" },
];

export function AddAccountPanel({
  candidates,
  options,
  limits,
}: {
  candidates: { id: string; name: string }[];
  options: ScopeOptionData[];
  limits: LimitsData;
}) {
  const { isPending, error, run, setError } = useScheduleRun();
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [slots, setSlots] = useState(DEFAULT_SLOTS);

  if (!open)
    return (
      <div className="space-y-1">
        <Button variant="outline" onClick={() => setOpen(true)} disabled={candidates.length === 0}>
          <UserPlus className="size-4" /> 계정 넣기
        </Button>
        {candidates.length === 0 && <p className="text-xs text-muted-foreground">연결된 인스타그램 계정을 모두 넣었어요.</p>}
      </div>
    );

  return (
    <form
      className="space-y-4 rounded-lg border border-primary/40 bg-brand-soft/40 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!accountId) return setError("계정을 골라 주세요.");
        run(() => addAccountAction({ accountId, scopes, slots: slots.map((s) => ({ time: s.time, track: "B" })) }), () => {
          setOpen(false);
          setAccountId("");
          setScopes([]);
          setSlots(DEFAULT_SLOTS);
        });
      }}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-[15px] font-semibold">자동 콘텐츠에 계정 넣기</h3>
        <Button type="button" size="icon" variant="ghost" className="size-8" aria-label="닫기" onClick={() => setOpen(false)}>
          <X className="size-4" />
        </Button>
      </div>
      <label className="block space-y-1.5">
        <span className="text-[13px] font-semibold">인스타그램 계정</span>
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={cn(selectClass, "block w-full max-w-xs")} required>
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
      </div>
      <div className="space-y-1.5">
        <p className="text-[13px] font-semibold">하루 칸</p>
        <ul className="space-y-1.5">
          {slots.map((s, i) => (
            <li key={i} className="flex flex-wrap items-center gap-1.5">
              <input
                type="time"
                value={s.time}
                onChange={(e) => setSlots((prev) => prev.map((x, j) => (j === i ? { ...x, time: e.target.value } : x)))}
                aria-label={`${i + 1}번째 칸 시각`}
                required
                className={cn(selectClass, "tabular-nums")}
              />
              <Button type="button" size="icon" variant="ghost" className="size-8" aria-label={`${i + 1}번째 칸 빼기`} disabled={slots.length <= 1} onClick={() => setSlots((prev) => prev.filter((_, j) => j !== i))}>
                <X className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
        {slots.length < limits.maxSlots && (
          <Button type="button" size="sm" variant="ghost" onClick={() => setSlots((prev) => [...prev, { time: "", track: "B" }])}>
            <Plus className="size-3.5" /> 칸 추가
          </Button>
        )}
        <p className="text-xs text-muted-foreground">
          하루 {limits.maxSlots}칸까지, 같은 계정 칸 사이는 {limits.minGapHours}시간 이상. 올리기 2시간 전에 상품 확인을 알려 드려요.
        </p>
      </div>
      {error && <p className="text-xs text-risk">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={isPending || scopes.length === 0}>
          넣기
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          취소
        </Button>
      </div>
    </form>
  );
}

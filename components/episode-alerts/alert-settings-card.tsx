"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveAlertSettingsAction } from "@/app/(dashboard)/episode-alerts/actions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// 계정 발송 설정 — 이 계정의 모든 시리즈에 공통으로 적용되는 두 가지만.
// 답글 문구는 시리즈마다 정한다(시리즈 카드).
export interface AlertSettingsView {
  mode: "APPROVAL" | "AUTO";
  dailyLimit: number;
  isDefault: boolean;
}

const MODES: { id: "APPROVAL" | "AUTO"; title: string; description: string }[] = [
  {
    id: "APPROVAL",
    title: "확인 후 보내기",
    description: "다음 화가 올라가면 보낼 사람 목록이 확인 대기에 올라와요. 보고 나서 보내요.",
  },
  {
    id: "AUTO",
    title: "바로 보내기",
    description: "다음 화가 올라가면 확인 없이 바로 보내요.",
  },
];

export function AlertSettingsCard({
  accountId,
  accountName,
  settings,
  canManage,
}: {
  accountId: string;
  accountName: string | null;
  settings: AlertSettingsView;
  canManage: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState(settings.mode);
  const [dailyLimit, setDailyLimit] = useState(String(settings.dailyLimit));
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const limitNumber = Number(dailyLimit);
  const limitError =
    !Number.isInteger(limitNumber) || limitNumber < 1 || limitNumber > 1000
      ? "하루 최대 답글 수는 1~1000 사이로 정해주세요."
      : null;
  const dirty = mode !== settings.mode || dailyLimit !== String(settings.dailyLimit);
  const disabled = !canManage || isPending;

  function save() {
    setMessage(null);
    startTransition(async () => {
      const result = await saveAlertSettingsAction({ accountId, mode, dailyLimit: limitNumber });
      if (!result.ok) {
        setMessage({ kind: "error", text: result.error });
        return;
      }
      setMessage({ kind: "ok", text: "저장했어요." });
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">발송 설정</CardTitle>
        <CardDescription>
          {accountName ? `@${accountName}` : "이 계정"}의 모든 시리즈에 똑같이 적용돼요. 답글
          문구는 시리즈마다 따로 정해요.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <fieldset className="space-y-2" disabled={disabled}>
          <legend className="mb-2 text-sm font-medium">보내는 방식</legend>
          {MODES.map((m) => (
            <label
              key={m.id}
              className={cn(
                "flex cursor-pointer gap-3 rounded-md border p-3 transition",
                mode === m.id ? "border-primary bg-primary/5" : "hover:bg-accent/30",
                disabled && "cursor-not-allowed",
              )}
            >
              <input
                type="radio"
                name={`alert-mode-${accountId}`}
                value={m.id}
                checked={mode === m.id}
                onChange={() => {
                  setMode(m.id);
                  setMessage(null);
                }}
                className="mt-0.5 size-4"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{m.title}</span>
                <span className="block text-xs text-muted-foreground">{m.description}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="space-y-1.5">
          <Label htmlFor={`alert-daily-limit-${accountId}`}>하루 최대 답글 수</Label>
          <div className="flex items-center gap-2">
            <input
              id={`alert-daily-limit-${accountId}`}
              type="number"
              inputMode="numeric"
              min={1}
              max={1000}
              value={dailyLimit}
              disabled={disabled}
              onChange={(e) => {
                setDailyLimit(e.target.value);
                setMessage(null);
              }}
              className="w-24 rounded-md border bg-background px-2.5 py-1.5 text-sm tabular-nums disabled:opacity-60"
            />
            <span className="text-sm text-muted-foreground">개</span>
          </div>
          <p className="text-xs text-muted-foreground">
            넘는 만큼은 다음 날 이어서 보내요. 너무 많이 보내면 인스타가 댓글 활동을 제한할 수 있어요.
          </p>
          {limitError && <p className="text-xs text-destructive">{limitError}</p>}
        </div>

        {canManage ? (
          <div className="flex items-center justify-end gap-3">
            {message && (
              <p
                className={cn(
                  "text-xs",
                  message.kind === "ok" ? "text-emerald-700 dark:text-emerald-300" : "text-destructive",
                )}
              >
                {message.text}
              </p>
            )}
            <Button onClick={save} disabled={isPending || !!limitError || (!dirty && !settings.isDefault)}>
              {isPending ? "저장 중…" : "저장"}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            설정은 관리자(ADMIN/MANAGER)만 바꿀 수 있어요.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, RotateCcw, XIcon } from "lucide-react";
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
import {
  DEFAULT_TEMPLATES,
  renderTemplate,
  TEMPLATE_MAX_COUNT,
  TEMPLATE_MAX_LENGTH,
  TEMPLATE_VARIABLES,
  validateTemplates,
} from "@/lib/episode-alerts/templates";
import { cn } from "@/lib/utils";

export interface AlertSettingsView {
  enabled: boolean;
  mode: "APPROVAL" | "AUTO";
  // 편집용 — 저장된 문구가 없으면 기본 문구가 채워져 온다.
  templates: string[];
  dailyLimit: number;
  isDefault: boolean;
}

const MODES: { id: "APPROVAL" | "AUTO"; title: string; description: string }[] = [
  {
    id: "APPROVAL",
    title: "확인 후 보내기",
    description: "보낼 사람 목록을 보고, 뺄 사람을 고른 뒤 보내요.",
  },
  {
    id: "AUTO",
    title: "바로 보내기",
    description: "새 회차가 올라가면 확인 없이 바로 보내요.",
  },
];

export function AlertSettingsCard({
  accountId,
  accountName,
  settings,
  canManage,
  sampleSeriesName,
}: {
  accountId: string;
  accountName: string | null;
  settings: AlertSettingsView;
  canManage: boolean;
  sampleSeriesName: string | null;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [mode, setMode] = useState(settings.mode);
  const [templates, setTemplates] = useState<string[]>(settings.templates);
  const [dailyLimit, setDailyLimit] = useState(String(settings.dailyLimit));
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  // 변수 버튼을 누르면 마지막으로 커서가 있던 문구 칸의 커서 위치에 넣는다.
  const inputRefs = useRef<(HTMLTextAreaElement | null)[]>([]);
  const lastFocus = useRef<{ index: number; caret: number }>({ index: 0, caret: -1 });

  const { errors, warnings } = validateTemplates(templates);
  const limitNumber = Number(dailyLimit);
  const limitError =
    !Number.isInteger(limitNumber) || limitNumber < 1 || limitNumber > 1000
      ? "하루 최대 답글 수는 1~1000 사이로 정해주세요."
      : null;

  const dirty =
    enabled !== settings.enabled ||
    mode !== settings.mode ||
    dailyLimit !== String(settings.dailyLimit) ||
    templates.join("\n") !== settings.templates.join("\n");

  const disabled = !canManage || isPending;
  const sample = {
    username: TEMPLATE_VARIABLES[0].sample,
    series: sampleSeriesName ?? TEMPLATE_VARIABLES[1].sample,
    episode: TEMPLATE_VARIABLES[2].sample,
  };

  function updateTemplate(index: number, value: string) {
    setTemplates((prev) => prev.map((t, i) => (i === index ? value : t)));
    setMessage(null);
  }

  function insertVariable(key: string) {
    const token = `{${key}}`;
    const { index, caret } = lastFocus.current;
    const target = Math.min(index, templates.length - 1);
    if (target < 0) return;
    const current = templates[target];
    const at = caret >= 0 && caret <= current.length ? caret : current.length;
    const next = current.slice(0, at) + token + current.slice(at);
    updateTemplate(target, next);
    // 넣은 뒤 커서를 변수 뒤로.
    requestAnimationFrame(() => {
      const el = inputRefs.current[target];
      if (!el) return;
      el.focus();
      el.setSelectionRange(at + token.length, at + token.length);
      lastFocus.current = { index: target, caret: at + token.length };
    });
  }

  function save() {
    setMessage(null);
    startTransition(async () => {
      const result = await saveAlertSettingsAction({
        accountId,
        enabled,
        mode,
        templates,
        dailyLimit: limitNumber,
      });
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
        <CardTitle className="text-base">알림 설정</CardTitle>
        <CardDescription>
          {accountName ? `@${accountName}` : "이 계정"}에만 적용돼요.
          {settings.isDefault && " 아직 저장하지 않아 기본값을 보여주고 있어요."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* 켜기 */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p id="alert-enabled-label" className="text-sm font-medium">
              새 회차가 올라가면 알림 준비
            </p>
            <p className="text-xs text-muted-foreground">
              끄면 업로드해도 알림을 만들지 않아요. 회차 기록은 계속 남아요.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-labelledby="alert-enabled-label"
            disabled={disabled}
            onClick={() => {
              setEnabled((v) => !v);
              setMessage(null);
            }}
            className={cn(
              "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              "disabled:cursor-not-allowed disabled:opacity-50",
              enabled ? "bg-primary" : "bg-muted-foreground/30",
            )}
          >
            <span
              className={cn(
                "inline-block size-5 rounded-full bg-background shadow transition",
                enabled ? "translate-x-5" : "translate-x-0.5",
              )}
            />
          </button>
        </div>

        {/* 보내는 방식 */}
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

        {/* 답글 문구 */}
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <Label>답글 문구</Label>
            <span className="text-xs text-muted-foreground">순서대로 돌려가며 써요</span>
          </div>

          <ul className="space-y-2">
            {templates.map((t, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <span className="mt-2 w-4 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                <textarea
                  id={`alert-template-${accountId}-${i}`}
                  ref={(el) => {
                    inputRefs.current[i] = el;
                  }}
                  value={t}
                  rows={2}
                  maxLength={TEMPLATE_MAX_LENGTH}
                  disabled={disabled}
                  onChange={(e) => {
                    updateTemplate(i, e.target.value);
                    lastFocus.current = { index: i, caret: e.target.selectionStart };
                  }}
                  onFocus={(e) => {
                    lastFocus.current = { index: i, caret: e.target.selectionStart };
                  }}
                  onSelect={(e) => {
                    lastFocus.current = { index: i, caret: e.currentTarget.selectionStart };
                  }}
                  className="min-w-0 flex-1 resize-none rounded-md border bg-background px-2.5 py-1.5 text-sm disabled:opacity-60"
                />
                {canManage && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title="이 문구 지우기"
                    aria-label={`${i + 1}번 문구 지우기`}
                    disabled={disabled || templates.length <= 1}
                    onClick={() => {
                      setTemplates((prev) => prev.filter((_, j) => j !== i));
                      setMessage(null);
                    }}
                  >
                    <XIcon />
                  </Button>
                )}
              </li>
            ))}
          </ul>

          {canManage && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">넣기:</span>
              {TEMPLATE_VARIABLES.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  disabled={disabled}
                  onClick={() => insertVariable(v.key)}
                  className="rounded-full border px-2 py-0.5 text-xs transition hover:bg-accent/40 disabled:opacity-50"
                  title={`{${v.key}}`}
                >
                  {v.label}
                </button>
              ))}
            </div>
          )}

          {canManage && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={disabled || templates.length >= TEMPLATE_MAX_COUNT}
                onClick={() => {
                  setTemplates((prev) => [...prev, ""]);
                  lastFocus.current = { index: templates.length, caret: -1 };
                }}
              >
                <Plus /> 문구 추가
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => {
                  setTemplates(DEFAULT_TEMPLATES);
                  setMessage(null);
                }}
              >
                <RotateCcw /> 기본 문구로
              </Button>
            </div>
          )}

          <div className="space-y-1.5 rounded-md bg-muted/50 p-3">
            <p className="text-xs font-medium text-muted-foreground">미리보기</p>
            {templates
              .map((t) => t.trim())
              .filter(Boolean)
              .map((t, i) => (
                <p key={i} className="text-sm leading-snug">
                  {renderTemplate(t, sample)}
                </p>
              ))}
          </div>

          {errors.map((e) => (
            <p key={e} className="text-xs text-destructive">
              {e}
            </p>
          ))}
          {warnings.map((w) => (
            <p key={w} className="text-xs text-amber-700 dark:text-amber-300">
              {w}
            </p>
          ))}
          <p className="text-xs text-muted-foreground">
            인스타 댓글 속 링크는 눌리지 않아서 “프로필에서 확인”처럼 쓰는 게 좋아요.
          </p>
        </div>

        {/* 하루 상한 */}
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
            <Button
              onClick={save}
              disabled={isPending || errors.length > 0 || !!limitError || (!dirty && !settings.isDefault)}
            >
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

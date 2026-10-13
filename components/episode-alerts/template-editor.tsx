"use client";

import { useRef } from "react";
import { Plus, RotateCcw, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_TEMPLATES,
  renderTemplate,
  TEMPLATE_MAX_COUNT,
  TEMPLATE_MAX_LENGTH,
  TEMPLATE_VARIABLES,
  validateTemplates,
} from "@/lib/episode-alerts/templates";

// 시리즈 답글 문구 편집기 — 새 시리즈 만들기와 시리즈 카드의 "문구 수정"이 같이 쓴다.
// 문구 여러 개를 순서대로 돌려쓰고, 변수 버튼은 마지막 커서 위치에 넣는다.
export function TemplateEditor({
  idPrefix,
  value,
  onChange,
  disabled,
  seriesName,
}: {
  idPrefix: string;
  value: string[];
  onChange: (templates: string[]) => void;
  disabled: boolean;
  seriesName: string;
}) {
  const inputRefs = useRef<(HTMLTextAreaElement | null)[]>([]);
  const lastFocus = useRef<{ index: number; caret: number }>({ index: 0, caret: -1 });

  const { errors, warnings } = validateTemplates(value);
  const sample = {
    username: TEMPLATE_VARIABLES[0].sample,
    series: seriesName.trim() || TEMPLATE_VARIABLES[1].sample,
    episode: TEMPLATE_VARIABLES[2].sample,
  };

  function update(index: number, text: string) {
    onChange(value.map((t, i) => (i === index ? text : t)));
  }

  function insertVariable(key: string) {
    const token = `{${key}}`;
    const { index, caret } = lastFocus.current;
    const target = Math.min(index, value.length - 1);
    if (target < 0) return;
    const current = value[target];
    const at = caret >= 0 && caret <= current.length ? caret : current.length;
    update(target, current.slice(0, at) + token + current.slice(at));
    // 넣은 뒤 커서를 변수 뒤로.
    requestAnimationFrame(() => {
      const el = inputRefs.current[target];
      if (!el) return;
      el.focus();
      el.setSelectionRange(at + token.length, at + token.length);
      lastFocus.current = { index: target, caret: at + token.length };
    });
  }

  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {value.map((t, i) => (
          <li key={i} className="flex items-start gap-1.5">
            <span className="mt-2 w-4 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {i + 1}
            </span>
            <textarea
              id={`${idPrefix}-template-${i}`}
              aria-label={`${i + 1}번 답글 문구`}
              ref={(el) => {
                inputRefs.current[i] = el;
              }}
              value={t}
              rows={2}
              maxLength={TEMPLATE_MAX_LENGTH}
              disabled={disabled}
              onChange={(e) => {
                update(i, e.target.value);
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
            <Button
              variant="ghost"
              size="icon-sm"
              title="이 문구 지우기"
              aria-label={`${i + 1}번 문구 지우기`}
              disabled={disabled || value.length <= 1}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              <XIcon />
            </Button>
          </li>
        ))}
      </ul>

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

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || value.length >= TEMPLATE_MAX_COUNT}
          onClick={() => {
            lastFocus.current = { index: value.length, caret: -1 };
            onChange([...value, ""]);
          }}
        >
          <Plus /> 문구 추가
        </Button>
        <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(DEFAULT_TEMPLATES)}>
          <RotateCcw /> 기본 문구로
        </Button>
      </div>

      <div className="space-y-1.5 rounded-md bg-muted/50 p-3">
        <p className="text-xs font-medium text-muted-foreground">미리보기 · 순서대로 돌려가며 달려요</p>
        {value
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
  );
}

export function hasTemplateErrors(templates: string[]): boolean {
  return validateTemplates(templates).errors.length > 0;
}

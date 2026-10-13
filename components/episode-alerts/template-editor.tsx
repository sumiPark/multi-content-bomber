"use client";

import { Fragment, useRef } from "react";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_TEMPLATES,
  TEMPLATE_MAX_COUNT,
  TEMPLATE_MAX_LENGTH,
  TEMPLATE_VARIABLES,
  validateTemplates,
  type TemplateVariable,
} from "@/lib/episode-alerts/templates";
import { cn } from "@/lib/utils";

// 시리즈 답글 문구 — 보기(TemplateList)와 고치기(TemplateEditor).
// 문구 안의 {username}·{series}·{episode}는 실제로 들어갈 값 모양의 칩으로 보여준다.

const VARIABLE_LABEL: Record<TemplateVariable, string> = {
  username: "@댓글 단 사람",
  series: "시리즈 이름",
  episode: "회차 번호",
};

const TOKEN = /\{(username|series|episode)\}/g;

// 문구 한 줄을 글자 + 변수 칩으로 그린다.
export function TemplateText({
  template,
  seriesName,
  episodeNo,
  className,
}: {
  template: string;
  seriesName: string;
  episodeNo: number | null;
  className?: string;
}) {
  const parts: { text: string; variable?: TemplateVariable }[] = [];
  let last = 0;
  for (const m of template.matchAll(TOKEN)) {
    if (m.index > last) parts.push({ text: template.slice(last, m.index) });
    const key = m[1] as TemplateVariable;
    const value =
      key === "username"
        ? "@아이디"
        : key === "series"
          ? seriesName.trim() || "시리즈 이름"
          : episodeNo !== null
            ? String(episodeNo)
            : "N";
    parts.push({ text: value, variable: key });
    last = m.index + m[0].length;
  }
  if (last < template.length) parts.push({ text: template.slice(last) });

  return (
    <span className={cn("leading-relaxed", className)}>
      {parts.map((p, i) =>
        p.variable ? (
          <span
            key={i}
            title={VARIABLE_LABEL[p.variable]}
            className="mx-px rounded bg-primary/10 px-1 py-px font-medium text-primary"
          >
            {p.text}
          </span>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </span>
  );
}

// 보기 — 실제로 달릴 모양 그대로.
export function TemplateList({
  templates,
  seriesName,
  episodeNo,
}: {
  templates: string[];
  seriesName: string;
  episodeNo: number | null;
}) {
  return (
    <ul className="space-y-1.5">
      {templates.map((t, i) => (
        <li key={i} className="rounded-2xl rounded-tl-sm bg-muted/60 px-3 py-2 text-sm">
          <TemplateText template={t} seriesName={seriesName} episodeNo={episodeNo} />
        </li>
      ))}
    </ul>
  );
}

// 고치기 — 문구마다 입력칸, 변수 넣기 버튼, 바로 아래 미리보기.
export function TemplateEditor({
  idPrefix,
  value,
  onChange,
  disabled,
  seriesName,
  episodeNo,
}: {
  idPrefix: string;
  value: string[];
  onChange: (templates: string[]) => void;
  disabled: boolean;
  seriesName: string;
  episodeNo: number | null;
}) {
  const inputRefs = useRef<(HTMLTextAreaElement | null)[]>([]);
  // 문구 칸마다 마지막 커서 위치. 변수 넣기 버튼은 그 자리에 넣는다(없으면 끝에).
  const carets = useRef<Record<number, number>>({});

  const { errors, warnings } = validateTemplates(value);

  function update(index: number, text: string) {
    onChange(value.map((t, i) => (i === index ? text : t)));
  }

  function insert(index: number, key: string) {
    const token = `{${key}}`;
    const current = value[index];
    const caret = carets.current[index];
    const at = caret !== undefined && caret <= current.length ? caret : current.length;
    update(index, current.slice(0, at) + token + current.slice(at));
    requestAnimationFrame(() => {
      const el = inputRefs.current[index];
      if (!el) return;
      el.focus();
      el.setSelectionRange(at + token.length, at + token.length);
      carets.current[index] = at + token.length;
    });
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-2.5">
        {value.map((t, i) => (
          <li
            key={i}
            className="rounded-lg border bg-background transition focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/15"
          >
            <div className="flex items-start gap-1 p-2">
              <textarea
                id={`${idPrefix}-template-${i}`}
                aria-label={`답글 문구 ${i + 1}`}
                ref={(el) => {
                  inputRefs.current[i] = el;
                }}
                value={t}
                rows={2}
                maxLength={TEMPLATE_MAX_LENGTH}
                disabled={disabled}
                placeholder="예) {username} 다음 화 올라왔어요!"
                onChange={(e) => {
                  update(i, e.target.value);
                  carets.current[i] = e.target.selectionStart;
                }}
                onSelect={(e) => {
                  carets.current[i] = e.currentTarget.selectionStart;
                }}
                className="min-w-0 flex-1 resize-none bg-transparent px-1 py-0.5 text-sm outline-none disabled:opacity-60"
              />
              <Button
                variant="ghost"
                size="icon-sm"
                title="이 문구 지우기"
                aria-label={`답글 문구 ${i + 1} 지우기`}
                disabled={disabled || value.length <= 1}
                onClick={() => onChange(value.filter((_, j) => j !== i))}
              >
                <Trash2 />
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 border-t px-3 py-2">
              {TEMPLATE_VARIABLES.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  disabled={disabled}
                  onClick={() => insert(i, v.key)}
                  className="inline-flex items-center gap-0.5 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground transition hover:border-primary/40 hover:text-primary disabled:opacity-50"
                >
                  <Plus className="size-3" />
                  {VARIABLE_LABEL[v.key]}
                </button>
              ))}
            </div>
            {t.trim() && (
              <div className="border-t bg-muted/30 px-3 py-2 text-sm">
                <TemplateText template={t} seriesName={seriesName} episodeNo={episodeNo} />
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || value.length >= TEMPLATE_MAX_COUNT}
          onClick={() => onChange([...value, ""])}
        >
          <Plus /> 문구 추가
        </Button>
        <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(DEFAULT_TEMPLATES)}>
          <RotateCcw /> 기본 문구로
        </Button>
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
    </div>
  );
}

export function hasTemplateErrors(templates: string[]): boolean {
  return validateTemplates(templates).errors.length > 0;
}

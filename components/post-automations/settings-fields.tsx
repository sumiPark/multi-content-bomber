"use client";

import { useRef, useState, type ReactNode } from "react";
import { ChevronRight, CircleAlert, LoaderCircle, Search, XIcon } from "lucide-react";
import { searchProductsForAutomation } from "@/app/(dashboard)/post-automations/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Switch, Thumb } from "./shared";
import type { ProductView } from "./types";

// 설정 창 입력 부품 — 접는 칸, 변수 넣기 글상자, 태그 입력, 상품 찾기.

export function FieldError({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-1 text-xs text-risk">
      <CircleAlert className="size-3.5 shrink-0" />
      {children}
    </p>
  );
}

export function Hint({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-xs text-muted-foreground", className)}>{children}</p>;
}

export function FieldLabel({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <span className="text-sm font-semibold text-ink-2">
      {children}
      {sub && <span className="ml-1 text-xs font-normal text-muted-foreground">{sub}</span>}
    </span>
  );
}

export const selectClass =
  "h-9 w-full rounded-md border border-input bg-card px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

// ─────────────────────────────────────────────────────────────────────────────
// 접는 칸 — 번호 · 제목 · 요약 · 켜기 스위치 · 오류

export function Section({
  no,
  title,
  summary,
  on,
  onSwitch,
  open,
  onToggleOpen,
  error,
  children,
}: {
  no: number;
  title: string;
  summary: string;
  /** 켜기 스위치가 있는 칸이면 지금 값 */
  on?: boolean;
  onSwitch?: (next: boolean) => void;
  open: boolean;
  onToggleOpen: () => void;
  error?: string;
  children: ReactNode;
}) {
  const active = on ?? true;
  return (
    <section data-err={error ? "true" : undefined} className={cn("rounded-lg border bg-card", error && "border-risk")}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggleOpen}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            onToggleOpen();
          }
        }}
        className="flex cursor-pointer items-center gap-2.5 rounded-lg px-3.5 py-3 outline-none select-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          className={cn(
            "grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold",
            active ? "bg-brand-soft text-primary" : "bg-surface-2 text-muted-foreground",
          )}
        >
          {no}
        </span>
        <span className={cn("text-base font-semibold whitespace-nowrap", !active && "text-muted-foreground")}>{title}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{summary}</span>
        {onSwitch && <Switch checked={!!on} onChange={onSwitch} label={`${title} 켜기`} />}
        <ChevronRight className={cn("size-[18px] shrink-0 text-faint transition-transform", open && "rotate-90")} />
      </div>
      {open && (
        <div className="flex flex-col gap-3.5 px-3.5 pb-4 sm:pl-12">
          {error && <FieldError>{error}</FieldError>}
          {children}
        </div>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 글상자 + 변수 넣기 버튼({키워드} 등은 커서 자리에) + 글자 수

export function TextField({
  label,
  value,
  onChange,
  vars,
  counter,
  rows = 3,
  placeholder,
  maxLength,
}: {
  label?: ReactNode;
  value: string;
  onChange: (v: string) => void;
  vars?: string[];
  counter?: { text: string; over: boolean };
  rows?: number;
  placeholder?: string;
  maxLength?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  function insert(token: string) {
    const el = ref.current;
    const s = el?.selectionStart ?? value.length;
    const e = el?.selectionEnd ?? value.length;
    const piece = `{${token}}`;
    onChange(value.slice(0, s) + piece + value.slice(e));
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(s + piece.length, s + piece.length);
    });
  }
  return (
    <div className="flex flex-col gap-1.5">
      {label && <FieldLabel>{label}</FieldLabel>}
      <Textarea
        ref={ref}
        rows={rows}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-[84px] resize-y leading-[22px] placeholder:text-faint"
      />
      {(vars?.length || counter) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {vars?.length ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">넣기</span>
              {vars.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => insert(v)}
                  className="h-7 rounded-[6px] border border-dashed border-input bg-card px-2 text-xs text-ink-2 hover:border-primary hover:text-primary"
                >
                  {`{${v}}`}
                </button>
              ))}
            </div>
          ) : (
            <span />
          )}
          {counter && <span className={cn("text-xs tabular-nums", counter.over ? "font-semibold text-risk" : "text-muted-foreground")}>{counter.text}</span>}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 태그 입력 — Enter · 쉼표로 넣고, 빈 칸에서 Backspace로 마지막을 뺀다

const TAG_MAX_LEN = 30;

export function TagInput({
  values,
  onChange,
  placeholder,
  tone,
  max,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
  tone: "brand" | "gray";
  max: number;
}) {
  const [draft, setDraft] = useState("");
  function add(raw: string) {
    const next = [...values];
    for (const v of raw.split(",").map((x) => x.trim().slice(0, TAG_MAX_LEN)).filter(Boolean)) {
      if (!next.includes(v) && next.length < max) next.push(v);
    }
    setDraft("");
    if (next.length !== values.length) onChange(next);
  }
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input bg-card px-2 py-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
      {values.map((v, i) => (
        <span
          key={v}
          className={cn(
            "inline-flex h-[26px] items-center gap-0.5 rounded-full pr-1 pl-2.5 text-xs font-semibold",
            tone === "brand" ? "bg-brand-soft text-primary" : "bg-surface-2 text-ink-2",
          )}
        >
          {v}
          <button
            type="button"
            aria-label={`${v} 빼기`}
            onClick={() => onChange(values.filter((_, j) => j !== i))}
            className="grid size-5 place-items-center rounded-full hover:bg-surface-3"
          >
            <XIcon className="size-3.5" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => {
          const v = e.target.value;
          if (v.includes(",")) add(v);
          else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            add(draft);
          } else if (e.key === "Backspace" && !draft && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={() => draft.trim() && add(draft)}
        placeholder={values.length >= max ? `${max}개까지 넣을 수 있어요` : values.length ? "더 넣기" : placeholder}
        disabled={values.length >= max}
        className="h-[26px] min-w-[120px] flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 상품 칸 — 이름으로 찾아 고른다. 연결 안 함도 된다.

export function ProductField({
  product,
  onChange,
  error,
}: {
  product: ProductView | null;
  onChange: (p: ProductView | null) => void;
  error?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProductView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  function search(q: string) {
    setQuery(q);
    if (timer.current) clearTimeout(timer.current);
    if (!q.trim()) {
      setResults(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    timer.current = setTimeout(async () => {
      const my = ++seq.current;
      const r = await searchProductsForAutomation(q);
      if (my !== seq.current) return;
      setLoading(false);
      if (r.ok) {
        setResults(r.products);
        setSearchError(null);
      } else setSearchError(r.error);
    }, 300);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel>상품</FieldLabel>
      <div className="flex flex-wrap items-center gap-2">
        {product ? (
          <>
            <Thumb src={product.image} className="h-9 w-9" />
            <span className="min-w-0 text-sm font-medium">{product.name}</span>
            <Badge variant={product.soldOut ? "destructive" : "ok"}>{product.soldOut ? "품절" : "판매 중"}</Badge>
            <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
              연결 안 함
            </Button>
          </>
        ) : (
          <span className="text-sm text-muted-foreground">상품 연결 안 함</span>
        )}
      </div>
      <div className="relative max-w-[420px]">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => search(e.target.value)}
          placeholder={product ? "다른 상품 찾기" : "상품 이름으로 찾기"}
          className="pl-8 placeholder:text-faint"
          aria-label="상품 찾기"
        />
        {loading && <LoaderCircle className="absolute top-1/2 right-2.5 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />}
      </div>
      {searchError && <FieldError>{searchError}</FieldError>}
      {results && query.trim() && (
        <div className="max-h-56 max-w-[420px] overflow-y-auto rounded-md border bg-card">
          {results.length === 0 ? (
            <p className="px-3 py-2.5 text-xs text-muted-foreground">찾은 상품이 없어요.</p>
          ) : (
            results.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  onChange(p);
                  setQuery("");
                  setResults(null);
                }}
                className="flex w-full items-center gap-2.5 border-b px-2.5 py-2 text-left text-sm last:border-b-0 hover:bg-surface-2"
              >
                <Thumb src={p.image} className="h-8 w-8" />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                {p.soldOut && <Badge variant="destructive">품절</Badge>}
              </button>
            ))
          )}
        </div>
      )}
      {error && <FieldError>{error}</FieldError>}
      <Hint>보내기 직전에 판매 상태를 다시 확인해요.</Hint>
    </div>
  );
}

"use client";

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { Flag, Hourglass, ImageIcon, Pause, Play, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { effectiveReplyWhen, type AutomationConfig } from "@/lib/post-automations/config";
import { cn } from "@/lib/utils";
import type { AutomationView } from "./types";

// 댓글 · DM 자동화 화면 공용 부품 · 문구.

// ─────────────────────────────────────────────────────────────────────────────
// 날짜 — 서버 렌더와 브라우저의 시간대가 달라 마운트 뒤에만 그린다(hydration mismatch 방지).

const noopSubscribe = () => () => {};
export function useMounted(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

export const DAY_MS = 24 * 60 * 60_000;

export function monthDay(d: Date): string {
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

export function MonthDay({ iso }: { iso: string | Date }) {
  const mounted = useMounted();
  if (!mounted) return null;
  return <>{monthDay(typeof iso === "string" ? new Date(iso) : iso)}</>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 게시물 제목 — 캡션 첫 줄

export function captionTitle(caption: string | null | undefined): string {
  const line = (caption ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  return line ?? "(캡션 없음)";
}

// ─────────────────────────────────────────────────────────────────────────────
// 스위치 (DESIGN.md: OFF 토글 bg-surface-3)

export function Switch({
  checked,
  onChange,
  disabled,
  label,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={cn(
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45",
        checked ? "bg-primary" : "bg-surface-3",
        className,
      )}
    >
      <span
        className={cn(
          "inline-block size-[18px] rounded-full bg-card shadow-[0_1px_2px_rgb(16_24_40/.25)] transition-transform",
          checked ? "translate-x-[19px]" : "translate-x-[3px]",
        )}
      />
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 상태 배지 — 색 + 아이콘 + 글자

const PAUSED_LABEL: Record<string, string> = {
  SOLDOUT: "멈춤 · 품절",
  ACCOUNT: "멈춤 · 계정",
  PUBLISH_FAILED: "멈춤 · 발행 실패",
};

export function StatusBadge({ a }: { a: Pick<AutomationView, "status" | "pausedReason"> }) {
  if (a.status === "ACTIVE") {
    return (
      <Badge variant="ok">
        <Play />
        진행 중
      </Badge>
    );
  }
  if (a.status === "WAITING") {
    return (
      <Badge variant="secondary">
        <Hourglass />
        발행 기다림
      </Badge>
    );
  }
  if (a.status === "PAUSED") {
    const risk = a.pausedReason && a.pausedReason !== "MANUAL";
    return (
      <Badge variant={risk ? "destructive" : "secondary"}>
        <Pause />
        {risk ? (PAUSED_LABEL[a.pausedReason!] ?? "멈춤") : "꺼짐"}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary">
      <Flag />
      끝남
    </Badge>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 썸네일 — 게시물 미리보기를 저장하지 않아서 상품 사진, 없으면 아이콘

export function Thumb({ src, className }: { src: string | null | undefined; className?: string }) {
  return (
    <span className={cn("grid h-12 w-9 shrink-0 place-items-center overflow-hidden rounded-[6px] border bg-surface-2 text-muted-foreground", className)}>
      {src ? (
        // 상품 · 인스타 CDN 이미지라 next/image 대신 img
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="size-full object-cover" loading="lazy" />
      ) : (
        <ImageIcon className="size-[18px]" />
      )}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 설정 요약 문구 (표 · 서랍 · 템플릿)

export function DoesChips({ c }: { c: AutomationConfig }) {
  const items: Array<[string, boolean]> = [
    ["첫 댓글", c.first.on],
    ["답글", c.reply.on],
    ["DM", c.dm.on],
  ];
  return (
    <div className="flex flex-wrap gap-1">
      {items.map(([label, on]) => (
        <span
          key={label}
          className={cn(
            "inline-flex h-6 items-center rounded-[6px] bg-surface-2 px-2 text-xs",
            on ? "text-ink-2" : "text-faint line-through",
          )}
        >
          {label}
        </span>
      ))}
    </div>
  );
}

export function TriggerCell({ c }: { c: AutomationConfig }) {
  if (!c.dm.on && !c.reply.on) return <span className="text-xs text-muted-foreground">첫 댓글만</span>;
  if (c.trig.mode === "all") {
    return (
      <span className="text-xs text-ink-2">
        모든 댓글
        {c.trig.exclude.length > 0 && <span className="text-muted-foreground"> · 제외 단어 {c.trig.exclude.length}개</span>}
      </span>
    );
  }
  if (!c.trig.keywords.length) return <span className="text-xs text-muted-foreground">키워드 없음</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {c.trig.keywords.map((k) => (
        <span key={k} className="inline-flex h-6 items-center rounded-[6px] bg-brand-soft px-2 text-xs font-semibold text-primary">
          {k}
        </span>
      ))}
    </div>
  );
}

export const FORMAT_LABEL: Record<AutomationConfig["dm"]["format"], string> = {
  button: "버튼 메시지",
  twostep: "두 단계",
  text: "글자만",
};

export function triggerText(c: AutomationConfig): string {
  if (!c.dm.on && !c.reply.on) return "답글 · DM이 꺼져 있어요";
  if (c.trig.mode === "all") {
    return `모든 댓글${c.trig.exclude.length ? ` (제외: ${c.trig.exclude.join(", ")})` : ""}`;
  }
  if (!c.trig.keywords.length) return "키워드를 넣어 주세요";
  return `${c.trig.keywords.map((k) => `'${k}'`).join(" · ")} ${c.trig.match === "exact" ? "정확히 일치" : "포함"}`;
}

export function replyText(c: AutomationConfig): string {
  if (!c.reply.on) return "꺼짐";
  const n = c.reply.texts.filter((t) => t.trim()).length;
  return `${effectiveReplyWhen(c) === "dm" ? "DM 받은 사람에게" : "반응한 댓글 모두에"} · 문구 ${n}개 돌려 쓰기`;
}

/** 템플릿 목록 한 줄 설명 */
export function templateSummary(c: AutomationConfig): string {
  const parts: string[] = [];
  if (c.dm.on || c.reply.on) parts.push(c.trig.mode === "all" ? "모든 댓글" : c.trig.keywords.length ? `${c.trig.keywords.map((k) => `'${k}'`).join(" · ")} 키워드` : "키워드 댓글");
  if (c.first.on) parts.push("첫 댓글");
  if (c.dm.on) parts.push(`DM ${FORMAT_LABEL[c.dm.format]}`);
  if (c.reply.on) parts.push(`답글 ${c.reply.texts.filter((t) => t.trim()).length}개`);
  parts.push(`${c.period.days}일`);
  return parts.join(" · ");
}

// ─────────────────────────────────────────────────────────────────────────────
// 모달 틀 — 네이티브 <dialog>(Esc · 포커스 가두기는 브라우저가). 입력은 모달(DESIGN.md 1장).

export function DialogShell({
  open,
  onClose,
  label,
  widthClass,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  /** 예: "w-[min(1100px,calc(100vw-24px))]" */
  widthClass: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={cn(
        "m-auto max-h-[calc(100dvh-24px)] overflow-hidden rounded-xl border bg-card p-0 text-foreground shadow-[0_8px_24px_rgb(16_24_40/.12),0_2px_6px_rgb(16_24_40/.08)] backdrop:bg-black/40",
        widthClass,
      )}
    >
      {open && <div className="flex max-h-[calc(100dvh-24px)] flex-col">{children}</div>}
    </dialog>
  );
}

export function DialogHeader({ title, sub, onClose, icon }: { title: ReactNode; sub?: ReactNode; onClose: () => void; icon?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-b px-5 py-3.5">
      {icon}
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-bold">{title}</h2>
        {sub && <div className="truncate text-xs text-muted-foreground">{sub}</div>}
      </div>
      <Button variant="ghost" size="icon" aria-label="닫기" onClick={onClose}>
        <XIcon />
      </Button>
    </div>
  );
}

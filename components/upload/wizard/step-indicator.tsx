import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface StepIndicatorProps {
  current: number;
  steps: { key: number; label: string }[];
  /** 끝낸 단계를 눌러 되돌아갈 때. 앞 단계로 건너뛰는 건 막는다(업로드 · 캡션 저장을 거쳐야 해서). */
  onJump?: (step: number) => void;
  /** 업로드 · 생성 · 등록 중에는 이동을 막는다. */
  disabled?: boolean;
}

// DESIGN.md — 설정 화면의 왼쪽 단계 목록. 1280px 미만에서는 가로로 스크롤되는 한 줄.
export function StepIndicator({
  current,
  steps,
  onJump,
  disabled,
}: StepIndicatorProps) {
  return (
    <nav aria-label="단계" className="min-w-0 lg:sticky lg:top-[76px]">
      <ol className="flex gap-1 overflow-x-auto lg:flex-col">
        {steps.map((s) => {
          const status =
            current > s.key ? "done" : current === s.key ? "active" : "pending";
          const clickable = status === "done" && !!onJump && !disabled;
          return (
            <li key={s.key} className="shrink-0">
              <button
                type="button"
                onClick={clickable ? () => onJump?.(s.key) : undefined}
                disabled={!clickable && status !== "active"}
                aria-current={status === "active" ? "step" : undefined}
                className={cn(
                  "flex h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm font-medium whitespace-nowrap transition-colors",
                  status === "active" && "bg-brand-soft font-semibold text-primary",
                  status === "done" && "text-ink-2",
                  status === "pending" && "text-muted-foreground",
                  clickable && "hover:bg-surface-2",
                  !clickable && status !== "active" && "cursor-default",
                )}
              >
                <span
                  className={cn(
                    "grid size-[22px] shrink-0 place-items-center rounded-full border text-xs tabular-nums",
                    status === "active" && "border-primary bg-primary text-primary-foreground",
                    status === "done" && "border-ok bg-ok-soft text-ok",
                    status === "pending" && "border-line-strong",
                  )}
                >
                  {status === "done" ? <Check className="size-3" /> : s.key}
                </span>
                {s.label}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// DESIGN.md 6장 탭(세그먼트): bg-surface-2 + 테두리, 선택 칸은 흰 바탕 + 굵게.
// 여러 값 중 하나를 고르는 버튼 묶음(탭 패널이 없는 경우)에 쓴다.

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
  className,
}: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex w-fit max-w-full items-center overflow-x-auto rounded-md border bg-surface-2 p-[2px]",
        className,
      )}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            disabled={disabled || o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex h-[30px] items-center gap-1.5 rounded-[6px] px-3 text-xs font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0",
              on && "bg-card font-semibold text-foreground shadow-[0_1px_2px_rgb(16_24_40/0.12)]",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

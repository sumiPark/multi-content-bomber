import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface StepIndicatorProps {
  current: number;
  steps: { key: number; label: string }[];
}

export function StepIndicator({ current, steps }: StepIndicatorProps) {
  return (
    <ol className="flex items-center gap-2">
      {steps.map((s, idx) => {
        const status =
          current > s.key ? "done" : current === s.key ? "active" : "pending";
        return (
          <li key={s.key} className="flex flex-1 items-center gap-2">
            <div className="flex items-center gap-2">
              <div
                className={cn(
                  "flex size-7 items-center justify-center rounded-full text-xs font-semibold transition",
                  status === "done" && "bg-primary text-primary-foreground",
                  status === "active" &&
                    "bg-primary/15 text-primary ring-2 ring-primary",
                  status === "pending" &&
                    "bg-muted text-muted-foreground",
                )}
              >
                {status === "done" ? <Check className="size-3.5" /> : s.key}
              </div>
              <span
                className={cn(
                  "text-sm transition",
                  status === "active"
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {s.label}
              </span>
            </div>
            {idx < steps.length - 1 && (
              <div
                className={cn(
                  "h-px flex-1 transition",
                  current > s.key ? "bg-primary" : "bg-border",
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

import Link from "next/link";
import { AlertTriangle, ArrowRight } from "lucide-react";
import type { HealthWarning } from "@/lib/collection-health";
import { cn } from "@/lib/utils";

// 대시보드 수집 누락 경고 (콘텐츠 자동화 2-6). 경고가 없으면 아무것도 안 그린다.
export function CollectionHealthBar({ warnings }: { warnings: HealthWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="space-y-2">
      {warnings.map((w) => (
        <div
          key={w.message}
          className={cn(
            "flex items-center justify-between gap-3 rounded-lg border px-4 py-2.5 text-sm",
            w.level === "error"
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : "border-warn/40 bg-warn-soft text-warn",
          )}
        >
          <span className="flex min-w-0 items-center gap-3">
            <AlertTriangle className="size-4 shrink-0" />
            <span className="line-clamp-1">{w.message}</span>
          </span>
          <Link href={w.href} className="flex shrink-0 items-center gap-1 font-medium hover:underline">
            확인 <ArrowRight className="size-3.5" />
          </Link>
        </div>
      ))}
    </div>
  );
}

import Link from "next/link";
import { cn } from "@/lib/utils";

// 분석 화면 탭 — 주소(?tab=)로 고른다. 모양은 DESIGN.md 6장 세그먼트 + 건수 pill.

export type AnalyticsTab = "profile" | "posts" | "compare";

export function AnalyticsTabs({
  active,
  scoredCount,
  collectedCount,
  compareCount,
}: {
  active: AnalyticsTab;
  // 프로필 점수가 있는 계정 수
  scoredCount: number;
  // 성과가 수집된 계정 수 — 0이면 "수집 전"
  collectedCount: number;
  // 비교 계정 수 (우리 계정별로 겹쳐 세지 않음)
  compareCount: number;
}) {
  const tabs: { value: AnalyticsTab; label: string; pill: string }[] = [
    { value: "profile", label: "프로필 점수", pill: scoredCount > 0 ? String(scoredCount) : "채점 전" },
    { value: "posts", label: "게시물 성과", pill: collectedCount > 0 ? String(collectedCount) : "수집 전" },
    { value: "compare", label: "다른 계정 비교", pill: compareCount > 0 ? String(compareCount) : "없음" },
  ];
  return (
    <nav aria-label="분석 화면 고르기" className="inline-flex w-fit max-w-full items-center overflow-x-auto rounded-md border bg-surface-2 p-[2px]">
      {tabs.map((t) => {
        const on = t.value === active;
        return (
          <Link
            key={t.value}
            href={`/analytics?tab=${t.value}`}
            aria-current={on ? "page" : undefined}
            className={cn(
              "inline-flex h-9 items-center gap-2 rounded-[6px] px-4 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              on && "bg-card font-semibold text-foreground shadow-[0_1px_2px_rgb(16_24_40/0.12)]",
            )}
          >
            {t.label}
            <span
              className={cn(
                "inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-xs leading-5 font-semibold tabular-nums",
                on ? "bg-brand-soft text-primary" : "bg-surface-3 text-muted-foreground",
              )}
            >
              {t.pill}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

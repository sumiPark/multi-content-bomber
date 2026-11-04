import Link from "next/link";
import { cn } from "@/lib/utils";

// 직접 촬영 화면의 계정 탭 — 주소(?account=)로 구분해 새로 고침 · 링크 공유해도 그 계정. 계정이 많으면 탭 줄만 가로로 넘긴다.

export interface AccountTab {
  key: string;
  label: string;
  count: number;
  href: string;
}

export function AccountTabs({ tabs, active, label }: { tabs: AccountTab[]; active: string; label: string }) {
  return (
    <nav className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0" aria-label={label}>
      <div className="inline-flex rounded-lg border bg-surface-2 p-1">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={t.href}
            aria-current={active === t.key ? "page" : undefined}
            className={cn(
              "inline-flex h-9 items-center gap-1.5 rounded-md px-3.5 text-[13px] whitespace-nowrap transition-colors",
              active === t.key ? "bg-card font-semibold text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
            <span className={cn("text-xs font-medium tabular-nums", active === t.key ? "text-primary" : "text-muted-foreground")}>{t.count}</span>
          </Link>
        ))}
      </div>
    </nav>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ComponentType } from "react";
import {
  Archive,
  BarChart3,
  CalendarClock,
  Link2,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquareReply,
  Send,
  Sparkles,
  Wand2,
  XIcon,
} from "lucide-react";
import { signOut } from "@/app/(auth)/actions";
import { cn } from "@/lib/utils";

type BadgeKind = "count" | "soon";

interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  badgeKind?: BadgeKind;
}

interface NavGroup {
  label?: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { href: "/", label: "대시보드", icon: LayoutDashboard },
      { href: "/analytics", label: "분석", icon: BarChart3 },
    ],
  },
  {
    label: "콘텐츠",
    items: [
      { href: "/upload", label: "새 콘텐츠", icon: Wand2 },
      {
        href: "/postings",
        label: "배포 관리",
        icon: Send,
        badgeKind: "count",
      },
      { href: "/contents", label: "보관함", icon: Archive },
    ],
  },
  {
    label: "자동화",
    items: [
      {
        href: "/auto-reply",
        label: "DM 자동 응답",
        icon: MessageSquareReply,
        badgeKind: "soon",
      },
      {
        href: "/schedule-rules",
        label: "예약 규칙",
        icon: CalendarClock,
        badgeKind: "soon",
      },
    ],
  },
  {
    label: "설정",
    items: [
      { href: "/accounts", label: "계정 연동", icon: Link2 },
      { href: "/presets", label: "AI 프리셋", icon: Sparkles },
    ],
  },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

interface SidebarShellProps {
  userEmail: string | null;
  failedJobCount: number;
  children: React.ReactNode;
}

export function SidebarShell({
  userEmail,
  failedJobCount,
  children,
}: SidebarShellProps) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const renderBadge = (item: NavItem, active: boolean) => {
    if (item.badgeKind === "count") {
      if (failedJobCount <= 0) return null;
      const display = failedJobCount > 99 ? "99+" : String(failedJobCount);
      return (
        <span
          aria-label={`실패 ${failedJobCount}건`}
          className="ml-auto inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-destructive px-1.5 py-0.5 text-[10px] font-semibold leading-none text-destructive-foreground"
        >
          {display}
        </span>
      );
    }
    if (item.badgeKind === "soon") {
      return (
        <span
          aria-label="출시 예정"
          className={cn(
            "ml-auto inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none",
            "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
            active && "border-emerald-500/50",
          )}
        >
          soon
        </span>
      );
    }
    return null;
  };

  const navContent = (
    <nav aria-label="주요 메뉴" className="space-y-6">
      {NAV_GROUPS.map((group, idx) => (
        <div key={group.label ?? `top-${idx}`}>
          {group.label && (
            <p className="mb-2 px-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {group.label}
            </p>
          )}
          <ul className="space-y-1">
            {group.items.map((item) => {
              const Icon = item.icon;
              const active = isActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                      active
                        ? "bg-accent font-medium text-foreground"
                        : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden />
                    <span className="truncate">{item.label}</span>
                    {renderBadge(item, active)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  const userPanel = userEmail ? (
    <div className="border-t p-3">
      <p
        className="truncate px-3 py-1 text-xs text-muted-foreground"
        title={userEmail}
      >
        {userEmail}
      </p>
      <form action={signOut}>
        <button
          type="submit"
          className="mt-1 flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-muted-foreground transition hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <LogOut className="size-4 shrink-0" aria-hidden />
          <span>로그아웃</span>
        </button>
      </form>
    </div>
  ) : null;

  return (
    <div className="flex min-h-svh">
      {/* Desktop sidebar */}
      <aside
        aria-label="사이드바"
        className="hidden w-60 shrink-0 flex-col border-r bg-muted/20 md:flex"
      >
        <div className="flex h-14 items-center border-b px-6">
          <Link href="/" className="text-sm font-semibold">
            Multi-Content Bomber
          </Link>
        </div>
        <div className="flex-1 overflow-y-auto p-3">{navContent}</div>
        {userPanel}
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/40 md:hidden"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
          <aside
            aria-label="사이드바"
            className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-background shadow-lg md:hidden"
          >
            <div className="flex h-14 items-center justify-between border-b px-4">
              <Link href="/" className="text-sm font-semibold">
                Multi-Content Bomber
              </Link>
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label="메뉴 닫기"
                className="rounded-md p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
              >
                <XIcon className="size-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3">{navContent}</div>
            {userPanel}
          </aside>
        </>
      )}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="flex h-14 items-center justify-between border-b px-4 md:hidden">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="메뉴 열기"
            className="rounded-md p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            <Menu className="size-5" />
          </button>
          <Link href="/" className="text-sm font-semibold">
            MCB
          </Link>
          <div className="size-7" />
        </header>

        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}

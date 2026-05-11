"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ComponentType } from "react";
import {
  Archive,
  BarChart3,
  History,
  LayoutDashboard,
  Link2,
  ListChecks,
  LogOut,
  Menu,
  PlusCircle,
  Sparkles,
  XIcon,
} from "lucide-react";
import { signOut } from "@/app/(auth)/actions";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "현황",
    items: [
      { href: "/", label: "대시보드", icon: LayoutDashboard },
      { href: "/analytics", label: "분석/리포팅", icon: BarChart3 },
    ],
  },
  {
    label: "준비",
    items: [
      { href: "/accounts", label: "계정 관리", icon: Link2 },
      { href: "/presets", label: "프리셋", icon: Sparkles },
    ],
  },
  {
    label: "작업",
    items: [
      { href: "/upload", label: "새 콘텐츠", icon: PlusCircle },
      { href: "/postings", label: "포스팅 관리", icon: ListChecks },
      { href: "/uploads", label: "업로드 이력", icon: History },
      { href: "/contents", label: "보관함", icon: Archive },
    ],
  },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

interface SidebarShellProps {
  userEmail: string | null;
  children: React.ReactNode;
}

export function SidebarShell({ userEmail, children }: SidebarShellProps) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close mobile drawer whenever the route changes.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const navContent = (
    <nav className="space-y-6">
      {NAV_GROUPS.map((group) => (
        <div key={group.label}>
          <p className="mb-2 px-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {group.label}
          </p>
          <ul className="space-y-1">
            {group.items.map((item) => {
              const Icon = item.icon;
              const active = isActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={cn(
                      "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition",
                      active
                        ? "bg-accent font-medium text-foreground"
                        : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span>{item.label}</span>
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
          className="mt-1 flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-muted-foreground transition hover:bg-accent/40 hover:text-foreground"
        >
          <LogOut className="size-4 shrink-0" />
          <span>로그아웃</span>
        </button>
      </form>
    </div>
  ) : null;

  return (
    <div className="flex min-h-svh">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r bg-muted/20 md:flex">
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
          <aside className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-background shadow-lg md:hidden">
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

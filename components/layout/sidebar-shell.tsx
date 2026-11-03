"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ComponentType } from "react";
import {
  Archive,
  BarChart3,
  BellRing,
  CalendarCheck,
  CalendarClock,
  Clapperboard,
  Film,
  Link2,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquareReply,
  Package,
  Send,
  ShieldCheck,
  Sparkles,
  Video,
  Wand2,
  XIcon,
} from "lucide-react";
import { signOut } from "@/app/(auth)/actions";
import { cn } from "@/lib/utils";

// 앱 셸 — DESIGN.md 6장(Marketing Hub와 같은 구조): 240px 사이드바(로고 → 조직 카드 → 메뉴 묶음 → 사용자) +
// 60px 상단바(화면 이름 · 상태). 1024px 미만은 사이드바를 왼쪽에서 여는 260px 패널로.

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
      // 편성표(5단계) — 예전 "예약 규칙(준비 중)" 자리. 계정별 하루 칸 · 주제 · 주간 진행
      { href: "/schedule", label: "편성표", icon: CalendarClock },
      { href: "/analytics", label: "분석", icon: BarChart3 },
    ],
  },
  {
    label: "콘텐츠",
    items: [
      { href: "/upload", label: "콘텐츠 생성", icon: Wand2 },
      {
        href: "/postings",
        label: "배포 관리",
        icon: Send,
        badgeKind: "count",
      },
      { href: "/contents", label: "보관함", icon: Archive },
    ],
  },
  // AI 자동 콘텐츠(2026-11 신규) — 기존 메뉴와 섞지 않고 따로 묶는다(사용자 요청).
  // 메뉴 이름에 내부 용어(B 트랙 등)를 쓰지 않는다 — 처음 보는 사람도 뭘 하는 곳인지 알게.
  {
    label: "AI 자동 콘텐츠",
    items: [
      { href: "/auto/confirm", label: "AI 자동 업로드", icon: CalendarCheck },
      { href: "/products", label: "상품 분석", icon: Package },
      { href: "/rules", label: "광고 문구 규칙", icon: ShieldCheck },
    ],
  },
  // 직접 촬영 콘텐츠(2026-11 신규) — 12 · 18시 칸. 사람이 찍고 AI가 편집한다.
  {
    label: "직접 촬영 콘텐츠",
    items: [
      { href: "/shoot/plans", label: "촬영 기획 고르기", icon: Clapperboard },
      { href: "/shoot/uploads", label: "촬영 · 올리기", icon: Video },
      { href: "/shoot/review", label: "완성본 확인", icon: Film },
    ],
  },
  {
    label: "자동화",
    items: [
      {
        href: "/episode-alerts",
        label: "시리즈 댓글 자동화",
        icon: BellRing,
      },
      {
        href: "/auto-reply",
        label: "DM 자동 응답",
        icon: MessageSquareReply,
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

// 상단바 화면 이름 — 메뉴에 없는 화면(상세 · 온보딩 등)도 이름을 갖게
const EXTRA_TITLES: { prefix: string; title: string }[] = [
  { prefix: "/onboarding", title: "시작하기" },
  { prefix: "/uploads", title: "배포 관리" },
];

const ROLE_LABEL: Record<string, string> = { ADMIN: "관리자", MANAGER: "매니저", STAFF: "멤버" };

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function titleOf(pathname: string): string {
  for (const g of NAV_GROUPS) for (const it of g.items) if (isActive(pathname, it.href)) return it.label;
  return EXTRA_TITLES.find((t) => pathname.startsWith(t.prefix))?.title ?? "MCB";
}

interface SidebarShellProps {
  userEmail: string | null;
  failedJobCount: number;
  orgName: string | null;
  role: string | null;
  children: React.ReactNode;
}

export function SidebarShell({
  userEmail,
  failedJobCount,
  orgName,
  role,
  children,
}: SidebarShellProps) {
  const pathname = usePathname();
  // 연 화면 주소를 기억 — 다른 화면으로 가면 저절로 닫힌다(effect 없이)
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const mobileOpen = openedAt === pathname;
  const close = () => setOpenedAt(null);

  const renderBadge = (item: NavItem) => {
    if (item.badgeKind === "count") {
      if (failedJobCount <= 0) return null;
      const display = failedJobCount > 99 ? "99+" : String(failedJobCount);
      return (
        <span
          aria-label={`실패 ${failedJobCount}건`}
          className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-risk px-1.5 text-[11px] leading-5 font-bold text-white tabular-nums"
        >
          {display}
        </span>
      );
    }
    if (item.badgeKind === "soon") {
      return (
        <span
          aria-label="출시 예정"
          className="ml-auto inline-flex items-center rounded-full bg-surface-2 px-2 text-[11px] leading-5 font-semibold text-muted-foreground"
        >
          준비 중
        </span>
      );
    }
    return null;
  };

  const navContent = (
    <nav aria-label="주요 메뉴" className="flex flex-col gap-3">
      {NAV_GROUPS.map((group, idx) => (
        <div key={group.label ?? `top-${idx}`} className="flex flex-col gap-px">
          {group.label && (
            <p className="px-2.5 py-1 text-xs font-semibold text-faint">
              {group.label}
            </p>
          )}
          <ul className="flex flex-col gap-px">
            {group.items.map((item) => {
              const Icon = item.icon;
              const active = isActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={close}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex h-[42px] items-center gap-2.5 rounded-md px-2.5 text-sm font-medium transition-colors",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                      active
                        ? "bg-sidebar-accent font-semibold text-sidebar-accent-foreground"
                        : "text-ink-2 hover:bg-surface-2",
                    )}
                  >
                    <Icon className={cn("size-[18px] shrink-0", active ? "text-sidebar-accent-foreground" : "text-muted-foreground")} aria-hidden />
                    <span className="truncate">{item.label}</span>
                    {renderBadge(item)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  const brand = (
    <Link href="/" onClick={close} className="flex items-center gap-2.5 px-2 pt-1 pb-2">
      <span className="grid size-7 place-items-center rounded-md bg-primary">
        <Send className="size-[18px] text-primary-foreground" aria-hidden />
      </span>
      <span className="text-base font-bold tracking-[-0.01em]">MCB</span>
    </Link>
  );

  const orgCard = (
    <div className="flex w-full items-center gap-2.5 rounded-lg border bg-card p-2 text-left">
      <span className="grid size-7 shrink-0 place-items-center rounded-[7px] bg-surface-3 text-[13px] font-bold">
        {(orgName ?? "M").slice(0, 1)}
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <b className="truncate text-[13px]">{orgName ?? "조직 없음"}</b>
        <small className="text-xs text-muted-foreground">{role ? (ROLE_LABEL[role] ?? role) : ""}</small>
      </span>
    </div>
  );

  const userPanel = userEmail ? (
    <div className="mt-auto flex items-center gap-2.5 border-t px-2 pt-3">
      <span className="grid size-[30px] shrink-0 place-items-center rounded-full bg-brand-soft text-[13px] font-bold text-primary">
        {userEmail.slice(0, 1).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={userEmail}>
        {userEmail}
      </span>
      <form action={signOut}>
        <button
          type="submit"
          aria-label="로그아웃"
          title="로그아웃"
          className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <LogOut className="size-4" aria-hidden />
        </button>
      </form>
    </div>
  ) : null;

  const sidebarBody = (
    <>
      {brand}
      {orgCard}
      <div className="mt-1">{navContent}</div>
      {userPanel}
    </>
  );

  return (
    <div className="grid min-h-svh lg:grid-cols-[240px_minmax(0,1fr)]">
      {/* 데스크톱 사이드바 */}
      <aside
        aria-label="사이드바"
        className="sticky top-0 hidden h-svh flex-col gap-3 overflow-y-auto border-r bg-sidebar px-3 py-4 lg:flex"
      >
        {sidebarBody}
      </aside>

      {/* 1024px 미만: 왼쪽에서 여는 패널 */}
      {mobileOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-[rgb(10_14_22/.4)] lg:hidden"
            onClick={close}
            aria-hidden
          />
          <aside
            aria-label="사이드바"
            className="fixed inset-y-0 left-0 z-50 flex w-[260px] flex-col gap-3 overflow-y-auto bg-sidebar px-3 py-4 shadow-[0_8px_24px_rgb(16_24_40/.12),0_2px_6px_rgb(16_24_40/.08)] lg:hidden"
          >
            <button
              type="button"
              onClick={close}
              aria-label="메뉴 닫기"
              className="absolute top-3 right-3 grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
            >
              <XIcon className="size-5" />
            </button>
            {sidebarBody}
          </aside>
        </>
      )}

      {/* 본문 열 */}
      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex h-[60px] items-center gap-3 border-b bg-card px-4 sm:px-6">
          <button
            type="button"
            onClick={() => setOpenedAt(pathname)}
            aria-label="메뉴 열기"
            className="grid size-9 place-items-center rounded-md border border-input text-ink-2 transition-colors hover:bg-surface-2 lg:hidden"
          >
            <Menu className="size-[18px]" />
          </button>
          <p className="truncate text-lg font-bold tracking-[-0.01em]">{titleOf(pathname)}</p>
          <div className="ml-auto flex items-center gap-2">
            {failedJobCount > 0 && (
              <Link
                href="/postings"
                className="inline-flex h-7 items-center gap-1.5 rounded-full bg-risk-soft px-2.5 text-xs font-semibold whitespace-nowrap text-risk"
              >
                <span className="size-[7px] rounded-full bg-risk" aria-hidden />
                발행 실패 {failedJobCount > 99 ? "99+" : failedJobCount}건
              </Link>
            )}
          </div>
        </header>

        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}

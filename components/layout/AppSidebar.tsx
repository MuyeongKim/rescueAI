import Image from "next/image";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  CircleUser,
  BookOpen,
  FileText,
  Home,
  LogOut,
  Megaphone,
  MessageSquare,
  Newspaper,
  ShieldCheck,
  Wand2,
} from "lucide-react";

import { SidebarAccessStats } from "@/components/auth/LoginAccessStats";
import { MobileMoreSheet } from "@/components/layout/MobileMoreSheet";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { ADMIN_NAV_ITEMS } from "@/components/layout/admin-nav-items";
import { getLoginAccessStats } from "@/lib/login-access-stats";
import { cn } from "@/lib/utils";
import { hasRecentNotice } from "@/lib/notices";

export type NavKey =
  | "home"
  | "chat"
  | "generate"
  | "news"
  | "docs"
  | "me"
  | "guide"
  | "notices"
  | "admin"
  | "admin-news"
  | "admin-documents"
  | "admin-users"
  | "admin-notices";

type NavItem = {
  key: NavKey;
  href: string;
  label: string;
  icon: LucideIcon;
  mobile?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { key: "home", href: "/home", label: "홈", icon: Home, mobile: true },
  { key: "chat", href: "/chat", label: "AI 튜터", icon: MessageSquare, mobile: true },
  { key: "generate", href: "/generate", label: "AI 자료제작", icon: Wand2, mobile: true },
  { key: "docs", href: "/docs", label: "자료실", icon: FileText, mobile: true },
  { key: "news", href: "/news", label: "구조 동향", icon: Newspaper },
  { key: "notices", href: "/notices", label: "공지사항", icon: Megaphone },
  { key: "me", href: "/me", label: "마이페이지", icon: CircleUser },
  { key: "guide", href: "/guide", label: "사용설명서", icon: BookOpen },
];

const ADMIN_ITEMS = ADMIN_NAV_ITEMS;

export async function AppSidebar({
  email,
  isAdmin,
  active,
}: {
  email?: string | null;
  isAdmin?: boolean;
  active?: NavKey;
}) {
  const mobileItems = NAV_ITEMS.filter((item) => item.mobile);
  const [newNotice, accessStats] = await Promise.all([
    hasRecentNotice(),
    getLoginAccessStats(),
  ]);

  const renderItem = (item: {
    key: string;
    href: string;
    label: string;
    icon: LucideIcon;
  }) => {
    const Icon = item.icon;
    const isActive = active === item.key;

    return (
      <Link
        key={item.key}
        href={item.href}
        aria-current={isActive ? "page" : undefined}
        className={cn(
          "relative flex min-h-12 items-center gap-3 border-l-[3px] px-3 text-sm transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ops-signal-bright",
          isActive
            ? "border-l-ops-signal-bright bg-ops-panel font-semibold text-white"
            : "border-l-transparent text-slate-300 hover:bg-ops-panel-hover hover:text-white"
        )}
      >
        <Icon
          className={cn(
            "h-[18px] w-[18px] shrink-0",
            isActive ? "text-ops-signal-soft" : "text-slate-400"
          )}
          aria-hidden
        />
        <span className="truncate">{item.label}</span>
        {item.key === "notices" && newNotice && (
          <span className="ml-auto">
            <span className="sr-only">새 공지 있음</span>
            <span
              className="block h-2 w-2 rounded-full bg-ops-signal-soft shadow-[0_0_0_3px_rgba(255,119,82,0.12)]"
              aria-hidden
            />
          </span>
        )}
      </Link>
    );
  };

  return (
    <>
      <a
        href="#main-content"
        className="fixed left-3 top-3 z-[100] -translate-y-24 bg-ops-sidebar px-4 py-3 text-sm font-semibold text-white shadow-lg transition-transform focus:translate-y-0 focus:outline-none focus:ring-2 focus:ring-ops-signal-bright motion-reduce:transition-none"
      >
        본문으로 건너뛰기
      </a>
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col bg-ops-sidebar text-slate-200 md:flex">
        <div className="hazard-stripe h-1.5 shrink-0 text-ops-signal" aria-hidden />

        <header className="border-b border-slate-700/70 px-4 py-4">
          <Link
            href="/home"
            className="flex min-h-11 items-center gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ops-signal-bright"
          >
            <span className="flex h-10 w-[62px] shrink-0 items-center justify-center bg-white px-1.5">
              <Image src="/logo-jbfire.png" alt="전북소방 엠블럼" width={52} height={26} priority />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs text-slate-300">전북특별자치도 소방본부</span>
              <span className="mt-0.5 block truncate text-sm font-extrabold text-white">구조 AI</span>
            </span>
          </Link>
        </header>

        <nav aria-label="주 메뉴" className="flex flex-1 flex-col overflow-y-auto px-2 py-4">
          <p className="px-3 pb-2 text-xs font-semibold text-slate-400">주요 업무</p>
          <div className="space-y-0.5">{NAV_ITEMS.map(renderItem)}</div>

          {isAdmin && !active?.startsWith("admin") && (
            <>
              <p className="px-3 pb-2 pt-6 text-xs font-semibold text-slate-400">관리 업무</p>
              <div className="space-y-0.5">{ADMIN_ITEMS.map(renderItem)}</div>
            </>
          )}
        </nav>

        <footer className="app-sidebar-footer border-t border-slate-700/70 p-3">
          <SidebarAccessStats
            today={accessStats.today}
            total={accessStats.total}
          />
          <div className="sidebar-evidence-mode mb-2 flex min-h-10 items-center gap-2 border border-slate-700 bg-ops-navy-deep px-3 text-xs text-slate-300">
            <ShieldCheck className="h-4 w-4 text-ops-signal-soft" aria-hidden />
            교육자료 기반 모드
          </div>
          {email && (
            <p className="sidebar-user-email truncate px-3 py-1 text-xs text-slate-400">
              {email}
            </p>
          )}
          <ThemeToggle className="sidebar-theme-toggle h-11 w-full justify-start gap-3 px-3 text-sm text-slate-400 hover:bg-ops-panel-hover hover:text-white" />
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="flex h-11 w-full items-center gap-3 px-3 text-sm text-slate-400 transition-colors motion-reduce:transition-none hover:bg-ops-panel-hover hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ops-signal-bright"
            >
              <LogOut className="h-[18px] w-[18px] shrink-0" aria-hidden />
              로그아웃
            </button>
          </form>
        </footer>
      </aside>

      <nav
        aria-label="주 메뉴"
        className="fixed inset-x-0 bottom-0 z-30 border-t-2 border-ops-signal bg-ops-sidebar shadow-[0_-4px_16px_rgba(11,20,38,0.16)] md:hidden"
      >
        <div className="flex min-h-16 items-stretch justify-around px-1 pb-[env(safe-area-inset-bottom)]">
          {mobileItems.map((item) => {
            const Icon = item.icon;
            const isActive = active === item.key;
            return (
              <Link
                key={item.key}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "relative flex min-h-[56px] min-w-[56px] flex-1 flex-col items-center justify-center gap-1 px-1 text-slate-400 transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ops-signal-bright",
                  isActive && "bg-ops-panel font-semibold text-white"
                )}
              >
                {isActive && <span className="absolute inset-x-3 top-0 h-0.5 bg-ops-signal-soft" aria-hidden />}
                <Icon
                  className={cn("h-5 w-5", isActive && "text-ops-signal-soft")}
                  aria-hidden
                />
                <span className="whitespace-nowrap text-xs">{item.label}</span>
              </Link>
            );
          })}
          <MobileMoreSheet isAdmin={isAdmin} active={active} hasNewNotice={newNotice} />
        </div>
      </nav>
    </>
  );
}

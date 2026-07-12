import Image from "next/image";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  CircleUser,
  Dumbbell,
  FileText,
  Home,
  LogOut,
  MessageSquare,
  Newspaper,
  ShieldCheck,
  Siren,
  Wand2,
} from "lucide-react";

import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { MobileMoreSheet } from "@/components/layout/MobileMoreSheet";
import { ADMIN_NAV_ITEMS } from "@/components/layout/admin-nav-items";
import { cn } from "@/lib/utils";
import { hasRecentNotice } from "@/lib/notices";

export type NavKey =
  | "home"
  | "chat"
  | "generate"
  | "news"
  | "dispatch"
  | "docs"
  | "fitness"
  | "me"
  | "notices"
  | "admin"
  | "admin-news"
  | "admin-dispatch"
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
  { key: "dispatch", href: "/dispatch", label: "출동 마일리지", icon: Siren },
  { key: "fitness", href: "/fitness", label: "체력단련", icon: Dumbbell },
  { key: "me", href: "/me", label: "마이페이지", icon: CircleUser },
];

const ADMIN_ITEMS = ADMIN_NAV_ITEMS;

export async function AppSidebar({
  email,
  isAdmin,
  active,
  hideMobileNav,
}: {
  email?: string | null;
  isAdmin?: boolean;
  active?: NavKey;
  hideMobileNav?: boolean;
}) {
  const mobileItems = NAV_ITEMS.filter((item) => item.mobile);
  const newNotice = await hasRecentNotice();

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
          "relative flex min-h-12 items-center gap-3 border-l-[3px] px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#f0542d]",
          isActive
            ? "border-l-[#f0542d] bg-[#1a2a43] font-semibold text-white"
            : "border-l-transparent text-slate-300 hover:bg-[#17253b] hover:text-white"
        )}
      >
        <Icon className={cn("h-[18px] w-[18px] shrink-0", isActive ? "text-[#ff7752]" : "text-slate-400")} />
        <span className="truncate">{item.label}</span>
        {item.key === "home" && newNotice && (
          <span
            className="ml-auto h-2 w-2 rounded-full bg-[#ff7752] shadow-[0_0_0_3px_rgba(255,119,82,0.12)]"
            aria-label="새 공지 있음"
          />
        )}
      </Link>
    );
  };

  return (
    <>
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col bg-[#111d31] text-slate-200 md:flex">
        <div className="hazard-stripe h-1.5 shrink-0 text-[#d63f18]" aria-hidden />

        <header className="border-b border-slate-700/70 px-4 py-4">
          <Link
            href="/home"
            className="flex min-h-11 items-center gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f0542d]"
          >
            <span className="flex h-10 w-[62px] shrink-0 items-center justify-center bg-white px-1.5">
              <Image src="/logo-jbfire.png" alt="전북소방 엠블럼" width={52} height={26} priority />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[10px] text-slate-400">전북특별자치도 소방본부</span>
              <span className="mt-0.5 block truncate text-sm font-extrabold text-white">구조 AI</span>
            </span>
          </Link>
        </header>

        <nav aria-label="주 메뉴" className="flex flex-1 flex-col overflow-y-auto px-2 py-4">
          <p className="px-3 pb-2 text-[10px] font-semibold text-slate-500">주요 업무</p>
          <div className="space-y-0.5">{NAV_ITEMS.map(renderItem)}</div>

          {isAdmin && !active?.startsWith("admin") && (
            <>
              <p className="px-3 pb-2 pt-6 text-[10px] font-semibold text-slate-500">관리 업무</p>
              <div className="space-y-0.5">{ADMIN_ITEMS.map(renderItem)}</div>
            </>
          )}
        </nav>

        <footer className="border-t border-slate-700/70 p-3">
          <div className="mb-2 flex min-h-10 items-center gap-2 border border-slate-700 bg-[#0d192b] px-3 text-[11px] text-slate-300">
            <ShieldCheck className="h-4 w-4 text-[#ff7752]" aria-hidden />
            교육자료 기반 모드
          </div>
          {email && <p className="truncate px-3 py-1 text-[11px] text-slate-500">{email}</p>}
          <ThemeToggle className="h-11 w-full justify-start gap-3 px-3 text-sm text-slate-400 hover:bg-[#17253b] hover:text-white" />
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="flex h-11 w-full items-center gap-3 px-3 text-sm text-slate-400 transition-colors hover:bg-[#17253b] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#f0542d]"
            >
              <LogOut className="h-[18px] w-[18px] shrink-0" />
              로그아웃
            </button>
          </form>
        </footer>
      </aside>

      <nav
        aria-label="주 메뉴"
        className={cn(
          "fixed inset-x-0 bottom-0 z-30 border-t-2 border-[#d63f18] bg-[#111d31] shadow-[0_-4px_16px_rgba(11,20,38,0.16)] md:hidden",
          hideMobileNav && "hidden"
        )}
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
                  "relative flex min-h-[56px] min-w-[56px] flex-1 flex-col items-center justify-center gap-1 px-1 text-slate-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#f0542d]",
                  isActive && "bg-[#1a2a43] font-semibold text-white"
                )}
              >
                {isActive && <span className="absolute inset-x-3 top-0 h-0.5 bg-[#ff7752]" aria-hidden />}
                <Icon className={cn("h-5 w-5", isActive && "text-[#ff7752]")} />
                <span className="whitespace-nowrap text-[11px]">{item.label}</span>
              </Link>
            );
          })}
          <MobileMoreSheet isAdmin={isAdmin} active={active} />
        </div>
      </nav>
    </>
  );
}

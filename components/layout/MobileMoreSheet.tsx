"use client";

import Link from "next/link";
import {
  CircleUser,
  Megaphone,
  Menu,
  Newspaper,
  Users,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { ADMIN_NAV_ITEMS } from "@/components/layout/admin-nav-items";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

// 모바일 하단 탭바의 "더보기" — 탭(6개 제한)에 못 들어간 메뉴 전부의 진입점.
// 새 페이지를 만들면 여기(또는 탭)에 반드시 추가해 모바일 동선을 보장한다.
const MORE_ITEMS = [
  { key: "news", href: "/news", label: "구조 동향", icon: Newspaper },
  { key: "generate-shared", href: "/generate/shared", label: "공유 자료실", icon: Users },
  { key: "notices", href: "/notices", label: "공지사항", icon: Megaphone },
  { key: "me", href: "/me", label: "마이페이지", icon: CircleUser },
];

// 관리자 메뉴는 admin-nav-items 단일 출처 공유
const ADMIN_MORE_ITEMS = ADMIN_NAV_ITEMS;

export function MobileMoreSheet({
  isAdmin,
  active,
  hasNewNotice = false,
}: {
  isAdmin?: boolean;
  active?: string;
  hasNewNotice?: boolean;
}) {
  // 더보기에 속한 메뉴가 활성일 때 더보기 탭도 강조
  const moreActive = [...MORE_ITEMS, ...ADMIN_MORE_ITEMS].some(
    (i) => i.key === active
  );

  return (
    <Sheet>
      <SheetTrigger
        className={cn(
          "relative flex min-h-[56px] min-w-[56px] flex-1 flex-col items-center justify-center gap-1 px-1 text-slate-400 transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ops-signal-bright",
          moreActive && "bg-ops-panel font-semibold text-white"
        )}
        aria-label={hasNewNotice ? "더보기 메뉴, 새 공지 있음" : "더보기 메뉴"}
      >
        {moreActive && <span className="absolute inset-x-3 top-0 h-0.5 bg-ops-signal-soft" aria-hidden />}
        <span className="relative">
          <Menu className="h-5 w-5" aria-hidden="true" />
          {hasNewNotice && (
            <span
              className="absolute -right-1.5 -top-1.5 h-2 w-2 rounded-full bg-ops-signal-soft shadow-[0_0_0_2px_rgba(17,29,49,0.9)]"
              aria-hidden="true"
            />
          )}
        </span>
        <span className="whitespace-nowrap text-xs">
          더보기
        </span>
      </SheetTrigger>
      <SheetContent side="bottom" className="max-h-[75dvh] overflow-y-auto rounded-none border-t-4 border-t-primary">
        <SheetHeader className="text-left">
          <p className="text-xs font-bold text-primary">구조 업무 메뉴</p>
          <SheetTitle className="text-xl font-extrabold">전체 메뉴</SheetTitle>
          <SheetDescription>
            구조 업무와 개인·관리자 메뉴로 이동합니다.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-3 grid grid-cols-3 gap-2">
          {MORE_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = active === item.key;
            return (
              <SheetClose asChild key={item.key}>
                <Link
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "relative flex min-h-[76px] flex-col items-center justify-center gap-1.5 rounded-sm border p-3 text-center transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isActive
                      ? "border-primary bg-primary/5 text-primary"
                      : "text-foreground hover:bg-accent/40"
                  )}
                >
                  <Icon className="h-5 w-5" aria-hidden="true" />
                  <span className="text-xs">
                    {item.label}
                    {item.key === "notices" && hasNewNotice && (
                      <span className="sr-only">, 새 공지 있음</span>
                    )}
                  </span>
                  {item.key === "notices" && hasNewNotice && (
                    <span
                      className="absolute right-2 top-2 h-2.5 w-2.5 rounded-full bg-primary"
                      aria-hidden="true"
                    />
                  )}
                </Link>
              </SheetClose>
            );
          })}
        </div>

        {isAdmin && (
          <>
            <p className="mt-4 mb-2 text-xs font-medium text-muted-foreground">
              관리자
            </p>
            <div className="grid grid-cols-3 gap-2">
              {ADMIN_MORE_ITEMS.map((item) => {
                const Icon = item.icon;
                const isActive = active === item.key;
                return (
                  <SheetClose asChild key={item.key}>
                    <Link
                      href={item.href}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "flex min-h-[76px] flex-col items-center justify-center gap-1.5 rounded-sm border p-3 text-center transition-colors",
                        isActive
                          ? "border-primary bg-primary/5 text-primary"
                          : "text-foreground hover:bg-accent/40"
                      )}
                    >
                      <Icon className="h-5 w-5" aria-hidden="true" />
                      <span className="text-xs">{item.label}</span>
                    </Link>
                  </SheetClose>
                );
              })}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

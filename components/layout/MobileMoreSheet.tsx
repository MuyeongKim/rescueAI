"use client";

import Link from "next/link";
import {
  BarChart3,
  CircleUser,
  FileText,
  FolderCog,
  FolderOpen,
  Megaphone,
  Menu,
  Newspaper,
  Siren,
  Users,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

// 모바일 하단 탭바의 "더보기" — 탭(6개 제한)에 못 들어간 메뉴 전부의 진입점.
// 새 페이지를 만들면 여기(또는 탭)에 반드시 추가해 모바일 동선을 보장한다.
const MORE_ITEMS = [
  { key: "saved", href: "/generate/saved", label: "저장한 자료", icon: FolderOpen },
  { key: "news", href: "/news", label: "구조 동향", icon: Newspaper },
  { key: "dispatch", href: "/dispatch", label: "출동 마일리지", icon: Siren },
  { key: "docs", href: "/docs", label: "자료실", icon: FileText },
  { key: "notices", href: "/notices", label: "공지사항", icon: Megaphone },
  { key: "me", href: "/me", label: "마이페이지", icon: CircleUser },
];

const ADMIN_MORE_ITEMS = [
  { key: "admin", href: "/admin", label: "통계", icon: BarChart3 },
  { key: "admin-news", href: "/admin/news", label: "동향 관리", icon: Newspaper },
  { key: "admin-dispatch", href: "/admin/dispatch", label: "출동통계 분석", icon: Siren },
  { key: "admin-documents", href: "/admin/documents", label: "자료 관리", icon: FolderCog },
  { key: "admin-users", href: "/admin/users", label: "사용자 관리", icon: Users },
  { key: "admin-notices", href: "/admin/notices", label: "공지 작성", icon: Megaphone },
];

export function MobileMoreSheet({
  isAdmin,
  active,
}: {
  isAdmin?: boolean;
  active?: string;
}) {
  // 더보기에 속한 메뉴가 활성일 때 더보기 탭도 강조
  const moreActive = [...MORE_ITEMS, ...ADMIN_MORE_ITEMS].some(
    (i) => i.key === active
  );

  return (
    <Sheet>
      <SheetTrigger
        className={cn(
          "flex flex-col items-center gap-0.5 px-1.5 py-1.5 rounded-lg transition-colors min-w-[48px]",
          moreActive ? "text-primary" : "text-muted-foreground"
        )}
        aria-label="더보기 메뉴"
      >
        <Menu className="h-5 w-5" />
        <span className={cn("text-[11px] whitespace-nowrap", moreActive && "font-medium")}>
          더보기
        </span>
      </SheetTrigger>
      <SheetContent side="bottom" className="max-h-[75dvh] overflow-y-auto rounded-t-xl">
        <SheetHeader className="text-left">
          <SheetTitle>전체 메뉴</SheetTitle>
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
                    "flex min-h-[72px] flex-col items-center justify-center gap-1.5 rounded-lg border p-3 text-center transition-colors",
                    isActive
                      ? "border-primary bg-primary/5 text-primary"
                      : "text-foreground hover:bg-accent/40"
                  )}
                >
                  <Icon className="h-5 w-5" />
                  <span className="text-xs">{item.label}</span>
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
                        "flex min-h-[72px] flex-col items-center justify-center gap-1.5 rounded-lg border p-3 text-center transition-colors",
                        isActive
                          ? "border-primary bg-primary/5 text-primary"
                          : "text-foreground hover:bg-accent/40"
                      )}
                    >
                      <Icon className="h-5 w-5" />
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

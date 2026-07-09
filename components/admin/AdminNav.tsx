"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { ADMIN_NAV_ITEMS } from "@/components/layout/admin-nav-items";

// 관리자 하위 메뉴 탭. 모바일에서는 가로 스크롤. 메뉴 목록은 admin-nav-items 단일 출처.
export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="관리자 메뉴"
      className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur-sm supports-backdrop-filter:bg-background/60"
    >
      <div className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-3 sm:px-4">
        {ADMIN_NAV_ITEMS.map((t) => {
          const isActive = pathname === t.href;
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "whitespace-nowrap border-b-2 px-3 py-3 text-sm transition-colors",
                isActive
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

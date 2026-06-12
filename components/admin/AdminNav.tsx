"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/admin", label: "통계" },
  { href: "/admin/completion", label: "이수 현황" },
  { href: "/admin/dispatch", label: "출동통계 분석" },
  { href: "/admin/documents", label: "자료 관리" },
  { href: "/admin/users", label: "사용자 관리" },
  { href: "/admin/notices", label: "공지 작성" },
];

// 관리자 하위 메뉴 탭. 모바일에서는 가로 스크롤.
export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="관리자 메뉴"
      className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur-sm supports-backdrop-filter:bg-background/60"
    >
      <div className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-3 sm:px-4">
        {TABS.map((t) => {
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

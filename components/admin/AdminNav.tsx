"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { ADMIN_NAV_ITEMS } from "@/components/layout/admin-nav-items";

// 관리자 하위 메뉴 탭. 모바일에서는 가로 스크롤. 메뉴 목록은 admin-nav-items 단일 출처.
export function AdminNav() {
  const pathname = usePathname();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollControls = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    setCanScrollLeft(node.scrollLeft > 4);
    setCanScrollRight(node.scrollLeft + node.clientWidth < node.scrollWidth - 4);
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    node
      .querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "center" });
    updateScrollControls();

    const observer = new ResizeObserver(updateScrollControls);
    observer.observe(node);
    window.addEventListener("resize", updateScrollControls);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateScrollControls);
    };
  }, [pathname, updateScrollControls]);

  function scrollTabs(direction: -1 | 1) {
    scrollRef.current?.scrollBy({ left: direction * 180, behavior: "smooth" });
  }

  return (
    <nav
      aria-label="관리자 메뉴"
      className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur-sm supports-backdrop-filter:bg-background/60"
    >
      <div className="relative mx-auto max-w-5xl">
        <div
          ref={scrollRef}
          onScroll={updateScrollControls}
          className="flex gap-1 overflow-x-auto px-3 pr-14 [scrollbar-width:none] sm:px-4 sm:pr-4 [&::-webkit-scrollbar]:hidden"
        >
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

        {canScrollLeft && (
          <button
            type="button"
            onClick={() => scrollTabs(-1)}
            className="absolute inset-y-0 left-0 flex w-11 items-center justify-center border-r bg-background text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:hidden"
            aria-label="이전 관리자 메뉴 보기"
          >
            <ChevronLeft className="h-5 w-5" aria-hidden />
          </button>
        )}
        {canScrollRight && (
          <button
            type="button"
            onClick={() => scrollTabs(1)}
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center border-l bg-background text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:hidden"
            aria-label="다음 관리자 메뉴 보기"
          >
            <ChevronRight className="h-5 w-5" aria-hidden />
          </button>
        )}
      </div>
    </nav>
  );
}

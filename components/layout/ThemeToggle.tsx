"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

// 라이트/다크 전환. 야간 대기·출동 환경을 고려해 사이드바와 마이페이지에 노출한다.
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const dark = mounted && resolvedTheme === "dark";
  return (
    <Button
      type="button"
      variant="ghost"
      className={className ?? "w-full justify-start gap-2 h-10 px-3 text-sm text-muted-foreground"}
      onClick={() => setTheme(dark ? "light" : "dark")}
      aria-label={dark ? "라이트 모드로 전환" : "다크 모드로 전환"}
    >
      {dark ? <Sun className="h-4 w-4 shrink-0" /> : <Moon className="h-4 w-4 shrink-0" />}
      {mounted ? (dark ? "라이트 모드" : "다크 모드") : "테마"}
    </Button>
  );
}

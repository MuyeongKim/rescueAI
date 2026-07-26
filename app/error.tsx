"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

// 전역 에러 화면. 개별 화면에서 잡지 못한 런타임 오류를 받아낸다.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app] 처리되지 않은 오류:", error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangle className="h-7 w-7 text-destructive" />
      </span>
      <div>
        <h1 className="text-lg font-semibold">일시적인 오류가 발생했습니다</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          잠시 후 다시 시도해 주세요. 문제가 계속되면 관리자에게 문의하세요.
        </p>
      </div>
      <div className="flex gap-2">
        <Button onClick={reset} className="h-11 gap-1.5">
          <RotateCcw className="h-4 w-4" /> 다시 시도
        </Button>
        <Button asChild variant="outline" className="h-11">
          <Link href="/home">홈으로</Link>
        </Button>
      </div>
    </div>
  );
}

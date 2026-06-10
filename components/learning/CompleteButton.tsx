"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Circle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export function CompleteButton({
  documentId,
  initialCompleted,
  variant = "full",
}: {
  documentId: number;
  initialCompleted: boolean;
  variant?: "full" | "icon";
}) {
  const router = useRouter();
  const [done, setDone] = useState(initialCompleted);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    const next = !done;
    setBusy(true);
    try {
      const res = await fetch("/api/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId, completed: next }),
      });
      if (!res.ok) throw new Error(await res.text());
      setDone(next);
      toast.success(next ? "학습 완료로 표시했습니다" : "완료를 해제했습니다");
      router.refresh();
    } catch (e) {
      toast.error("저장 실패", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }

  if (variant === "icon") {
    return (
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        aria-label={done ? "완료됨" : "학습 완료 표시"}
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors",
          done ? "text-primary" : "text-muted-foreground hover:text-foreground"
        )}
      >
        {busy ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : done ? (
          <CheckCircle2 className="h-5 w-5" />
        ) : (
          <Circle className="h-5 w-5" />
        )}
      </button>
    );
  }

  return (
    <Button
      onClick={toggle}
      disabled={busy}
      variant={done ? "secondary" : "default"}
      className="h-11 shrink-0 gap-2"
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <CheckCircle2 className="h-4 w-4" />
      )}
      <span className="hidden sm:inline">{done ? "학습 완료됨" : "학습 완료"}</span>
      <span className="sm:hidden">{done ? "완료" : "완료"}</span>
    </Button>
  );
}

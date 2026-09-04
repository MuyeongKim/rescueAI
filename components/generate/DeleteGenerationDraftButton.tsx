"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function DeleteGenerationDraftButton({ id, updatedAt, title }: { id: string; updatedAt: string; title: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const deleting = useRef(false);
  async function removeDraft() {
    if (deleting.current || !window.confirm(`‘${title}’의 개인 편집 초안을 삭제할까요?\n보관된 편집 내용이 삭제됩니다. 정식 저장 자료와 제작 작업은 유지됩니다.`)) return;
    deleting.current = true;
    setBusy(true);
    try {
      const response = await fetch("/api/generate/drafts", { method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, updatedAt }), signal: AbortSignal.timeout(15_000) });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? "편집 초안을 삭제하지 못했습니다.");
      toast.success("개인 편집 초안을 삭제했습니다");
      router.refresh();
    } catch (error) {
      toast.error("초안 삭제를 완료하지 못했습니다", { description: error instanceof Error ? error.message : "연결 상태를 확인해 주세요." });
    } finally {
      deleting.current = false;
      setBusy(false);
    }
  }
  return <Button type="button" variant="outline" className="min-h-12 shrink-0 text-sm" disabled={busy}
    aria-label={`${title} 초안 삭제`} onClick={() => void removeDraft()}>{busy ? "삭제 중…" : "초안 삭제"}</Button>;
}

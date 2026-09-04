"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

// 자동 수집 수동 트리거 (관리자). Cron과 같은 /api/news/refresh 를 호출.
export function NewsRefreshButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const res = await fetch("/api/news/refresh", { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      const r = await res.json();
      const summary = `${r.added}건 추가 (검토 ${r.scanned}건)`;
      const details: string[] = [];
      if (r.feedFailures > 0) details.push(`일부 수집 실패: RSS ${r.feedFailures}개를 불러오지 못했습니다.`);
      if (r.summariesMissing > 0) details.push(`요약 없이 제목만 등록: ${r.summariesMissing}건입니다.`);
      if (r.period?.from && r.period?.to) details.push(`수집 기간: ${r.period.from} ~ ${r.period.to}`);
      if (r.feedFailures > 0 || r.summariesMissing > 0) {
        toast.warning(`수집 결과 확인 필요 — ${summary}`, { description: details.join(" ") });
      } else {
        toast.success(`수집 완료 — ${summary}`, { description: details.join(" ") || undefined });
      }
      router.refresh();
    } catch (e) {
      toast.error("수집 실패", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={run} disabled={busy}>
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
      지금 수집
    </Button>
  );
}

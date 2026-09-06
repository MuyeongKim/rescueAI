"use client";

import type { DocumentSectionEvidenceState } from "@/lib/document-evidence";
import { GeneratedSourceLink } from "@/components/generate/GeneratedSourceLink";
import { Button } from "@/components/ui/button";

export function DocumentSectionEvidence({ heading, state, onLoad }: {
  heading: string;
  state?: DocumentSectionEvidenceState;
  onLoad: () => void;
}) {
  return <details className="rounded-lg border border-border/60 bg-muted/10" onToggle={(event) => {
    if (event.currentTarget.open && (!state || state.status === "idle")) onLoad();
  }}>
    <summary className="min-h-12 cursor-pointer px-3 py-3 text-base font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{heading} 근거 보기</summary>
    <div className="space-y-3 border-t p-3">
      <p className="text-sm text-muted-foreground">본문과 관련된 원문 구절입니다. 문장 전체의 사실성 판정은 아니므로 적용 조건을 원본에서 함께 확인하세요.</p>
      {state?.status === "loading" && <p role="status" className="text-base">원문을 확인하고 있습니다…</p>}
      {state?.status === "error" && <div className="space-y-2"><p role="alert" className="text-base">{state.error || "원문을 불러오지 못했습니다."}</p><Button type="button" variant="outline" className="min-h-12 text-base" onClick={onLoad}>다시 확인</Button></div>}
      {state?.status === "ready" && ((state.items?.length ?? 0) > 0
        ? <ul className="space-y-3">{state.items!.map((item, index) => <li key={`${item.source.document_id}:${item.source.page}:${index}`} className="rounded-md border bg-background p-3">
          <GeneratedSourceLink source={item.source} />
          <blockquote className="mt-2 whitespace-pre-wrap break-words border-l-2 pl-3 text-base leading-relaxed">{item.excerpt}</blockquote>
        </li>)}</ul>
        : <p className="text-base">이 항목과 연결할 원문 구절을 확인하지 못했습니다. 문서 하단의 출처 목록에서 원본을 확인해 주세요.</p>)}
    </div>
  </details>;
}

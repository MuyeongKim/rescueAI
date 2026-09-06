"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function RegenerationComparison({ before, after, issues, onApply, onCancel }: {
  before: string;
  after: string;
  issues: string[];
  onApply: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="flex max-h-[90dvh] max-w-5xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>다시 생성한 내용 비교</DialogTitle>
          <DialogDescription>기존 내용은 아직 바뀌지 않았습니다. 변경 내용을 확인한 뒤 적용해 주세요.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto">
          <div className="grid gap-4 md:grid-cols-2">
            {[{ title: "변경 전", text: before }, { title: "변경 후", text: after }].map((item) => (
              <section key={item.title} className="min-w-0 rounded-xl border p-4">
                <h3 className="mb-3 font-semibold">{item.title}</h3>
                <p className="whitespace-pre-wrap break-words text-base leading-relaxed">{item.text}</p>
              </section>
            ))}
          </div>
          {issues.length > 0 && (
            <section className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:bg-amber-950 dark:text-amber-100" aria-label="전체 자료 재검사 결과">
              <h3 className="font-semibold">적용 후 확인할 항목</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>
              <p className="mt-2 text-sm">핵심 품질 오류가 남으면 공식 저장·다운로드는 제한됩니다.</p>
            </section>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" className="min-h-12" onClick={onCancel}>기존 내용 유지</Button>
          <Button type="button" className="min-h-12" onClick={onApply}>변경 내용 적용</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

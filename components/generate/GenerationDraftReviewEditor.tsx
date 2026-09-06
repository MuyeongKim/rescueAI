"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { PublicGenerationJob } from "@/lib/generation-job";

type ReviewText = {
  title: string;
  sections?: { heading: string; content: string }[];
  slides?: { title: string; bullets: string[]; notes: string; steps?: string[]; hasDiagram?: boolean; clearDiagram?: boolean }[];
};

/** 미검증 초안은 완성본 편집기와 분리한다. 닫아도 이 작업 화면에 있는 동안 수정 내용은 유지한다. */
export function GenerationDraftReviewEditor({ job, open, busy, onOpenChange, onSubmit }: {
  job: PublicGenerationJob;
  open: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (draft: Record<string, unknown>, revision: number) => void;
}) {
  const readDraft = (): ReviewText => {
    const source = job.reviewDraft ?? {};
    return {
      title: typeof source.title === "string" ? source.title : "",
      ...(job.request.type === "slides"
        ? { slides: (Array.isArray(source.slides) ? source.slides : []).map((item) => ({
            title: String(item.title ?? ""), bullets: Array.isArray(item.bullets) ? item.bullets.map(String) : [], notes: String(item.notes ?? ""),
            steps: Array.isArray(item.steps) ? item.steps.map(String) : undefined, hasDiagram: Boolean(item.diagram),
          })) }
        : { sections: (Array.isArray(source.sections) ? source.sections : []).map((item) => ({
            heading: String(item.heading ?? ""), content: String(item.content ?? ""),
          })) }),
    };
  };
  const [draft, setDraft] = useState<ReviewText>(readDraft);
  const [baseRevision, setBaseRevision] = useState(job.revision);
  const stale = job.revision !== baseRevision;
  const canReview = ["needs_attention", "failed", "cancelled"].includes(job.status);

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!busy) onOpenChange(value); }}>
      <DialogContent className="flex max-h-[90dvh] max-w-4xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>보완할 초안 검토</DialogTitle>
          <DialogDescription>수정한 초안을 서버에 보관하고 전체 근거·품질 검사를 다시 실행합니다. 통과 전에는 공식 저장·공유·다운로드할 수 없습니다.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
        <fieldset disabled={busy} className="min-w-0 space-y-4">
          <legend className="sr-only">미검증 초안 수정</legend>
          {stale && <div role="alert" className="space-y-2 rounded-xl border border-amber-400 bg-amber-50 p-4 text-amber-950 dark:bg-amber-950 dark:text-amber-100">
            <p>다른 화면에서 이 작업이 변경되었습니다. 이 화면에서 작성한 내용은 그대로 보존했습니다. 최신 작업 상태를 확인한 뒤 다시 검토해 주세요.</p>
            {job.reviewDraft && canReview && <Button type="button" variant="outline" className="min-h-12" onClick={() => {
              if (!window.confirm("현재 작성한 검토 내용을 최신 초안으로 바꿀까요?")) return;
              setDraft(readDraft()); setBaseRevision(job.revision);
            }}>최신 초안 불러오기</Button>}
          </div>}
          <label className="block space-y-2 font-medium">자료 제목
            <Input value={draft.title} maxLength={100} className="min-h-12 text-base" onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
          </label>
          {job.qualityIssues?.length ? <ul className="space-y-2 rounded-xl border bg-muted/30 p-4 text-sm">
            {job.qualityIssues.filter((issue) => issue.blocking).map((issue, index) => <li key={index}>{issue.message} — {issue.suggestion}</li>)}
          </ul> : null}
          {draft.sections?.map((section, index) => <label className="block space-y-2 font-medium" key={index}>
            {index + 1}. {section.heading}
            <Textarea value={section.content} maxLength={20_000} className="min-h-56 text-base leading-relaxed" onChange={(event) => setDraft({ ...draft, sections: draft.sections!.map((item, position) => position === index ? { ...item, content: event.target.value } : item) })} />
          </label>)}
          {draft.slides?.map((slide, index) => <section key={index} className="space-y-3 rounded-xl border p-4">
            <h3 className="font-semibold">슬라이드 {index + 1}</h3>
            <label className="block space-y-1">제목<Input value={slide.title} maxLength={120} className="min-h-12 text-base" onChange={(event) => setDraft({ ...draft, slides: draft.slides!.map((item, position) => position === index ? { ...item, title: event.target.value } : item) })} /></label>
            {slide.bullets.map((bullet, bulletIndex) => <label className="block space-y-1" key={bulletIndex}>핵심 문장 {bulletIndex + 1}<Textarea value={bullet} maxLength={500} className="text-base" onChange={(event) => setDraft({ ...draft, slides: draft.slides!.map((item, position) => position === index ? { ...item, bullets: item.bullets.map((text, position) => position === bulletIndex ? event.target.value : text) } : item) })} /></label>)}
            {slide.steps?.map((step, stepIndex) => <label className="block space-y-1" key={`step-${stepIndex}`}>단계·조건 {stepIndex + 1}<Textarea value={step} maxLength={100} className="text-base" onChange={(event) => setDraft({ ...draft, slides: draft.slides!.map((item, position) => position === index ? { ...item, steps: item.steps!.map((text, position) => position === stepIndex ? event.target.value : text) } : item) })} /></label>)}
            {slide.hasDiagram && <div className="space-y-2 rounded-lg bg-muted/40 p-3 text-sm">
              <p>핵심 문장이나 단계·조건을 수정하면 기존 도식 연결을 해제하고 전체 근거를 다시 검토합니다.</p>
              <Button type="button" variant="outline" className="min-h-12" disabled={slide.clearDiagram} onClick={() => setDraft({ ...draft, slides: draft.slides!.map((item, position) => position === index ? { ...item, clearDiagram: true } : item) })}>{slide.clearDiagram ? "도식 해제 후 재검토 예정" : "도식을 해제하고 본문으로 검토"}</Button>
            </div>}
            <label className="block space-y-1">교관 설명<Textarea value={slide.notes} maxLength={16_000} className="min-h-40 text-base" onChange={(event) => setDraft({ ...draft, slides: draft.slides!.map((item, position) => position === index ? { ...item, notes: event.target.value } : item) })} /></label>
          </section>)}
        </fieldset>
        </div>
        <DialogFooter className="shrink-0 gap-2">
          <Button type="button" variant="outline" className="min-h-12" disabled={busy} onClick={() => onOpenChange(false)}>화면으로 돌아가기</Button>
          <Button type="button" className="min-h-12" disabled={busy || stale || !canReview || draft.title.trim().length < 4} onClick={() => onSubmit(draft, baseRevision)}>{busy ? "초안 보관·재검토 요청 중…" : "수정 초안 저장 후 재검토"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

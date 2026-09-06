"use client";

import type { SlideLayoutIssue } from "@/lib/slide-layout";
import { Button } from "@/components/ui/button";

export function slideIssueLocation(path: string): { slideIndex: number | null; label: string; fieldId?: string } {
  const match = /^slides\.(\d+)(?:\.(.*))?$/.exec(path);
  if (!match) return { slideIndex: null, label: path === "title" ? "표지 · 발표 제목" : /^sources\./.test(path) ? "근거 자료 목록" : "전체 자료", fieldId: path === "title" ? "slide-deck-title" : undefined };
  const slideIndex = Number(match[1]);
  const field = match[2] ?? "";
  const bullet = /^bullets\.(\d+)/.exec(field);
  const step = /^steps\.(\d+)/.exec(field);
  return {
    slideIndex,
    label: `슬라이드 ${slideIndex + 1} · ${bullet ? `핵심 내용 ${Number(bullet[1]) + 1}` : step ? `단계 ${Number(step[1]) + 1}` : field === "title" ? "제목" : field.startsWith("diagram") ? "도식 연결" : "화면 구성"}`,
    fieldId: bullet ? `slide-bullet-${slideIndex}-${bullet[1]}` : step ? `slide-steps-${slideIndex}` : field === "title" ? `slide-title-${slideIndex}` : field.startsWith("diagram") ? `slide-diagram-${slideIndex}` : undefined,
  };
}

export function SlideLayoutIssues({ issues, disabled, onSelect }: {
  issues: readonly SlideLayoutIssue[]; disabled: boolean; onSelect: (path: string) => void;
}) {
  if (issues.length === 0) return null;
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const list = (items: readonly SlideLayoutIssue[]) => <ul className="space-y-3">{items.map((issue, index) => {
    const location = slideIssueLocation(issue.path);
    return <li key={`${issue.path}:${issue.code}:${index}`} className="rounded-md border bg-background p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1 text-base leading-relaxed">
          <p className="font-semibold">{location.label}</p>
          <p className="break-words">{issue.message}</p>
        </div>
        {(location.slideIndex !== null || issue.path === "title") && <Button type="button" variant="outline" className="min-h-12 shrink-0 bg-background text-base" disabled={disabled}
          aria-label={`${location.label} 수정으로 이동`} onClick={() => onSelect(issue.path)}>수정하기</Button>}
      </div>
      {/^sources\./.test(issue.path) && <p className="mt-2 text-sm leading-relaxed text-muted-foreground">출처명은 검증된 원문 제목입니다. 화면에서 임의로 줄이지 않으며 자료 관리자에게 제목 확인을 요청해 주세요.</p>}
    </li>;
  })}</ul>;
  return <section id="slide-layout-check" aria-label="슬라이드 글자와 도식 확인" className="space-y-3">
    {errors.length > 0 && <div role="alert" className="space-y-3 rounded-lg border border-red-300 bg-red-50 p-3 text-red-950 dark:border-red-900 dark:bg-red-950/30 dark:text-red-100">
      <div className="space-y-1 text-base leading-relaxed"><h3 className="font-semibold">PPTX 다운로드 전에 {errors.length}개 표시 항목을 수정해 주세요.</h3>
        <p>글자가 들어갈 공간이 부족한 위치를 표시했습니다. 내용을 다듬거나 표현 방식을 바꾼 뒤 다시 확인하세요.</p></div>
      {list(errors)}
    </div>}
    {warnings.length > 0 && <details className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
      <summary className="flex min-h-12 cursor-pointer items-center text-base font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">표현 방식 확인 {warnings.length}개</summary>
      <p className="mb-3 text-base leading-relaxed">연결이 확인되지 않은 도식은 원래 내용을 보존해 일반 배치로 보여 줍니다.</p>{list(warnings)}
    </details>}
  </section>;
}

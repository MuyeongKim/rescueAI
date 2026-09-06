"use client";

import type { GeneratedSection } from "@/lib/generate";
import { documentSectionBlocks, evaluationTableRows, replaceDocumentSpan, trainingTableRows } from "@/lib/document-structure";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export function DocumentSectionBody({ section, index, editing, disabled, onChange }: {
  section: GeneratedSection;
  index: number;
  editing: boolean;
  disabled: boolean;
  onChange: (content: string) => void;
}) {
  const trainingRows = trainingTableRows(section);
  const evaluationRows = evaluationTableRows(section);
  const structured = trainingRows.length > 0 || evaluationRows.length > 0;
  const rawEditor = <Textarea value={section.content} onChange={(event) => onChange(event.target.value)} disabled={disabled}
    className="min-h-[160px] text-base leading-relaxed" aria-label={`섹션 ${index + 1} 본문`} />;
  if (!editing) return <div className="space-y-3">{documentSectionBlocks(section).map((block, blockIndex) => block.type === "text"
    ? <p key={blockIndex} className="whitespace-pre-wrap break-words text-base leading-relaxed">{block.text}</p>
    : <div key={blockIndex} role="region" aria-label={`${section.heading} 표`} tabIndex={0} className="overflow-x-auto rounded-lg border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <table className="w-full min-w-[560px] border-collapse text-left text-base">
        <caption className="sr-only">{section.heading}</caption>
        <thead className="bg-muted/50"><tr>{block.headers.map((header) => <th key={header} scope="col" className="border-b p-3 font-semibold">{header}</th>)}</tr></thead>
        <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex} className="border-b last:border-b-0">{row.map((cell, cellIndex) => <td key={cellIndex} className="whitespace-pre-wrap break-words p-3 align-top leading-relaxed">{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>)}</div>;

  return <div className="space-y-3">
    {trainingRows.length > 0 && <div className="space-y-3" aria-label={`${section.heading} 시간표 편집`}>
      <p className="text-sm text-muted-foreground">단계별 시간과 진행 내용을 수정할 수 있습니다. 총 시간은 저장 전에 다시 확인합니다.</p>
      {trainingRows.map((row, rowIndex) => <fieldset key={rowIndex} disabled={disabled} className="space-y-3 rounded-lg border bg-muted/10 p-3">
        <legend className="px-1 text-base font-semibold">{row.name}</legend>
        <label className="flex items-center gap-2 text-base"><span>배정 시간</span><Input key={row.minutes} defaultValue={row.minutes} inputMode="numeric" className="min-h-12 w-24 text-base" aria-label={`${section.heading} ${row.name} 배정 시간 분`}
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (/^\d{1,4}$/.test(value) && Number(value) <= 1440) onChange(replaceDocumentSpan(section.content, row.minutesSpan, String(Number(value))));
            else event.target.value = row.minutes;
          }} /><span>분</span></label>
        <label className="block space-y-1 text-base"><span>교관·대원 행동 및 확인</span><Textarea value={row.body} disabled={disabled} className="min-h-40 text-base leading-relaxed"
          onChange={(event) => onChange(replaceDocumentSpan(section.content, row.bodySpan, event.target.value))} /></label>
      </fieldset>)}
    </div>}
    {evaluationRows.length > 0 && <div className="space-y-3" aria-label={`${section.heading} 평가표 편집`}>
      {evaluationRows.map((row, rowIndex) => <fieldset key={rowIndex} disabled={disabled} className="grid gap-3 rounded-lg border bg-muted/10 p-3 sm:grid-cols-2">
        <legend className="px-1 text-base font-semibold">평가항목 {rowIndex + 1}</legend>
        {["평가항목", "관찰 가능한 수행 기준", "통과 판단", "미달 시 피드백·재수행"].map((label, cellIndex) => <label key={label} className="space-y-1 text-base"><span>{label}</span>
          <Input value={row.cells[cellIndex]} className="min-h-12 text-base" disabled={disabled} onChange={(event) => onChange(replaceDocumentSpan(section.content, row.spans[cellIndex], event.target.value))} /></label>)}
      </fieldset>)}
    </div>}
    {structured ? <details className="rounded-lg border"><summary className="min-h-12 cursor-pointer px-3 py-3 text-base font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">전체 본문 편집</summary><div className="border-t p-3">{rawEditor}</div></details> : rawEditor}
  </div>;
}

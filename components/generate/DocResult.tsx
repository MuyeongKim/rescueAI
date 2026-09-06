"use client";

// 훈련계획·교안 결과 카드 — 미리보기 · 섹션 편집 · 섹션별 AI 재생성 · hwpx/docx/텍스트 내보내기.
import { Check, Copy, Download, FileText, Loader2 } from "lucide-react";

import type { GeneratedDoc, GeneratedSection } from "@/lib/generate";
import { docToText } from "@/lib/generate-material";
import { documentMetadataLines, prepareGeneratedDocForExport, type DocumentMetadata } from "@/lib/document-export";
import type { DocumentSectionEvidenceState } from "@/lib/document-evidence";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { GeneratedSourceLink } from "@/components/generate/GeneratedSourceLink";
import { DocumentSectionBody } from "@/components/generate/DocumentSectionBody";
import { DocumentSectionEvidence } from "@/components/generate/DocumentSectionEvidence";
import {
  AccentBar,
  EditToggleButton,
  QualityBanner,
  RegenControls,
  SaveButton,
  type RegenState,
  type GenerationQuality,
  type ResultChrome,
} from "@/components/generate/parts";

export function DocResult({
  doc,
  chrome,
  regen,
  copied,
  onTitleChange,
  onPatchSection,
  onDownloadHwpx,
  onDownloadDocx,
  onCopy,
  exporting,
  quality,
  planDetails,
  onPlanDetailsChange,
  documentMetadata,
  sectionEvidence,
  onLoadSectionEvidence,
}: {
  doc: GeneratedDoc;
  chrome: ResultChrome;
  regen: RegenState;
  copied: boolean;
  onTitleChange: (title: string) => void;
  onPatchSection: (index: number, patch: Partial<GeneratedSection>) => void;
  onDownloadHwpx: () => void;
  onDownloadDocx: () => void;
  onCopy: (text: string) => void;
  exporting: "hwpx" | "docx" | null;
  quality?: GenerationQuality | null;
  planDetails?: { date: string; place: string };
  onPlanDetailsChange?: (patch: Partial<{ date: string; place: string }>) => void;
  documentMetadata?: DocumentMetadata;
  sectionEvidence?: Record<number, DocumentSectionEvidenceState>;
  onLoadSectionEvidence?: (index: number) => void;
}) {
  const { accent, editing } = chrome;
  // 이전 저장본에 남은 인라인 인용도 화면에서는 숨기고, 마지막 출처 목록으로만 보여 준다.
  const displayDoc = prepareGeneratedDocForExport(doc);
  const metadata = { ...documentMetadata, ...planDetails };
  const visibleMetadata = documentMetadataLines({ ...metadata, date: undefined, place: undefined });
  const editorLocked =
    chrome.saving || Boolean(chrome.locked) || regen.loadingIndex !== null || exporting !== null;
  const outputBlocked = Boolean(chrome.outputBlocked);
  const statusMessage = exporting
    ? `${exporting === "hwpx" ? "한글" : "워드"} 파일을 준비하고 있습니다.`
    : chrome.saving
    ? "자료를 저장하고 있습니다."
    : regen.loadingIndex !== null
      ? `섹션 ${regen.loadingIndex + 1}을 다시 생성하고 있습니다.`
      : "";

  return (
    <Card
      className={cn(
        "animate-in fade-in slide-in-from-bottom-3 overflow-hidden border-border/60 shadow-sm duration-500 motion-reduce:animate-none",
        editing && "ring-1 ring-primary/40"
      )}
    >
      <AccentBar accent={accent} />
      <CardHeader className="pb-3">
        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-start sm:justify-between">
          {editing ? (
            <Input
              value={displayDoc.title}
              onChange={(e) => onTitleChange(e.target.value)}
              disabled={editorLocked}
              className="h-9 text-base font-semibold"
              aria-label="문서 제목"
            />
          ) : (
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-4 w-4" style={{ color: accent }} /> {displayDoc.title}
            </CardTitle>
          )}
          <div className="flex shrink-0 items-center gap-1.5 self-end sm:self-auto">
            <SaveButton chrome={chrome} />
            <EditToggleButton chrome={chrome} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {statusMessage}
        </p>
        <QualityBanner quality={quality} />
        {visibleMetadata.length > 0 && <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-lg border bg-muted/20 p-3 text-base" aria-label="현재 문서 제작 조건">{visibleMetadata.map((line) => <p key={line}>{line}</p>)}</div>}
        {planDetails && (
          <section className="rounded-lg border bg-muted/20 p-3" aria-label="현재 훈련계획 일자와 장소">
            {editing ? <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-base">이 문서의 훈련 일자
                <Input type="date" value={planDetails.date} disabled={editorLocked}
                  onInput={(e) => onPlanDetailsChange?.({ date: e.currentTarget.value })}
                  onChange={(e) => onPlanDetailsChange?.({ date: e.currentTarget.value })}
                  className="min-h-12 text-base" />
              </label>
              <label className="space-y-1 text-base">이 문서의 훈련 장소<Input value={planDetails.place} maxLength={100} disabled={editorLocked} onChange={(e) => onPlanDetailsChange?.({ place: e.target.value })} className="min-h-12 text-base" /></label>
            </div> : <p className="text-base">훈련 일자: {planDetails.date || "미정"} · 장소: {planDetails.place || "미정"}</p>}
            <p className="mt-2 text-sm text-muted-foreground">현재 문서의 저장·한글·워드·텍스트 복사에 반영됩니다. 위의 새 자료 제작 조건과 별도로 관리합니다.</p>
          </section>
        )}
        {editing ? (
          <fieldset
            disabled={editorLocked}
            aria-busy={editorLocked}
            className="space-y-4 border-0 p-0"
          >
            <legend className="sr-only">문서 섹션 편집</legend>
            {displayDoc.sections.map((s, i) => (
              <section key={i} className="space-y-1">
                <h3 className="text-base font-semibold">{s.heading}</h3>
                <DocumentSectionBody section={s} index={i} editing disabled={editorLocked} onChange={(content) => onPatchSection(i, { content })} />
                <RegenControls index={i} regen={regen} />
                {onLoadSectionEvidence && <DocumentSectionEvidence heading={s.heading} state={sectionEvidence?.[i]} onLoad={() => onLoadSectionEvidence(i)} />}
              </section>
            ))}
          </fieldset>
        ) : (
          displayDoc.sections.map((s, i) => (
            <section key={i} className="space-y-1">
              <h3 className="mb-1 font-semibold">{s.heading}</h3>
              <DocumentSectionBody section={s} index={i} editing={false} disabled={editorLocked} onChange={(content) => onPatchSection(i, { content })} />
              {onLoadSectionEvidence && <DocumentSectionEvidence heading={s.heading} state={sectionEvidence?.[i]} onLoad={() => onLoadSectionEvidence(i)} />}
            </section>
          ))
        )}
        {displayDoc.sources.length > 0 && (
          <section
            className="rounded-xl border border-border/60 bg-muted/30 p-4"
            aria-labelledby="document-sources-heading"
          >
            <h3 id="document-sources-heading" className="font-semibold">
              근거 자료 및 출처
            </h3>
            <ul className="mt-2 space-y-1 text-sm leading-relaxed text-muted-foreground">
              {displayDoc.sources.map((source) => (
                <li key={`${source.document_id}:${source.page ?? "-"}`}>
                  <GeneratedSourceLink source={source} />
                </li>
              ))}
            </ul>
          </section>
        )}
        <div className="flex flex-col gap-2 pt-2 sm:flex-row">
          <Button
            className="h-12 flex-1 gap-2 text-base"
            onClick={onDownloadHwpx}
            disabled={editorLocked || outputBlocked}
            title={outputBlocked ? "핵심 품질 오류를 수정한 뒤 내보낼 수 있습니다." : undefined}
          >
            {exporting === "hwpx" ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {exporting === "hwpx" ? "한글 파일 준비 중…" : "한글(hwpx) 다운로드"}
          </Button>
          <Button
            variant="outline"
            className="h-12 flex-1 gap-2 text-base"
            onClick={onDownloadDocx}
            disabled={editorLocked || outputBlocked}
            title={outputBlocked ? "핵심 품질 오류를 수정한 뒤 내보낼 수 있습니다." : undefined}
          >
            {exporting === "docx" ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {exporting === "docx" ? "워드 파일 준비 중…" : "워드(docx)"}
          </Button>
          <Button
            variant="outline"
            className="h-12 flex-1 gap-2 text-base"
            onClick={() => onCopy(docToText(displayDoc, metadata))}
            disabled={editorLocked || outputBlocked}
            title={outputBlocked ? "핵심 품질 오류를 수정한 뒤 복사할 수 있습니다." : undefined}
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            텍스트 복사
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          AI가 인덱싱된 교육자료를 근거로 생성한 초안입니다. 시행 전 내용을 반드시 검토·보완하세요.
        </p>
      </CardContent>
    </Card>
  );
}

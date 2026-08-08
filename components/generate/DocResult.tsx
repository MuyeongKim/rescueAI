"use client";

// 훈련계획·교안 결과 카드 — 미리보기 · 섹션 편집 · 섹션별 AI 재생성 · hwpx/docx/텍스트 내보내기.
import { Check, Copy, Download, FileText } from "lucide-react";

import type { GeneratedDoc, GeneratedSection } from "@/lib/generate";
import { docToText } from "@/lib/generate-material";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AccentBar,
  EditToggleButton,
  RegenControls,
  SaveButton,
  SourceBadges,
  type RegenState,
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
}) {
  const { accent, editing } = chrome;

  return (
    <Card
      className={cn(
        "animate-in fade-in slide-in-from-bottom-3 overflow-hidden border-border/60 shadow-sm duration-500 motion-reduce:animate-none",
        editing && "ring-1 ring-primary/40"
      )}
    >
      <AccentBar accent={accent} />
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          {editing ? (
            <Input
              value={doc.title}
              onChange={(e) => onTitleChange(e.target.value)}
              className="h-9 text-base font-semibold"
              aria-label="문서 제목"
            />
          ) : (
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-4 w-4" style={{ color: accent }} /> {doc.title}
            </CardTitle>
          )}
          <div className="flex shrink-0 items-center gap-1.5">
            <SaveButton chrome={chrome} />
            <EditToggleButton chrome={chrome} />
          </div>
        </div>
        <CardDescription className="flex flex-wrap items-center gap-1.5">
          근거:
          <SourceBadges sources={doc.sources} />
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {doc.sections.map((s, i) => (
          <section key={i} className="space-y-1">
            {editing ? (
              <>
                <Input
                  value={s.heading}
                  onChange={(e) => onPatchSection(i, { heading: e.target.value })}
                  className="h-9 font-semibold"
                  aria-label={`섹션 ${i + 1} 제목`}
                />
                <Textarea
                  value={s.content}
                  onChange={(e) => onPatchSection(i, { content: e.target.value })}
                  className="min-h-[120px] text-sm leading-relaxed"
                  aria-label={`섹션 ${i + 1} 본문`}
                />
                <RegenControls index={i} regen={regen} />
              </>
            ) : (
              <>
                <h3 className="mb-1 font-semibold">{s.heading}</h3>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                  {s.content}
                </p>
              </>
            )}
          </section>
        ))}
        <div className="flex flex-col gap-2 pt-2 sm:flex-row">
          <Button className="h-12 flex-1 gap-2 text-base" onClick={onDownloadHwpx}>
            <Download className="h-4 w-4" /> 한글(hwpx) 다운로드
          </Button>
          <Button
            variant="outline"
            className="h-12 flex-1 gap-2 text-base"
            onClick={onDownloadDocx}
          >
            <Download className="h-4 w-4" /> 워드(docx)
          </Button>
          <Button
            variant="outline"
            className="h-12 flex-1 gap-2 text-base"
            onClick={() => onCopy(docToText(doc))}
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

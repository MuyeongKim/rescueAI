"use client";

import { useEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/esm/Page/AnnotationLayer.css";
import "react-pdf/dist/esm/Page/TextLayer.css";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  ExternalLink,
  FileWarning,
} from "lucide-react";
import { Button } from "@/components/ui/button";

// pdfjs 워커 — public/ 에 self-host (폐쇄망/공공클라우드 대비, 외부 CDN 미사용).
// scripts/copy-pdf-worker.mjs 가 postinstall 에서 pdfjs-dist 버전과 동기화한다.
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

export function PdfViewer({
  fileUrl,
  initialPage,
}: {
  fileUrl: string;
  initialPage: number;
}) {
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(initialPage);
  const [width, setWidth] = useState(800);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const update = () => {
      const w = containerRef.current?.clientWidth ?? 800;
      setWidth(Math.min(w - 16, 900));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    if (numPages > 0) {
      setPage((p) => Math.min(Math.max(1, p), numPages));
    }
  }, [numPages]);

  return (
    <div ref={containerRef} className="space-y-3">
      {/* 페이지 네비게이션 */}
      <div className="flex items-center justify-between gap-2 rounded-md border bg-card px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="h-10 w-10"
          disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          aria-label="이전 페이지"
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <span className="text-sm tabular-nums">
          {page} / {numPages || "?"} 페이지
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-10 w-10"
          disabled={numPages > 0 && page >= numPages}
          onClick={() => setPage((p) => (numPages ? Math.min(numPages, p + 1) : p + 1))}
          aria-label="다음 페이지"
        >
          <ChevronRight className="h-5 w-5" />
        </Button>
      </div>

      {/* 문서 */}
      <div className="flex justify-center overflow-x-auto rounded-md border bg-muted/20 p-2">
        <Document
          file={fileUrl}
          onLoadSuccess={({ numPages }) => setNumPages(numPages)}
          loading={
            <div className="flex items-center justify-center py-20 text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 문서를 불러오는 중…
            </div>
          }
          error={
            <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
              <FileWarning className="h-8 w-8" />
              <p>문서를 불러올 수 없습니다.</p>
              <a
                href={fileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline"
              >
                새 탭에서 원본 열기
              </a>
            </div>
          }
        >
          <Page
            pageNumber={page}
            width={width}
            renderAnnotationLayer={false}
            renderTextLayer
          />
        </Document>
      </div>

      <div className="flex justify-center">
        <a href={fileUrl} target="_blank" rel="noopener noreferrer">
          <Button variant="outline" size="sm" className="h-10 gap-2">
            <ExternalLink className="h-4 w-4" /> 새 탭에서 원본 열기
          </Button>
        </a>
      </div>
    </div>
  );
}

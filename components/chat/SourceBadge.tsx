"use client";

import Link from "next/link";
import { FileText, ExternalLink } from "lucide-react";
import type { DocSource } from "@/lib/database.types";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

export function SourceBadge({ source }: { source: DocSource }) {
  const label = `${source.doc}${source.page ? ` p.${source.page}` : ""}`;
  const href = `/docs/${source.document_id}${
    source.page ? `?page=${source.page}` : ""
  }`;

  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          className="inline-flex min-h-12 max-w-full items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-9"
        >
          <span className="inline-flex max-w-full items-center gap-1 truncate rounded-md bg-secondary px-2 py-1 text-xs font-normal text-secondary-foreground hover:bg-secondary/80">
            <FileText className="h-3 w-3 shrink-0" />
            <span className="truncate">{label}</span>
          </span>
        </button>
      </SheetTrigger>
      <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
        <SheetHeader className="text-left">
          <SheetTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" />
            {source.doc}
          </SheetTitle>
          <SheetDescription>
            {source.page ? `${source.page} 페이지 인용` : "인용 자료"}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          <div className="rounded-md border bg-muted/30 p-3 text-base leading-relaxed whitespace-pre-wrap wrap-break-word">
            {source.content}
          </div>
          {/* 자료실 원본과 연결되지 않은 외부 청크(document_id=0)는 링크를 숨긴다. */}
          {source.document_id > 0 && (
            <Button asChild className="h-12 w-full gap-2 text-base">
              <Link href={href}>
                <ExternalLink className="h-4 w-4" />
                원본 자료 보기{source.page ? ` (${source.page}p)` : ""}
              </Link>
            </Button>
          )}
          {source.document_id <= 0 && (
            <p className="text-sm text-muted-foreground">이 근거의 원본 파일은 아직 자료실에 연결되지 않았습니다. 위 발췌 내용과 교범명·페이지를 확인해 주세요.</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

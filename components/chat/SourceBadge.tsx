"use client";

import Link from "next/link";
import { FileText, ExternalLink } from "lucide-react";
import type { DocSource } from "@/lib/database.types";
import { Badge } from "@/components/ui/badge";
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
        <button type="button" className="max-w-full">
          <Badge
            variant="secondary"
            className="max-w-full cursor-pointer gap-1 truncate px-2 py-1 text-xs font-normal hover:bg-secondary/80"
          >
            <FileText className="h-3 w-3 shrink-0" />
            <span className="truncate">{label}</span>
          </Badge>
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
          <div className="rounded-md border bg-muted/30 p-3 text-sm leading-relaxed whitespace-pre-wrap">
            {source.content}
          </div>
          <Link href={href} className="block">
            <Button className="h-12 w-full gap-2 text-base">
              <ExternalLink className="h-4 w-4" />
              원본 자료 보기{source.page ? ` (${source.page}p)` : ""}
            </Button>
          </Link>
        </div>
      </SheetContent>
    </Sheet>
  );
}

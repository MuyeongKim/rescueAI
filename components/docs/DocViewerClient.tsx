"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { ArrowLeft, Loader2, FileWarning } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CategoryBadge } from "@/components/learning/CategoryBadge";

const PdfViewer = dynamic(
  () => import("@/components/docs/PdfViewer").then((m) => m.PdfViewer),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 뷰어 로딩 중…
      </div>
    ),
  }
);

export function DocViewerClient({
  title,
  category,
  fileUrl,
  initialPage,
}: {
  title: string;
  category: string | null;
  fileUrl: string | null;
  initialPage: number;
}) {
  return (
    <div className="mx-auto max-w-4xl px-3 py-4 sm:px-4">
      <div className="mb-3 flex items-center gap-2">
        <Button asChild variant="ghost" size="icon" className="h-12 w-12 md:h-10 md:w-10">
          <Link href="/docs" aria-label="자료실 목록으로">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold">{title}</h1>
          {category && (
            <div className="mt-0.5">
              <CategoryBadge category={category} />
            </div>
          )}
        </div>
      </div>

      {fileUrl ? (
        <PdfViewer fileUrl={fileUrl} initialPage={initialPage} />
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-md border bg-muted/30 py-16 text-center">
          <FileWarning className="h-10 w-10 text-muted-foreground" />
          <p className="text-base font-medium">원본 파일이 없습니다</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            현재 열람할 수 있는 원본 PDF가 연결되어 있지 않습니다. 자료 관리자에게
            원본 연결 상태를 알려 주세요.
          </p>
        </div>
      )}
    </div>
  );
}

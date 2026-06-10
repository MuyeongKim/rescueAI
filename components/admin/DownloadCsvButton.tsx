"use client";

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

// 테이블 데이터를 CSV(UTF-8 BOM, 엑셀 호환)로 내려받는 버튼.
export function DownloadCsvButton({
  header,
  rows,
  filename,
}: {
  header: string[];
  rows: (string | number)[][];
  filename: string;
}) {
  function download() {
    const esc = (v: string | number) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [header, ...rows].map((r) => r.map(esc).join(",")).join("\n");
    // BOM을 붙여야 엑셀에서 한글이 깨지지 않는다.
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Button variant="outline" onClick={download} className="h-10 gap-1.5">
      <Download className="h-4 w-4" /> 엑셀(CSV) 다운로드
    </Button>
  );
}

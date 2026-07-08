import type { GeneratedDoc } from "@/lib/generate";
import { sanitizeFilename } from "@/lib/utils";

// 한글(hwpx) 다운로드 공용 헬퍼 (클라이언트 전용).
// 1순위: 미니서버 hwp-writer-api(/api/hwp 중계) — python-hwpx 가 만든 정식 hwpx.
// 폴백: 서버 미설정/장애 시 로컬 빌더(lib/hwpx.ts)로 브라우저에서 직접 생성.
// 반환값으로 어느 경로를 썼는지 알려 호출부가 안내 토스트를 띄울 수 있게 한다.
export async function downloadHwpx(doc: GeneratedDoc): Promise<"server" | "local"> {
  const filename = `${sanitizeFilename(doc.title)}.hwpx`;

  try {
    const res = await fetch("/api/hwp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: doc.title, sections: doc.sections }),
    });
    if (res.ok) {
      saveBlob(await res.blob(), filename);
      return "server";
    }
  } catch {
    // 네트워크 오류 → 로컬 폴백
  }

  // 로컬 생성 폴백 (빌더는 무거워서 이 시점에만 로드)
  const { buildHwpxBlob } = await import("@/lib/hwpx");
  saveBlob(await buildHwpxBlob(doc), filename);
  return "local";
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

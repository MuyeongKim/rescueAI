// pdf.js 워커를 public/ 으로 복사 (폐쇄망 대비 — 외부 CDN 의존 제거).
// postinstall 에서 자동 실행되어 pdfjs-dist 버전과 항상 동기화된다.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "pdfjs-dist", "build", "pdf.worker.min.mjs");
const destDir = join(root, "public");
const dest = join(destDir, "pdf.worker.min.mjs");

if (!existsSync(src)) {
  console.warn("[copy-pdf-worker] pdfjs-dist 워커를 찾지 못했습니다(설치 전일 수 있음):", src);
  process.exit(0);
}
if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log("[copy-pdf-worker] public/pdf.worker.min.mjs 갱신 완료");

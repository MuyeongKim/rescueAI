import type { GeneratedDocSource } from "@/lib/generate";
import { SLIDE_LINE_HEIGHT, wrapSlideText } from "@/lib/slide-text";

/** PPTX 표지·본문·근거 부록 장수 계산의 단일 출처. */
export const PPTX_SOURCES_PER_APPENDIX_SLIDE = 7;
export const PPTX_SOURCE_FONT_SIZE = 18;
export const PPTX_SOURCE_TEXT_WIDTH = 9.1;
const SOURCE_TOP = 1.72;
const SOURCE_BOTTOM = 6.44;
const SOURCE_LINE_HEIGHT = PPTX_SOURCE_FONT_SIZE * SLIDE_LINE_HEIGHT / 72;
const SOURCE_ROW_PADDING = 0.15;

export type PptxSourceRow = { sourceIndex: number; y: number; h: number; lines: string[]; continuation: boolean };

/** 사용자가 편집할 수 없는 출처명은 줄이거나 차단하지 않고 부록을 늘려 전문을 보존한다.
 * 보수적인 공통 줄바꿈을 고정해 브라우저 글꼴 준비 전후에도 안내 장수가 바뀌지 않는다. */
export function planPptxSourceAppendix(sources: readonly GeneratedDocSource[]): PptxSourceRow[][] {
  const pages: PptxSourceRow[][] = [];
  let rows: PptxSourceRow[] = [];
  let y = SOURCE_TOP;
  const nextPage = () => { if (rows.length) pages.push(rows); rows = []; y = SOURCE_TOP; };
  for (const [sourceIndex, source] of sources.entries()) {
    const lines = wrapSlideText(source.doc, PPTX_SOURCE_TEXT_WIDTH * 72 - 4, PPTX_SOURCE_FONT_SIZE);
    let offset = 0;
    while (offset < lines.length) {
      const remaining = lines.length - offset;
      const fullHeight = Math.max(0.66, remaining * SOURCE_LINE_HEIGHT + SOURCE_ROW_PADDING);
      if (rows.length && y + fullHeight > SOURCE_BOTTOM) nextPage();
      const lineCount = Math.min(remaining, Math.max(1, Math.floor((SOURCE_BOTTOM - y - SOURCE_ROW_PADDING) / SOURCE_LINE_HEIGHT)));
      const h = Math.max(0.66, lineCount * SOURCE_LINE_HEIGHT + SOURCE_ROW_PADDING);
      rows.push({ sourceIndex, y, h, lines: lines.slice(offset, offset + lineCount), continuation: offset > 0 });
      y += h;
      offset += lineCount;
      if (offset < lines.length) nextPage();
    }
  }
  nextPage();
  return pages;
}

export function pptxSourceAppendixSlideCount(sourceCount: number | readonly GeneratedDocSource[]): number {
  if (typeof sourceCount !== "number") return planPptxSourceAppendix(sourceCount).length;
  if (!Number.isFinite(sourceCount) || sourceCount <= 0) return 0;
  return Math.ceil(Math.floor(sourceCount) / PPTX_SOURCES_PER_APPENDIX_SLIDE);
}

export function generatedPptxSlideCount(contentSlideCount: number, sourceCount: number | readonly GeneratedDocSource[]): number {
  const safeContentCount = Number.isFinite(contentSlideCount)
    ? Math.max(0, Math.floor(contentSlideCount))
    : 0;
  return 1 + safeContentCount + pptxSourceAppendixSlideCount(sourceCount);
}

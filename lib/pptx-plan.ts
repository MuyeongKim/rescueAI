/** PPTX 표지·본문·근거 부록 장수 계산의 단일 출처. */
export const PPTX_SOURCES_PER_APPENDIX_SLIDE = 7;

export function pptxSourceAppendixSlideCount(sourceCount: number): number {
  if (!Number.isFinite(sourceCount) || sourceCount <= 0) return 0;
  return Math.ceil(Math.floor(sourceCount) / PPTX_SOURCES_PER_APPENDIX_SLIDE);
}

export function generatedPptxSlideCount(contentSlideCount: number, sourceCount: number): number {
  const safeContentCount = Number.isFinite(contentSlideCount)
    ? Math.max(0, Math.floor(contentSlideCount))
    : 0;
  return 1 + safeContentCount + pptxSourceAppendixSlideCount(sourceCount);
}

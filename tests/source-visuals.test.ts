import { describe, expect, it } from "vitest";

import type { GeneratedSlide, GeneratedSlideDeck } from "@/lib/generate";
import {
  exactPdfPageNumber,
  planSourceVisualRequests,
} from "@/lib/source-visuals";

function sourceSlide(index: number, overrides: Partial<GeneratedSlide> = {}): GeneratedSlide {
  return {
    title: `원문 확인 ${index + 1}`,
    bullets: ["원문 페이지에서 확인 위치를 찾습니다", "설명과 현장 상태를 비교합니다"],
    notes: "교관 설명",
    role: "evidence",
    composition: "visual-explanation",
    visual: {
      mode: "source-page",
      documentId: index + 1,
      page: index + 1,
      sourceRef: `[교범 ${index + 1} p.${index + 1}]`,
      altText: `교범 ${index + 1}의 원문 페이지`,
    },
    ...overrides,
  };
}

function deck(slides: GeneratedSlide[]): GeneratedSlideDeck {
  return { title: "원문 시각자료 검증", mode: "presenter", slides, sources: [] };
}

describe("원문 PDF 페이지 범위", () => {
  it("요청 페이지가 실제 범위를 벗어나면 마지막 페이지로 보정하지 않고 거부한다", () => {
    expect(exactPdfPageNumber(3, 10)).toBe(3);
    expect(exactPdfPageNumber(11, 10)).toBeNull();
    expect(exactPdfPageNumber(0, 10)).toBeNull();
    expect(exactPdfPageNumber(1, 0)).toBeNull();
  });
});

describe("원문 시각자료 요청 계획", () => {
  it("최대 8개만 렌더하고 초과분은 실패 대상으로 집계해 안전한 시각자료로 내린다", () => {
    const planned = planSourceVisualRequests(
      deck(Array.from({ length: 10 }, (_, index) => sourceSlide(index)))
    );

    expect(planned.requested).toBe(10);
    expect(planned.requests).toHaveLength(8);
    expect(planned.rejected).toHaveLength(2);
    expect(planned.deck.slides.slice(0, 8).every((slide) => slide.visual?.mode === "source-page"))
      .toBe(true);
    expect(planned.deck.slides.slice(8).every((slide) => slide.visual?.mode === "none")).toBe(
      true
    );
  });

  it("과거 source-crop은 전체 페이지로 정규화하고 잘못된 구도·메타데이터는 요청하지 않는다", () => {
    const planned = planSourceVisualRequests(
      deck([
        sourceSlide(0, {
          visual: {
            ...sourceSlide(0).visual!,
            mode: "source-crop",
          },
        }),
        sourceSlide(1, {
          composition: "comparison",
          steps: ["정상", "이상"],
        }),
        sourceSlide(2, {
          visual: {
            mode: "source-page",
            sourceRef: "[교범 3 p.3]",
            altText: "문서 ID가 없는 원문",
          },
        }),
      ])
    );

    expect(planned.requested).toBe(3);
    expect(planned.requests).toHaveLength(1);
    expect(planned.deck.slides[0].visual?.mode).toBe("source-page");
    expect(planned.deck.slides[1].visual?.mode).toBe("native-diagram");
    expect(planned.deck.slides[2].visual?.mode).toBe("none");
    expect(planned.rejected).toHaveLength(2);
  });
});

import { describe, expect, it } from "vitest";

import type { GeneratedSlide, GeneratedSlideDeck } from "@/lib/generate";
import {
  autoAssignDeckSourceVisuals,
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

describe("원문 시각자료 자동 보강", () => {
  const sources = [
    { document_id: 11, doc: "구조장비 교범", page: 4 },
    { document_id: 12, doc: "현장안전 지침", page: 9 },
    { document_id: 11, doc: "구조장비 교범", page: 7 },
    { document_id: 13, doc: "훈련 표준", page: 3 },
  ];

  function candidateSlide(
    index: number,
    overrides: Partial<GeneratedSlide> = {}
  ): GeneratedSlide {
    return {
      title: `자동 보강 후보 ${index + 1}`,
      bullets: ["근거 페이지를 확인합니다", "현장 적용 지점을 설명합니다"],
      notes: "교관 설명",
      role: index % 2 === 0 ? "evidence" : "equipment",
      composition: "list",
      visual: { mode: "none" },
      sourceRefs: [`[구조장비 교범 p.${index === 2 ? 7 : 4}]`],
      ...overrides,
    };
  }

  it("정확한 장별 출처가 있는 근거·장비 장에 최대 3개의 전체 원문 페이지를 연결한다", () => {
    const input: GeneratedSlideDeck = {
      ...deck([
        candidateSlide(0, {
          composition: "visual-explanation",
          sourceRefs: ["[구조장비 교범 p.4]", "[현장안전 지침 p.9]"],
        }),
        candidateSlide(1, { sourceRefs: ["[구조장비 교범 p.4]"] }),
        candidateSlide(2),
        candidateSlide(3, { sourceRefs: ["[훈련 표준 p.3]"] }),
      ]),
      sources,
    };

    const enriched = autoAssignDeckSourceVisuals(input);
    const assigned = enriched.slides.filter((slide) => slide.visual?.mode === "source-page");

    expect(assigned).toHaveLength(3);
    expect(assigned.every((slide) => slide.composition === "visual-explanation")).toBe(true);
    expect(
      assigned.map((slide) => [slide.visual?.documentId, slide.visual?.page])
    ).toEqual([
      [12, 9],
      [11, 7],
      [13, 3],
    ]);
    expect(assigned.every((slide) => slide.visual?.fit === "contain")).toBe(true);
  });

  it("기존 원문 선택이 하나라도 있으면 덱을 그대로 두고 기본 다이어그램도 덮어쓰지 않는다", () => {
    const withExplicitSource: GeneratedSlideDeck = {
      ...deck([
        candidateSlide(0, {
          composition: "visual-explanation",
          visual: {
            mode: "source-page",
            documentId: 11,
            page: 4,
            sourceRef: "[구조장비 교범 p.4]",
            altText: "기존 원문",
          },
        }),
        candidateSlide(1),
      ]),
      sources,
    };

    expect(autoAssignDeckSourceVisuals(withExplicitSource)).toBe(withExplicitSource);

    const withNativeDiagram: GeneratedSlideDeck = {
      ...deck([
        candidateSlide(0, { visual: { mode: "native-diagram" } }),
        candidateSlide(1),
      ]),
      sources,
    };
    const enriched = autoAssignDeckSourceVisuals(withNativeDiagram);
    expect(enriched.slides[0].visual).toEqual({ mode: "native-diagram" });
    expect(enriched.slides[1].visual).toMatchObject({
      mode: "source-page",
      documentId: 11,
      page: 4,
    });
  });

  it("잘못되거나 모호한 원문과 장별 sourceRefs에 없는 원문은 연결하지 않는다", () => {
    const input: GeneratedSlideDeck = {
      ...deck([
        candidateSlide(0, { sourceRefs: ["[중복 교범 p.5]"] }),
        candidateSlide(1, { sourceRefs: ["[페이지 없음 p.1]"] }),
        candidateSlide(2, { sourceRefs: ["[덱에만 있는 교범 p.2]"] }),
      ]),
      sources: [
        { document_id: 21, doc: "중복 교범", page: 5 },
        { document_id: 22, doc: "중복 교범", page: 5 },
        { document_id: 23, doc: "페이지 없음", page: null },
        { document_id: 24, doc: "장에 없는 교범", page: 2 },
        { document_id: 0, doc: "덱에만 있는 교범", page: 2 },
      ],
    };

    expect(autoAssignDeckSourceVisuals(input)).toBe(input);
  });

  it("같은 원문 페이지를 반복하지 않고 요청한 보강 수를 3장 이하로 제한한다", () => {
    const input: GeneratedSlideDeck = {
      ...deck([
        candidateSlide(0, { sourceRefs: ["[구조장비 교범 p.4]"] }),
        candidateSlide(1, { sourceRefs: ["[구조장비 교범 p.4]"] }),
        candidateSlide(2, { sourceRefs: ["[구조장비 교범 p.7]"] }),
        candidateSlide(3, { sourceRefs: ["[현장안전 지침 p.9]"] }),
      ]),
      sources,
    };

    const enriched = autoAssignDeckSourceVisuals(input, 99);
    const pageKeys = enriched.slides
      .filter((slide) => slide.visual?.mode === "source-page")
      .map((slide) => `${slide.visual?.documentId}:${slide.visual?.page}`);

    expect(pageKeys).toHaveLength(3);
    expect(new Set(pageKeys).size).toBe(pageKeys.length);
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

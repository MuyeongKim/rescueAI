import { describe, expect, it } from "vitest";

import type { GeneratedSlide, GeneratedSlideDeck } from "@/lib/generate";
import {
  autoAssignDeckSourceVisuals,
  exactPdfPageNumber,
  fallbackSourceVisualSlide,
  isUsefulSourcePageVisual,
  planSourceVisualRequests,
  sourcePageVisualScore,
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

  it("본문과 명시적으로 연결한 도식은 시각자료 자동 보강으로 덮어쓰지 않는다", () => {
    const current = candidateSlide(0, {
      composition: "process", role: "procedure", visual: { mode: "none" },
      steps: ["장비 외관 확인", "연결 상태 확인"],
      diagram: { kind: "process", nodes: [
        { stepIndex: 0, bulletIndices: [0] }, { stepIndex: 1, bulletIndices: [1] },
      ] },
    });
    const input = { ...deck([current]), sources };

    expect(autoAssignDeckSourceVisuals(input).slides[0]).toEqual(current);
  });

  it("기존 원문 선택은 보존하면서 남은 자리만 채우고 기본 다이어그램은 덮어쓰지 않는다", () => {
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
        candidateSlide(1, { sourceRefs: ["[현장안전 지침 p.9]"] }),
      ]),
      sources,
    };

    const enrichedExplicit = autoAssignDeckSourceVisuals(withExplicitSource);
    expect(enrichedExplicit.slides[0].visual).toEqual(withExplicitSource.slides[0].visual);
    expect(enrichedExplicit.slides[1].visual).toMatchObject({
      mode: "source-page",
      documentId: 12,
      page: 9,
    });

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

  it("사진·도해 가능성이 있는 사례 장도 정확한 출처가 있으면 남은 슬롯 후보가 된다", () => {
    const input: GeneratedSlideDeck = {
      ...deck([
        candidateSlide(0, {
          role: "case",
          title: "위험구역 배치를 원문 도해로 확인합니다",
          sourceRefs: ["[현장안전 지침 p.9]"],
        }),
      ]),
      sources,
    };

    expect(autoAssignDeckSourceVisuals(input).slides[0].visual).toMatchObject({
      mode: "source-page",
      documentId: 12,
      page: 9,
    });
  });

  it("한글 조합 방식이 달라도 같은 검증 출처를 자동 연결한다", () => {
    const nfdTitle = "구조장비 교범".normalize("NFD");
    const nfcRef = `[${nfdTitle.normalize("NFC")} p.4]`;
    const input: GeneratedSlideDeck = {
      ...deck([candidateSlide(0, { sourceRefs: [nfcRef] })]),
      sources: [{ document_id: 11, doc: nfdTitle, page: 4 }],
    };

    expect(autoAssignDeckSourceVisuals(input).slides[0].visual).toMatchObject({
      mode: "source-page",
      documentId: 11,
      page: 4,
    });
  });
});

describe("원문 페이지 시각성 판정", () => {
  it("텍스트 연산만 있는 페이지는 제외하고 사진·표·도해 신호는 허용한다", () => {
    const textOnly = {
      imageOperations: 0,
      formOperations: 0,
      vectorOperations: 2,
      shadingOperations: 0,
      textCharacters: 3_200,
    };
    const photoPage = { ...textOnly, imageOperations: 2, textCharacters: 500 };
    const logoOnTextPage = { ...textOnly, imageOperations: 1, textCharacters: 3_000 };
    const tablePage = { ...textOnly, vectorOperations: 18, textCharacters: 900 };
    const outlinedGlyphTextPage = {
      ...textOnly,
      vectorOperations: 995,
      textCharacters: 3_094,
    };

    expect(isUsefulSourcePageVisual(textOnly)).toBe(false);
    expect(isUsefulSourcePageVisual(photoPage)).toBe(true);
    expect(isUsefulSourcePageVisual(logoOnTextPage)).toBe(false);
    expect(isUsefulSourcePageVisual(tablePage)).toBe(true);
    expect(isUsefulSourcePageVisual(outlinedGlyphTextPage)).toBe(false);
    expect(sourcePageVisualScore(photoPage)).toBeGreaterThan(sourcePageVisualScore(textOnly));
    expect(sourcePageVisualScore(tablePage)).toBeGreaterThan(sourcePageVisualScore(textOnly));
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

  it("한 장의 여러 검증 출처를 시각 품질 비교 후보로 보존한다", () => {
    const planned = planSourceVisualRequests({
      ...deck([
        sourceSlide(0, {
          visual: {
            mode: "source-page",
            documentId: 11,
            page: 4,
            sourceRef: "[구조장비 교범 p.4]",
            altText: "구조장비 원문",
          },
          sourceRefs: ["[구조장비 교범 p.4]", "[현장안전 지침 p.9]"],
        }),
      ]),
      sources: [
        { document_id: 11, doc: "구조장비 교범", page: 4 },
        { document_id: 12, doc: "현장안전 지침", page: 9 },
      ],
    });

    expect(planned.requests[0].candidates).toEqual([
      {
        documentId: 11,
        page: 4,
        documentTitle: "구조장비 교범",
        sourceRef: "[구조장비 교범 p.4]",
      },
      {
        documentId: 12,
        page: 9,
        documentTitle: "현장안전 지침",
        sourceRef: "[현장안전 지침 p.9]",
      },
    ]);
  });

  it("8개 출력 장의 1순위 후보를 보존하면서 전체 비교 후보를 24개로 제한한다", () => {
    const sources = Array.from({ length: 32 }, (_, index) => ({
      document_id: index + 1,
      doc: `후보 교범 ${index + 1}`,
      page: 1,
    }));
    const slides = Array.from({ length: 8 }, (_, slideIndex) => {
      const slideSources = sources.slice(slideIndex * 4, slideIndex * 4 + 4);
      const sourceRefs = slideSources.map((source) => `[${source.doc} p.1]`);
      return sourceSlide(slideIndex, {
        visual: {
          mode: "source-page",
          documentId: slideSources[0].document_id,
          page: 1,
          sourceRef: sourceRefs[0],
        },
        sourceRefs,
      });
    });

    const planned = planSourceVisualRequests({ ...deck(slides), sources });

    expect(planned.requests).toHaveLength(8);
    expect(planned.requests.reduce((sum, request) => sum + request.candidates.length, 0)).toBe(24);
    expect(planned.requests.every((request) => request.candidates.length >= 1)).toBe(true);
  });

  it("원문 렌더 실패 폴백은 visual-explanation 자리표시자를 남기지 않는다", () => {
    const fallback = fallbackSourceVisualSlide(
      sourceSlide(0, {
        role: "equipment",
        steps: undefined,
      })
    );

    expect(fallback.composition).toBe("checklist");
    expect(fallback.layout).toBe("equipment");
    expect(fallback.visual?.mode).toBe("native-diagram");
    expect(fallback.visual?.documentId).toBeUndefined();
    expect(fallback.visual?.page).toBeUndefined();
  });

  it("그림 대체는 원래 구도에서 무효했던 관계를 새 구도에 되살리지 않는다", () => {
    const original = sourceSlide(0, {
      role: "decision",
      steps: ["연결 이상 유무", "이상 확인", "정상 확인"],
      diagram: { kind: "decision", conditionStepIndex: 0, branches: [
        { labelStepIndex: 1, bulletIndices: [0] },
        { labelStepIndex: 2, bulletIndices: [1] },
      ] },
    });
    const fallback = fallbackSourceVisualSlide(original);

    expect(fallback.composition).toBe("decision-flow");
    expect(fallback.diagram).toBeUndefined();
    expect(fallback.steps).toEqual(original.steps);
    expect(fallback.bullets).toEqual(original.bullets);
    expect(original.diagram).toBeDefined();
  });

  it("내용과 관계가 유효한 같은 구도의 도식은 그림 대체 후에도 보존한다", () => {
    const original = sourceSlide(0, {
      role: "procedure", composition: "process",
      steps: ["장비 확인", "동료 점검", "결과 보고"],
      diagram: { kind: "process", nodes: [
        { stepIndex: 0, bulletIndices: [0] }, { stepIndex: 1, bulletIndices: [1] },
        { stepIndex: 2, bulletIndices: [] },
      ] },
    });

    expect(fallbackSourceVisualSlide(original).diagram).toEqual(original.diagram);
  });
});

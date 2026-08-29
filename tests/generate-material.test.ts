import { describe, expect, it } from "vitest";

import { MAX_GENERATION_CONDITIONS_CHARS, type SavedMaterial } from "@/lib/generate";
import {
  hydrateMaterial,
  initialGenerationType,
  mergeGeneratedSources,
  preferredGenerationModel,
  stripSlideDeckRuntimeData,
} from "@/lib/generate-material";

function savedMaterial(overrides: Partial<SavedMaterial> = {}): SavedMaterial {
  return {
    id: 1,
    kind: "plan",
    category: "화재",
    audience: "일반 대원",
    duration: "2시간",
    topic: "공기호흡기 점검",
    title: "공기호흡기 점검 훈련계획",
    content: { sections: [], sources: [] },
    revision: 1,
    created_at: "2026-08-28T00:00:00.000Z",
    ...overrides,
  };
}

describe("hydrateMaterial", () => {
  it("신규 자료와 기존 저장본에 현장 조건이 없으면 빈 값으로 복원한다", () => {
    expect(hydrateMaterial().conditions).toBe("");
    expect(hydrateMaterial(savedMaterial()).conditions).toBe("");
    expect(hydrateMaterial()).toMatchObject({ date: "", place: "" });
  });

  it("저장한 현장 조건을 복원하고 UI 최대 길이로 제한한다", () => {
    const conditions = "가".repeat(MAX_GENERATION_CONDITIONS_CHARS + 20);
    const hydrated = hydrateMaterial(
      savedMaterial({ content: { sections: [], sources: [], conditions } })
    );

    expect(hydrated.conditions).toHaveLength(MAX_GENERATION_CONDITIONS_CHARS);
    expect(hydrated.conditions).toBe("가".repeat(MAX_GENERATION_CONDITIONS_CHARS));
  });

  it("과거 NotebookLM 저장본의 프롬프트와 현장 조건을 함께 복원한다", () => {
    const hydrated = hydrateMaterial(
      savedMaterial({
        kind: "notebooklm",
        content: { prompt: "기존 프롬프트", conditions: "대원 8명" },
      })
    );

    expect(hydrated.nlm).toBe("기존 프롬프트");
    expect(hydrated.conditions).toBe("대원 8명");
  });

  it("훈련계획 문서 정보와 실제 허용 출처 라벨을 재편집 상태로 복원한다", () => {
    const hydrated = hydrateMaterial(
      savedMaterial({
        content: {
          sections: [],
          sources: [],
          date: "2026-09-15",
          place: "전북소방교육훈련센터",
          sourceLabels: ["[화학보호복 교범 p.12]", "[화학보호복 교범 p.12]", 123],
        },
      })
    );

    expect(hydrated.date).toBe("2026-09-15");
    expect(hydrated.place).toBe("전북소방교육훈련센터");
    expect(hydrated.doc?.sourceLabels).toEqual(["[화학보호복 교범 p.12]"]);
  });

  it("잘못된 문서 일자는 복원하지 않고 장소 길이를 제한한다", () => {
    const hydrated = hydrateMaterial(
      savedMaterial({
        content: { sections: [], sources: [], date: "내일", place: "장".repeat(120) },
      })
    );
    expect(hydrated.date).toBe("");
    expect(hydrated.place).toHaveLength(100);
  });

  it("선택한 세부 방향과 SOP 근거 상태를 재편집 상태로 복원한다", () => {
    const hydrated = hydrateMaterial(
      savedMaterial({
        content: {
          sections: [],
          sources: [],
          focus: "야간 조난자 수색구역 설정",
          sopEvidence: {
            status: "found",
            sourceLabels: ["[산악 현장활동 지침 p.12]", 10],
          },
        },
      })
    );

    expect(hydrated.focus).toBe("야간 조난자 수색구역 설정");
    expect(hydrated.doc?.sopEvidence).toEqual({
      status: "found",
      sourceLabels: ["[산악 현장활동 지침 p.12]"],
    });
  });

  it("슬라이드 모드는 검증해 복원하고 과거 저장본은 발표형을 기본으로 사용한다", () => {
    const detailed = hydrateMaterial(
      savedMaterial({
        kind: "slides",
        content: { mode: "detailed", slides: [], sources: [] },
      })
    );
    const legacy = hydrateMaterial(
      savedMaterial({ kind: "slides", content: { slides: [], sources: [] } })
    );
    const invalid = hydrateMaterial(
      savedMaterial({ kind: "slides", content: { mode: "unknown", slides: [], sources: [] } })
    );

    expect(detailed.deck?.mode).toBe("detailed");
    expect(legacy.deck?.mode).toBe("presenter");
    expect(invalid.deck?.mode).toBe("presenter");
  });

  it("PPTX 런타임 이미지는 저장·복원 데이터에서 제거한다", () => {
    const deck = {
      title: "원문 시각자료 덱",
      mode: "presenter" as const,
      slides: [
        {
          title: "원문을 확인합니다",
          bullets: ["출처가 확인된 그림만 사용합니다"],
          notes: "교관 설명",
          visual: {
            mode: "source-page" as const,
            documentId: 3,
            page: 5,
            sourceRef: "[교범 p.5]",
            imageData: "data:image/png;base64,AAAA",
          },
        },
      ],
      sources: [{ document_id: 3, doc: "교범", page: 5 }],
    };

    const stored = stripSlideDeckRuntimeData(deck);
    expect(stored.slides[0].visual).toMatchObject({
      mode: "source-page",
      documentId: 3,
      page: 5,
    });
    expect(stored.slides[0].visual).not.toHaveProperty("imageData");

    const hydrated = hydrateMaterial(
      savedMaterial({
        kind: "slides",
        content: { mode: stored.mode, slides: deck.slides, sources: deck.sources },
      })
    );
    expect(hydrated.deck?.slides[0].visual).not.toHaveProperty("imageData");
  });

  it("저장 데이터의 비문자 섹션·슬라이드 필드를 제거해 목록 렌더링을 보호한다", () => {
    const malformedDoc = hydrateMaterial(
      savedMaterial({
        content: {
          sections: [
            { heading: "훈련내용", content: "정상 본문" },
            { heading: "안전관리", content: {} },
          ],
          sources: [{ document_id: "1", doc: "가짜", page: 1 }],
        } as never,
      })
    );
    const malformedDeck = hydrateMaterial(
      savedMaterial({
        kind: "slides",
        content: {
          slides: [
            {
              title: "정상 제목",
              bullets: ["정상 문장", { text: "객체 문장" }],
              sourceRefs: ["[정상 출처 p.1]", { label: "가짜" }],
              layout: "unknown",
            },
          ],
          sources: [],
        } as never,
      })
    );

    expect(malformedDoc.doc?.sections).toEqual([
      { heading: "훈련내용", content: "정상 본문" },
    ]);
    expect(malformedDoc.doc?.sources).toEqual([]);
    expect(malformedDeck.deck?.slides[0]).toMatchObject({
      title: "정상 제목",
      bullets: ["정상 문장"],
      sourceRefs: ["[정상 출처 p.1]"],
    });
    expect(malformedDeck.deck?.slides[0].layout).toBeUndefined();
  });
});

describe("preferredGenerationModel", () => {
  it("목록 순서와 관계없이 gemini-pro를 우선한다", () => {
    expect(
      preferredGenerationModel([{ key: "gemini-flash" }, { key: "gemini-pro" }])
    ).toBe("gemini-pro");
  });

  it("gemini-pro가 없으면 첫 모델, 모델이 없으면 서버 기본값용 빈 문자열을 반환한다", () => {
    expect(preferredGenerationModel([{ key: "gemini-flash" }])).toBe("gemini-flash");
    expect(preferredGenerationModel([])).toBe("");
  });
});

describe("initialGenerationType", () => {
  it("과거 NotebookLM 저장본은 결과 호환만 유지하고 신규 작성은 훈련계획으로 시작한다", () => {
    expect(initialGenerationType("notebooklm")).toBe("plan");
    expect(initialGenerationType("slides")).toBe("slides");
    expect(initialGenerationType()).toBe("plan");
  });
});

describe("mergeGeneratedSources", () => {
  it("부분 재생성에서 새 근거를 중복 없이 합치고 잘못된 응답은 제외한다", () => {
    const current = [{ document_id: 1, doc: "기존 교범", page: 3 }];
    const merged = mergeGeneratedSources(current, [
      { document_id: 1, doc: " 기존 교범 ", page: 3 },
      { document_id: 2, doc: "신규 교범", page: 7 },
      { document_id: "조작", doc: "잘못된 값", page: null },
      { document_id: 3, doc: "", page: 1 },
    ]);

    expect(merged).toEqual([
      { document_id: 1, doc: "기존 교범", page: 3 },
      { document_id: 2, doc: "신규 교범", page: 7 },
    ]);
  });

  it("새 근거 배열이 없으면 기존 근거의 안전한 복사본을 반환한다", () => {
    const current = [{ document_id: 1, doc: "기존 교범", page: null }];
    const merged = mergeGeneratedSources(current, undefined);

    expect(merged).toEqual(current);
    expect(merged).not.toBe(current);
  });
});

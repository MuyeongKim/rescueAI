import { describe, expect, it } from "vitest";

import { MAX_GENERATION_CONDITIONS_CHARS, type SavedMaterial } from "@/lib/generate";
import {
  hydrateMaterial,
  initialGenerationType,
  mergeGeneratedSources,
  preferredGenerationModel,
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

import { describe, expect, it } from "vitest";

import {
  LimitedJsonBodyError,
  normalizeGeneratedMaterialContent,
  readLimitedJsonBody,
} from "@/lib/generated-material-save";

function slide(index: number) {
  return {
    title: `슬라이드 ${index + 1}`,
    bullets: ["핵심 내용"],
    notes: "교관 설명",
    composition: "visual-explanation",
    visual: {
      mode: "source-page",
      documentId: 7,
      page: 3,
      sourceRef: "[화학보호복 교범 p.3]",
      imageData: "data:image/jpeg;base64,AAAA",
    },
  };
}

describe("제한된 생성물 저장 요청", () => {
  it("Content-Length가 상한보다 크면 본문을 읽지 않고 413으로 거절한다", async () => {
    const request = new Request("http://localhost/api/generate/save", {
      method: "POST",
      headers: { "Content-Length": "129" },
      body: "{}",
    });

    await expect(readLimitedJsonBody(request, 128)).rejects.toMatchObject<LimitedJsonBodyError>({
      status: 413,
    });
  });

  it("Content-Length가 없어도 실제 스트림이 상한을 넘으면 413으로 거절한다", async () => {
    const request = new Request("http://localhost/api/generate/save", {
      method: "POST",
      body: JSON.stringify({ value: "가".repeat(100) }),
    });

    await expect(readLimitedJsonBody(request, 128)).rejects.toMatchObject<LimitedJsonBodyError>({
      status: 413,
    });
  });

  it("JSON의 모든 깊이에서 imageData 키를 제거한다", async () => {
    const request = new Request("http://localhost/api/generate/save", {
      method: "POST",
      body: JSON.stringify({
        imageData: "root",
        nested: [{ imageData: "child", keep: true }],
      }),
    });
    const parsed = await readLimitedJsonBody(request);

    expect(parsed).toEqual({ nested: [{ keep: true }] });
    expect(JSON.stringify(parsed)).not.toContain("imageData");
  });
});

describe("생성물 종류별 서버 정규화", () => {
  it("슬라이드 허용 필드만 남기고 런타임 이미지를 저장하지 않는다", () => {
    const result = normalizeGeneratedMaterialContent("slides", {
      mode: "presenter",
      slides: [slide(0)],
      sources: [{ document_id: 7, doc: "화학보호복 교범", page: 3, imageData: "source" }],
      unknown: { imageData: "unknown" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).not.toHaveProperty("unknown");
    expect(JSON.stringify(result.content)).not.toContain("imageData");
    expect(result.content).toMatchObject({
      mode: "presenter",
      slides: [
        {
          title: "슬라이드 1",
          visual: { mode: "source-page", documentId: 7, page: 3 },
        },
      ],
    });
  });

  it("슬라이드는 20장, 문서 섹션은 8개까지만 허용한다", () => {
    expect(
      normalizeGeneratedMaterialContent("slides", {
        slides: Array.from({ length: 20 }, (_, index) => slide(index)),
      }).ok
    ).toBe(true);
    expect(
      normalizeGeneratedMaterialContent("slides", {
        slides: Array.from({ length: 21 }, (_, index) => slide(index)),
      }).ok
    ).toBe(false);

    const sections = Array.from({ length: 8 }, (_, index) => ({
      heading: `섹션 ${index + 1}`,
      content: "교육 내용",
    }));
    expect(normalizeGeneratedMaterialContent("plan", { sections }).ok).toBe(true);
    expect(
      normalizeGeneratedMaterialContent("lesson", {
        sections: [...sections, { heading: "초과", content: "초과 내용" }],
      }).ok
    ).toBe(false);
  });

  it("source-page를 실제 sources에 재결합하고 충돌한 ID·페이지·라벨은 안전 폴백한다", () => {
    const result = normalizeGeneratedMaterialContent("slides", {
      mode: "presenter",
      slides: [
        {
          ...slide(0),
          visual: {
            mode: "source-page",
            sourceRef: "[화학보호복 교범 p.3]",
          },
        },
        {
          ...slide(1),
          visual: { ...slide(1).visual, documentId: 99 },
        },
        {
          ...slide(2),
          visual: { ...slide(2).visual, page: 99 },
        },
        {
          ...slide(3),
          visual: { ...slide(3).visual, sourceRef: "[다른 교범 p.3]" },
        },
      ],
      sources: [{ document_id: 7, doc: "화학보호복 교범", page: 3 }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const slides = result.content.slides as Array<{
      visual?: { mode?: string; documentId?: number; page?: number; sourceRef?: string };
    }>;
    expect(slides[0]?.visual).toMatchObject({
      mode: "source-page",
      documentId: 7,
      page: 3,
      sourceRef: "[화학보호복 교범 p.3]",
    });
    for (const rejected of slides.slice(1)) {
      expect(rejected.visual).toEqual({ mode: "none" });
    }
  });

  it("종류별 필수 구조가 없으면 저장을 거절한다", () => {
    expect(normalizeGeneratedMaterialContent("slides", { slides: [] }).ok).toBe(false);
    expect(normalizeGeneratedMaterialContent("plan", { sections: [] }).ok).toBe(false);
    expect(normalizeGeneratedMaterialContent("notebooklm", { prompt: "" }).ok).toBe(false);
  });

  it("선택한 세부 방향과 분리 검증한 SOP 근거 상태를 허용 필드로 보존한다", () => {
    const result = normalizeGeneratedMaterialContent("plan", {
      sections: [{ heading: "훈련내용", content: "충분한 훈련 내용" }],
      focus: "야간 조난자 수색구역 설정",
      sopEvidence: {
        status: "found",
        sourceLabels: ["[산악 현장활동 지침 p.12]"],
        forged: true,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      content: {
        focus: "야간 조난자 수색구역 설정",
        sopEvidence: {
          status: "found",
          sourceLabels: ["[산악 현장활동 지침 p.12]"],
        },
      },
    });
    if (result.ok) {
      expect(result.content.sopEvidence).not.toHaveProperty("forged");
    }
  });
});

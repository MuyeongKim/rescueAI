import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import {
  SavedList,
  inspectSavedMaterialQuality,
  inspectSavedMaterialSop,
  savedMaterialHwpxOptions,
  savedMaterialBlockingQualityIssues,
  savedMaterialSopStatus,
} from "@/components/generate/SavedList";
import type { SavedMaterial } from "@/lib/generate";
import {
  SOP_APPLICATION_MARKER,
  SOP_DEGRADED_DISCLOSURE,
  SOP_NOT_FOUND_DISCLOSURE,
} from "@/lib/sop-evidence";

const SOP_LABEL = "[산악구조 현장활동 지침 p.3]";

function savedMaterial(
  kind: SavedMaterial["kind"],
  content: Record<string, unknown>
): SavedMaterial {
  return {
    id: 12,
    kind,
    category: "산악",
    audience: "일반 대원",
    duration: "2시간",
    topic: "산악사고 대비 훈련",
    title: "산악사고 대비 훈련",
    content,
    created_at: "2026-08-29T00:00:00.000Z",
  };
}

describe("저장 목록 SOP 사용 가능 여부", () => {
  it("SOP 근거 상태가 없는 과거 계획은 내보내기·공유·복제 대상으로 인정하지 않는다", () => {
    const report = inspectSavedMaterialSop(
      savedMaterial("plan", {
        sections: [{ heading: "훈련내용", content: "수색구역을 설정합니다." }],
      })
    );

    expect(report.ok).toBe(false);
    expect(report.issues[0]).toMatchObject({ path: "content.sopEvidence" });
  });

  it("미확인 근거와 고정 확인 안내문이 함께 있는 저장 계획은 허용한다", () => {
    const material = savedMaterial("plan", {
      sections: [{ heading: "훈련내용", content: SOP_NOT_FOUND_DISCLOSURE }],
      sopEvidence: { status: "not_found", sourceLabels: [] },
    });
    const report = inspectSavedMaterialSop(material);

    expect(report).toEqual({ ok: true, issues: [] });
    expect(savedMaterialBlockingQualityIssues(material)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_section" }),
        expect.objectContaining({ code: "source_validation_unavailable" }),
      ])
    );
  });

  it("SOP만 통과한 짧은 저장본도 중앙 핵심 품질검사로 내보내기·복사·공유를 막는다", () => {
    const material = savedMaterial("plan", {
      sections: [{ heading: "훈련내용", content: SOP_NOT_FOUND_DISCLOSURE }],
      sourceLabels: [SOP_LABEL],
      sopEvidence: { status: "not_found", sourceLabels: [] },
    });

    expect(inspectSavedMaterialSop(material).ok).toBe(true);
    const quality = inspectSavedMaterialQuality(material);
    const blocking = savedMaterialBlockingQualityIssues(material);
    expect(quality.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "missing_section" })])
    );
    expect(blocking.length).toBeGreaterThan(0);

    const html = renderToStaticMarkup(createElement(SavedList, { initial: [material] }));
    expect(html).toContain("품질 보완 필요");
    expect(html).toContain("내보내기·복사·공유 전에 품질 보완이 필요합니다.");
    expect(html).toContain("편집에서 다시 생성하거나 내용을 수정해 주세요.");
  });

  it("교육 시간이 없는 이전 저장본은 임의 기본값으로 통과시키지 않는다", () => {
    const material = {
      ...savedMaterial("plan", {
        sections: [{ heading: "훈련내용", content: SOP_NOT_FOUND_DISCLOSURE }],
        sourceLabels: [SOP_LABEL],
        sopEvidence: { status: "not_found", sourceLabels: [] },
      }),
      duration: null,
    };

    expect(inspectSavedMaterialQuality(material).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_time_allocation", path: "duration" }),
      ])
    );
  });

  it("확인된 SOP 표식과 같은 위치의 정확한 출처가 있는 슬라이드는 허용한다", () => {
    const report = inspectSavedMaterialSop(
      savedMaterial("slides", {
        slides: [
          {
            title: "현장 SOP 적용",
            bullets: [SOP_APPLICATION_MARKER],
            notes: "교관 설명",
            sourceRefs: [SOP_LABEL],
          },
        ],
        sopEvidence: { status: "found", sourceLabels: [SOP_LABEL] },
      })
    );

    expect(report).toEqual({ ok: true, issues: [] });
  });

  it("NotebookLM 프롬프트는 SOP 저장 계약을 적용하지 않는다", () => {
    const material = savedMaterial("notebooklm", { prompt: "NotebookLM 제작 프롬프트" });
    const report = inspectSavedMaterialSop(material);

    expect(report).toEqual({ ok: true, issues: [] });
    expect(inspectSavedMaterialQuality(material)).toEqual({ ok: true, issues: [] });
    expect(savedMaterialBlockingQualityIssues(material)).toEqual([]);
  });

  it("검색장애 안내문이 온전해도 공유 판단에는 degraded 상태를 별도로 노출한다", () => {
    const material = savedMaterial("plan", {
      sections: [{ heading: "훈련내용", content: SOP_DEGRADED_DISCLOSURE }],
      sopEvidence: { status: "degraded", sourceLabels: [] },
    });

    expect(inspectSavedMaterialSop(material)).toEqual({ ok: true, issues: [] });
    expect(savedMaterialSopStatus(material)).toBe("degraded");
  });

  it("저장한 훈련계획의 날짜·장소·대상·시간을 표준 HWPX 옵션으로 복원한다", () => {
    const material = savedMaterial("plan", {
      sections: [{ heading: "훈련내용", content: SOP_NOT_FOUND_DISCLOSURE }],
      date: "2026-09-15",
      place: "전북소방교육훈련센터",
      sopEvidence: { status: "not_found", sourceLabels: [] },
    });

    expect(savedMaterialHwpxOptions(material)).toEqual({
      template: "training_plan",
      plan: {
        topic: "산악사고 대비 훈련",
        datetime: "2026-09-15",
        formType: "이론 + 현장실습",
        method: "자체훈련",
        duration: "2시간",
        target: "일반 대원",
        place: "전북소방교육훈련센터",
      },
    });
    expect(savedMaterialHwpxOptions(savedMaterial("lesson", {}))).toBeUndefined();
  });
});

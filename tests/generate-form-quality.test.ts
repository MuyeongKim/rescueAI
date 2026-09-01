import { describe, expect, it } from "vitest";

import {
  hasSlideSopQualityIssues,
  isCompatibleSopEvidenceRefresh,
  isCurrentEvidenceRepairSnapshot,
  localQuality,
  normalizedEvidenceIssueIndices,
  restoreTopicFocusAfterRequestAbort,
  shouldApplyQualityRepairResponse,
  shouldApplyEvidenceRepairResponse,
  shouldForceLegacySopSlideRecovery,
  slideEvidenceIssueIndices,
  slideSopIssueIndices,
} from "@/components/generate/GenerateForm";
import { focusRequestFingerprint } from "@/lib/generate-focus";
import type { GeneratedDoc, GeneratedSlideDeck } from "@/lib/generate";
import { SOP_DEGRADED_DISCLOSURE, SOP_NOT_FOUND_DISCLOSURE } from "@/lib/sop-evidence";

function planWithSopStatus(status: "not_found" | "degraded"): GeneratedDoc {
  const disclosure = status === "not_found" ? SOP_NOT_FOUND_DISCLOSURE : SOP_DEGRADED_DISCLOSURE;
  return {
    title: "산악사고 대비 훈련계획",
    sections: [
      { heading: "훈련목표", content: "산악사고 현장에서 역할을 나누고 안전하게 대응하는 능력을 기른다." },
      { heading: "훈련내용", content: disclosure },
      { heading: "필요장비", content: "개인보호장비와 구조장비를 점검한다." },
      { heading: "안전관리", content: "위험요인을 확인하고 이상 징후가 있으면 즉시 중단·보고한다." },
      { heading: "훈련평가", content: "평가 체크리스트에 따라 정확한 수행과 누락 여부를 확인한다." },
    ],
    sources: [],
    sopEvidence: { status, sourceLabels: [] },
  };
}

describe("편집 후 SOP 상태 경고", () => {
  it("세부 방향 새로고침 중 조건이 바뀌어도 기존 추천과 선택 상태를 함께 복원한다", () => {
    const option = {
      id: "focus-1",
      title: "야간 조난자 수색구역 설정",
      description: "수색구역과 위치정보 공유를 실습합니다.",
      sourceRefs: ["[산악구조 교범 p.12]"],
    };

    expect(
      restoreTopicFocusAfterRequestAbort({
        status: "refreshing",
        options: [option],
        warnings: [],
        recommendedId: option.id,
        selectedId: option.id,
        customValue: "",
        historyCompared: true,
      })
    ).toMatchObject({
      status: "choosing",
      recommendedId: "focus-1",
      selectedId: "focus-1",
    });
  });

  it("선택한 세부 방향만 바뀌어도 새 방향 조회 응답은 폐기하지 않는다", () => {
    const baseRequest = {
      type: "plan",
      category: "산악",
      audience: "구조대원",
      duration: "60분",
      topic: "산악사고 대비 훈련",
      model: "gemini-2.5-pro",
    };

    expect(
      focusRequestFingerprint({ ...baseRequest, focus: "야간 수색과 환자 이송" })
    ).toBe(focusRequestFingerprint({ ...baseRequest, focus: undefined }));
    expect(
      focusRequestFingerprint({
        ...baseRequest,
        audience: "신임 대원",
        duration: "120분",
        conditions: "야간·우천",
      })
    ).toBe(focusRequestFingerprint(baseRequest));
    expect(
      focusRequestFingerprint({ ...baseRequest, focus: "야간 수색과 환자 이송" })
    ).not.toBe(
      focusRequestFingerprint({
        ...baseRequest,
        topic: "수난사고 대비 훈련",
        focus: undefined,
      })
    );
  });

  it("레거시 슬라이드에서만 사용자가 고른 장을 SOP 복구 대상으로 강제한다", () => {
    expect(shouldForceLegacySopSlideRecovery("slide", {})).toBe(true);
    expect(
      shouldForceLegacySopSlideRecovery("slide", {
        sopEvidence: { status: "not_found", sourceLabels: [] },
      })
    ).toBe(false);
    expect(shouldForceLegacySopSlideRecovery("section", {})).toBe(false);
  });

  it("SOP 근거 미확인 결과를 편집해도 경고를 유지한다", () => {
    const quality = localQuality("plan", planWithSopStatus("not_found"), "60분", {
      checked: true,
      repaired: false,
      warnings: ["관련 SOP 근거 미확인 — 시행 전 최신 SOP 확인 필요"],
    });

    expect(quality.warnings).toContain(
      "관련 SOP 근거 미확인 — 시행 전 최신 SOP 확인 필요"
    );
  });

  it("SOP 검색장애 결과를 편집해도 재확인 경고를 유지한다", () => {
    const quality = localQuality("plan", planWithSopStatus("degraded"), "60분", {
      checked: true,
      repaired: false,
      warnings: ["SOP 자료 검색 상태 확인 불가 — 시행 전 다시 확인 필요"],
    });

    expect(quality.warnings).toContain(
      "SOP 자료 검색 상태 확인 불가 — 시행 전 다시 확인 필요"
    );
  });
});

describe("슬라이드 근거 보완 프런트 계약", () => {
  const deck: GeneratedSlideDeck = {
    title: "산악구조 훈련",
    mode: "presenter",
    slides: [
      {
        title: "현장 위험을 먼저 확인합니다",
        bullets: ["낙석과 추락 위험을 확인합니다."],
        notes: "교관이 위험구역 설정 기준을 설명합니다.",
        layout: "safety",
        role: "safety",
        composition: "checklist",
        visual: { mode: "none" },
      },
      {
        title: "구조장비를 교차 점검합니다",
        bullets: ["로프와 확보 장비 상태를 확인합니다."],
        notes: "대원이 서로 장비 상태를 확인하게 합니다.",
        layout: "equipment",
        role: "equipment",
        composition: "checklist",
        visual: { mode: "none" },
        sourceRefs: ["[허용되지 않은 자료 p.9]"],
      },
    ],
    sources: [{ document_id: 1, doc: "산악구조 교범", page: 1 }],
    sourceLabels: ["[산악구조 교범 p.1]"],
  };

  it("누락·허용 밖 출처 오류의 장 번호만 0-based로 중복 없이 찾는다", () => {
    expect(slideEvidenceIssueIndices(deck, "60분")).toEqual([0, 1]);
    expect(normalizedEvidenceIssueIndices([1, 1, 0, -1, 2, "0"], 2)).toEqual([0, 1]);
  });

  it("근거 복구 API가 고치지 않는 시각자료 계약 오류는 자동 근거 복구 대상으로 보내지 않는다", () => {
    const visualOnlyIssue: GeneratedSlideDeck = {
      title: "원문 시각자료 설명",
      mode: "presenter",
      slides: [
        {
          title: "원문 도해에서 차단 위치를 확인합니다",
          bullets: ["원문 도해의 밸브 위치와 접근 동선을 확인합니다."],
          notes: "교관이 원문 도해를 가리키며 접근 전 확인 항목과 안전거리를 설명합니다.",
          layout: "concept",
          role: "evidence",
          composition: "visual-explanation",
          visual: { mode: "source-page", sourceRef: "[화학사고 교재 p.10]" },
          sourceRefs: ["[화학사고 교재 p.10]"],
        },
      ],
      sources: [{ document_id: 1, doc: "화학사고 교재", page: 10 }],
      sourceLabels: ["[화학사고 교재 p.10]"],
      sopEvidence: { status: "not_found", sourceLabels: [] },
    };

    expect(slideEvidenceIssueIndices(visualOnlyIssue, "1시간")).toEqual([]);
  });

  it("실패 응답에 덱이 포함돼도 채택하지 않고 성공 응답만 허용한다", () => {
    const payload = {
      deck,
      repairedIndices: [0],
      unresolvedIndices: [1],
    };

    expect(shouldApplyEvidenceRepairResponse(false, payload)).toBe(false);
    expect(shouldApplyEvidenceRepairResponse(true, payload)).toBe(true);
  });

  it("작업 번호·결과 revision·덱 스냅샷 중 하나라도 바뀌면 오래된 응답을 폐기한다", () => {
    const current = {
      expectedDeck: deck,
      currentDeck: deck,
      operationId: 3,
      activeOperationId: 3,
      expectedResultRevision: 8,
      currentResultRevision: 8,
    };

    expect(isCurrentEvidenceRepairSnapshot(current)).toBe(true);
    expect(isCurrentEvidenceRepairSnapshot({ ...current, activeOperationId: 4 })).toBe(false);
    expect(isCurrentEvidenceRepairSnapshot({ ...current, currentResultRevision: 9 })).toBe(false);
    expect(
      isCurrentEvidenceRepairSnapshot({
        ...current,
        currentDeck: { ...deck, title: "사용자가 편집한 제목" },
      })
    ).toBe(false);
  });

  it("일반 출처 보완은 같은 SOP 상태·라벨 스냅샷만 기존 덱에 적용한다", () => {
    const found = { status: "found" as const, sourceLabels: ["[SOP B p.2]", "[SOP A p.1]"] };

    expect(
      isCompatibleSopEvidenceRefresh(found, {
        status: "found",
        sourceLabels: ["[SOP A p.1]", "[SOP B p.2]"],
      })
    ).toBe(true);
    expect(
      isCompatibleSopEvidenceRefresh(found, {
        status: "not_found",
        sourceLabels: [],
      })
    ).toBe(false);
    expect(
      isCompatibleSopEvidenceRefresh(found, {
        status: "found",
        sourceLabels: ["[다른 SOP p.3]"],
      })
    ).toBe(false);
    expect(
      isCompatibleSopEvidenceRefresh(undefined, {
        status: "not_found",
        sourceLabels: [],
      })
    ).toBe(true);
  });
});

describe("슬라이드 SOP 품질 후속 보완 계약", () => {
  const allowedLabel = "[화학사고 대응 교재 p.10]";
  const deck: GeneratedSlideDeck = {
    title: "암모니아 누출 대응",
    mode: "presenter",
    slides: [
      {
        title: "차단 전에 최신 절차를 확인합니다",
        bullets: [SOP_NOT_FOUND_DISCLOSURE],
        notes: "표준작전절차에 따라 차단밸브를 폐쇄합니다.",
        layout: "safety",
        role: "safety",
        composition: "checklist",
        visual: { mode: "none" },
        sourceRefs: [allowedLabel],
      },
    ],
    sources: [{ document_id: 1, doc: "화학사고 대응 교재", page: 10 }],
    sourceLabels: [allowedLabel],
    sopEvidence: { status: "not_found", sourceLabels: [] },
  };

  it("확인되지 않은 SOP 단정이 있는 정확한 장만 찾는다", () => {
    expect(slideSopIssueIndices(deck, "1시간")).toEqual([0]);
  });

  it("SOP 오류가 네 장 이상이어도 모든 대상 장을 잘라내지 않고 반환한다", () => {
    const manyIssues: GeneratedSlideDeck = {
      ...deck,
      slides: Array.from({ length: 4 }, (_, index) => ({
        ...deck.slides[0],
        title: `차단 절차 ${index + 1}`,
        bullets:
          index === 0
            ? [SOP_NOT_FOUND_DISCLOSURE]
            : [`암모니아 누출 대응 단계 ${index + 1}을 확인합니다.`],
        notes: `표준작전절차에 따라 차단 단계 ${index + 1}을 수행합니다.`,
        role: "procedure" as const,
      })),
    };

    expect(slideSopIssueIndices(manyIssues, "1시간")).toEqual([0, 1, 2, 3]);
  });

  it("SOP 장 후보가 없는 덱은 목표·요약 장을 임의 복구 대상으로 고르지 않는다", () => {
    const noSafeTarget: GeneratedSlideDeck = {
      ...deck,
      slides: [
        {
          ...deck.slides[0],
          title: "학습목표를 확인합니다",
          bullets: ["누출물질 확인 절차를 설명할 수 있습니다."],
          notes: "교관이 오늘 학습할 내용을 안내합니다.",
          role: "objectives",
          composition: "statement",
        },
      ],
    };

    expect(slideSopIssueIndices(noSafeTarget, "1시간")).toEqual([]);
    expect(hasSlideSopQualityIssues(noSafeTarget, "1시간")).toBe(true);
  });

  it("전체 덱 SOP 오류는 절차·안전·근거 장 순서로 안전한 복구 대상을 고른다", () => {
    const deckWideIssue: GeneratedSlideDeck = {
      ...deck,
      slides: [
        {
          ...deck.slides[0],
          title: "근거를 확인합니다",
          bullets: ["교육자료의 근거를 확인합니다."],
          notes: "관련 출처를 설명합니다.",
          role: "evidence",
        },
        {
          ...deck.slides[0],
          title: "안전기준을 확인합니다",
          bullets: ["대원 안전과 중단 기준을 확인합니다."],
          notes: "현장 안전기준을 설명합니다.",
          role: "safety",
        },
        {
          ...deck.slides[0],
          title: "대응 절차를 수행합니다",
          bullets: ["물질 확인과 차단 순서를 수행합니다."],
          notes: "대응 절차를 설명합니다.",
          role: "procedure",
        },
      ],
      sopEvidence: { status: "found", sourceLabels: [allowedLabel] },
    };

    expect(slideSopIssueIndices(deckWideIssue, "1시간")).toEqual([2]);
  });

  it("엄격한 슬라이드와 서버 근거 메타데이터가 모두 있어야 성공 응답을 채택한다", () => {
    const payload = {
      ...deck.slides[0],
      sources: deck.sources,
      sourceLabels: deck.sourceLabels,
      sopEvidence: deck.sopEvidence,
    };

    expect(shouldApplyQualityRepairResponse(true, payload)).toBe(true);
    expect(shouldApplyQualityRepairResponse(false, payload)).toBe(false);
    expect(shouldApplyQualityRepairResponse(true, { ...payload, sourceRefs: [] })).toBe(false);
    expect(shouldApplyQualityRepairResponse(true, { ...payload, sourceLabels: undefined })).toBe(
      false
    );
    expect(shouldApplyQualityRepairResponse(true, { ...payload, sopEvidence: undefined })).toBe(
      false
    );
  });
});

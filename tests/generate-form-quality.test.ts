import { describe, expect, it } from "vitest";

import {
  localQuality,
  shouldForceLegacySopSlideRecovery,
} from "@/components/generate/GenerateForm";
import { focusRequestFingerprint } from "@/lib/generate-focus";
import type { GeneratedDoc } from "@/lib/generate";
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

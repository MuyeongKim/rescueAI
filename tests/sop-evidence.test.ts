import { describe, expect, it } from "vitest";
import {
  SOP_APPLICATION_MARKER,
  SOP_DEGRADED_DISCLOSURE,
  SOP_NOT_FOUND_DISCLOSURE,
  inspectSopContract,
  type SopEvidence,
} from "@/lib/sop-evidence";

const SOP_LABEL = "[재난현장 표준작전절차 SOP 123 p.7]";
const GENERAL_LABEL = "[산악구조 교육교재 p.4]";

function evidence(
  status: SopEvidence["status"],
  sourceLabels: string[] = []
): SopEvidence {
  return { status, sourceLabels };
}

function plan(trainingContent: string, otherContent = "") {
  return {
    sections: [
      { heading: "훈련목표", content: otherContent },
      { heading: "훈련내용", content: trainingContent },
      { heading: "안전관리", content: "안전 확인 후 진행한다." },
    ],
  };
}

function lesson(theoryContent: string, otherContent = "") {
  return {
    sections: [
      { heading: "도입", content: otherContent },
      { heading: "핵심이론", content: theoryContent },
      { heading: "교관시범", content: "교관이 동작을 시범한다." },
    ],
  };
}

describe("inspectSopContract", () => {
  it("확인된 SOP는 훈련내용의 적용 표식과 허용 라벨을 함께 요구한다", () => {
    const report = inspectSopContract(
      "plan",
      plan(`${SOP_APPLICATION_MARKER}\n확인된 순서를 적용한다. ${SOP_LABEL}`),
      evidence("found", [SOP_LABEL])
    );

    expect(report).toEqual({ ok: true, issues: [] });
  });

  it("교안은 핵심이론 밖의 표식과 라벨을 SOP 적용으로 인정하지 않는다", () => {
    const report = inspectSopContract(
      "lesson",
      lesson("핵심 원리를 설명한다.", `${SOP_APPLICATION_MARKER} ${SOP_LABEL}`),
      evidence("found", [SOP_LABEL])
    );

    expect(report.issues.map((issue) => issue.code)).toEqual(["missing_sop_application"]);
  });

  it("문서는 지정 섹션의 표식과 신뢰된 최종 SOP 출처 목록을 연결한다", () => {
    const report = inspectSopContract(
      "plan",
      plan(`${SOP_APPLICATION_MARKER}\n이 절차를 따른다.`),
      evidence("found", [SOP_LABEL])
    );

    expect(report).toEqual({ ok: true, issues: [] });
  });

  it("문서의 확인 상태에 SOP 출처 목록이 비어 있으면 연결 누락으로 보고한다", () => {
    const report = inspectSopContract(
      "plan",
      plan(`${SOP_APPLICATION_MARKER}\n이 절차를 따른다. ${GENERAL_LABEL}`),
      evidence("found", [])
    );

    expect(report.issues.map((issue) => issue.code)).toEqual(["missing_sop_reference"]);
  });

  it("슬라이드는 표식과 허용 SOP sourceRefs가 같은 장에 있어야 한다", () => {
    const separated = inspectSopContract(
      "slides",
      {
        slides: [
          { title: SOP_APPLICATION_MARKER, bullets: ["역할을 확인한다."], sourceRefs: [] },
          { title: "근거", bullets: ["출처를 확인한다."], sourceRefs: [SOP_LABEL] },
        ],
      },
      evidence("found", [SOP_LABEL])
    );
    const together = inspectSopContract(
      "slides",
      {
        slides: [
          {
            title: SOP_APPLICATION_MARKER,
            bullets: ["역할을 확인한다."],
            sourceRefs: [SOP_LABEL],
          },
        ],
      },
      evidence("found", [SOP_LABEL])
    );

    expect(separated.issues.map((issue) => issue.code)).toEqual(["missing_sop_reference"]);
    expect(together).toEqual({ ok: true, issues: [] });
  });

  it("허용 목록 밖의 SOP 라벨을 별도로 탐지한다", () => {
    const unknownLabel = "[재난현장 표준작전절차 SOP 999 p.1]";
    const report = inspectSopContract(
      "plan",
      plan(`${SOP_APPLICATION_MARKER}\n확인된 순서를 적용한다. ${unknownLabel}`),
      evidence("found", [SOP_LABEL])
    );

    expect(report.issues.map((issue) => issue.code)).toEqual(["invalid_sop_reference"]);
    expect(report.issues[0]?.message).toContain(unknownLabel);
  });

  it("실제 라벨을 붙여도 라벨에 없는 SOP 번호를 단정하면 거절한다", () => {
    const report = inspectSopContract(
      "plan",
      plan(
        `${SOP_APPLICATION_MARKER}\nSOP 999에 따라 임의 절차를 반드시 수행한다. ${SOP_LABEL}`
      ),
      evidence("found", [SOP_LABEL])
    );

    expect(report.issues.map((issue) => issue.code)).toContain("unverified_sop_claim");
  });

  it("확인된 SOP 번호와 같은 위치의 허용 라벨은 인정한다", () => {
    const report = inspectSopContract(
      "plan",
      plan(`${SOP_APPLICATION_MARKER}\nSOP 123에 따라 확인된 절차를 적용한다. ${SOP_LABEL}`),
      evidence("found", [SOP_LABEL])
    );

    expect(report).toEqual({ ok: true, issues: [] });
  });

  it("출처 라벨의 페이지 번호를 SOP 식별번호로 인정하지 않는다", () => {
    const report = inspectSopContract(
      "plan",
      plan(`${SOP_APPLICATION_MARKER}\nSOP 7에 따라 임의 절차를 적용한다. ${SOP_LABEL}`),
      evidence("found", [SOP_LABEL])
    );

    expect(report.issues.map((issue) => issue.code)).toContain("unverified_sop_claim");
  });

  it("출처 라벨의 개정년도를 SOP 식별번호로 인정하지 않는다", () => {
    const revisedLabel = "[2026년 개정 재난현장 표준작전절차 SOP 123 p.7]";
    const report = inspectSopContract(
      "plan",
      plan(
        `${SOP_APPLICATION_MARKER}\nSOP 2026에 따라 임의 절차를 적용한다. ${revisedLabel}`
      ),
      evidence("found", [revisedLabel])
    );

    expect(report.issues.map((issue) => issue.code)).toContain("unverified_sop_claim");
  });

  it("콜론 뒤 절차 설명문을 특정 SOP 명칭으로 오인하지 않는다", () => {
    const report = inspectSopContract(
      "plan",
      plan(
        `${SOP_APPLICATION_MARKER}\n표준작전절차: 재난현장에서 공기호흡기를 착용한다. ${SOP_LABEL}`
      ),
      evidence("found", [SOP_LABEL])
    );

    expect(report).toEqual({ ok: true, issues: [] });
  });

  it("따옴표로 명시한 허위 SOP 명칭은 계속 차단한다", () => {
    const report = inspectSopContract(
      "plan",
      plan(
        `${SOP_APPLICATION_MARKER}\n“허구의 공기호흡기 절차” 표준작전절차에 따라 진입한다. ${SOP_LABEL}`
      ),
      evidence("found", [SOP_LABEL])
    );

    expect(report.issues.map((issue) => issue.code)).toContain("unverified_sop_claim");
  });

  it("SOP 미확인 상태는 지정 위치의 정확한 고정 안내문을 요구한다", () => {
    const exact = inspectSopContract(
      "plan",
      plan(SOP_NOT_FOUND_DISCLOSURE),
      evidence("not_found")
    );
    const paraphrased = inspectSopContract(
      "plan",
      plan("관련 SOP는 자료에서 찾지 못했으므로 나중에 확인합니다."),
      evidence("not_found")
    );

    expect(exact).toEqual({ ok: true, issues: [] });
    expect(paraphrased.issues.map((issue) => issue.code)).toEqual([
      "missing_sop_disclosure",
    ]);
  });

  it("검색 저하 상태는 별도의 정확한 고정 안내문을 요구한다", () => {
    const report = inspectSopContract(
      "lesson",
      lesson(SOP_DEGRADED_DISCLOSURE),
      evidence("degraded")
    );

    expect(report).toEqual({ ok: true, issues: [] });
  });

  it.each([
    "SOP 325에 따라 지휘관에게 즉시 보고한다.",
    "표준작전절차: 산악 실종자 수색 절차를 적용한다.",
    "표준작전절차에 따라 2인 1조로 진입한다.",
    "현장활동지침에 따라 수색구역을 설정한다.",
  ])("미확인 상태의 SOP 번호·명칭·절차 단정을 탐지한다: %s", (claim) => {
    const report = inspectSopContract(
      "plan",
      plan(`${SOP_NOT_FOUND_DISCLOSURE}\n${claim}`),
      evidence("not_found")
    );

    expect(report.issues.map((issue) => issue.code)).toContain("unverified_sop_claim");
  });

  it("고정 안내문 자체와 시행 전 SOP 확인 안내는 단정으로 오인하지 않는다", () => {
    const report = inspectSopContract(
      "slides",
      {
        slides: [
          {
            title: "SOP 근거 확인 필요",
            bullets: [SOP_DEGRADED_DISCLOSURE, "교육 담당자는 시행 전 최신 SOP를 확인한다."],
          },
        ],
      },
      evidence("degraded")
    );

    expect(report).toEqual({ ok: true, issues: [] });
  });

  it("미확인 상태에서 제시한 SOP 라벨도 허용하지 않는다", () => {
    const report = inspectSopContract(
      "lesson",
      lesson(`${SOP_NOT_FOUND_DISCLOSURE}\n${SOP_LABEL}`),
      evidence("not_found")
    );

    expect(report.issues.map((issue) => issue.code)).toEqual(["invalid_sop_reference"]);
  });

  it("미확인 상태에서 가짜 현장활동지침을 인용해 절차를 단정하지 못한다", () => {
    const report = inspectSopContract(
      "plan",
      plan(
        `${SOP_NOT_FOUND_DISCLOSURE}\n현장활동지침에 따라 임의 절차를 수행한다. [가짜 현장활동지침 p.99]`
      ),
      evidence("not_found")
    );

    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["unverified_sop_claim", "invalid_sop_reference"])
    );
  });
});

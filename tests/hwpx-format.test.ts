import { describe, expect, it } from "vitest";

import { hwpxParagraphs, normalizeHwpxCellText } from "@/lib/hwpx-format";

describe("HWPX 문단 정규화", () => {
  it("한 줄에 붙은 훈련 단계와 번호·기호 목록을 각각 새 문단으로 나눈다", () => {
    expect(
      normalizeHwpxCellText(
        "[이론교육 · 20분] 핵심 설명 [교관시범 · 20분] 절차 시범"
      )
    ).toBe("[이론교육 · 20분] 핵심 설명\n[교관시범 · 20분] 절차 시범");
    expect(normalizeHwpxCellText("1. 장비 확인 2. 이상 보고")).toBe(
      "1. 장비 확인\n2. 이상 보고"
    );
    expect(normalizeHwpxCellText("· 공기호흡기 · 개인보호장비")).toBe(
      "· 공기호흡기\n· 개인보호장비"
    );
  });

  it("대괄호 안의 가운데점과 일반 문장 괄호를 목록 표지로 오인하지 않는다", () => {
    expect(normalizeHwpxCellText("[실습 · 20분] [관련 SOP 적용]")).toBe(
      "[실습 · 20분]\n[관련 SOP 적용]"
    );
    expect(
      normalizeHwpxCellText(
        "- 유효기간(보관기간 5년, 옷걸이 보관 등) 교육"
      )
    ).toBe("- 유효기간(보관기간 5년, 옷걸이 보관 등) 교육");
  });

  it("소제목·목록·본문을 서로 다른 문단 유형으로 분류한다", () => {
    expect(
      hwpxParagraphs(
        "[반복실습 · 40분] 역할 교대\n- 장비 상태 확인\n교관이 결과를 기록한다."
      )
    ).toEqual([
      { text: "[반복실습 · 40분] 역할 교대", kind: "label" },
      { text: "- 장비 상태 확인", kind: "bullet" },
      { text: "교관이 결과를 기록한다.", kind: "body" },
    ]);
  });
});

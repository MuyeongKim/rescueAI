import { describe, expect, it } from "vitest";
import { generationEvidenceForPart, generationTextParts, inspectTechnicalGrounding, mergeGroundingQuality, technicalValues } from "@/lib/generation-grounding";
import { blockingGenerationQualityIssues, type GeneratedDoc, type GeneratedSlideDeck } from "@/lib/generate";

const doc = (content: string): GeneratedDoc => ({ title: "장비 점검", sections: [{ heading: "훈련내용", content }], sources: [] });

describe("교육자료 기술 수치 근거 대조", () => {
  it("다른 장의 페이지에 같은 수치가 있어도 현재 장의 출처를 대신하지 않는다", () => {
    const evidence = "[장비 A 교범 p.3]\n장비 A 사용압력 30 MPa\n\n---\n\n[장비 B 교범 p.4]\n장비 B 사용압력 20 MPa";
    const deck: GeneratedSlideDeck = { title: "장비 B 점검", sources: [], slides: [{
      title: "장비 B", bullets: ["장비 B 사용압력 30 MPa"], notes: "장비 B 교범의 기준을 확인합니다.", sourceRefs: ["[장비 B 교범 p.4]"],
    }] };
    expect(inspectTechnicalGrounding(deck, evidence).ok).toBe(false);
    expect(generationEvidenceForPart(deck, 0, evidence)).not.toContain("장비 A 사용압력");
    expect(inspectTechnicalGrounding({ ...deck, slides: [{ ...deck.slides[0], bullets: ["장비 B 사용압력 20 MPa"] }] }, evidence).ok).toBe(true);
    expect(generationEvidenceForPart({ ...deck, slides: [{ ...deck.slides[0], sourceRefs: ["[없는 교범 p.4]"] }] }, 0, evidence)).toBe("");
  });
  it("구조가 정상인 문서라도 원문에 없는 99999 MPa를 차단한다", () => {
    const report = inspectTechnicalGrounding(doc("시험압력은 99999 MPa로 설정합니다."), "사용압력 30 MPa");
    expect(report.ok).toBe(false);
    expect(blockingGenerationQualityIssues(report)).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({ code: "unsupported_technical_value", path: "sections.0.content" });
  });

  it("동일한 실제 값의 단위 변환을 허용하고 차원이 다른 값은 허용하지 않는다", () => {
    expect(inspectTechnicalGrounding(doc("300 bar / 50 cm / 1,000 N"), "30 MPa / 0.5m / 1 kN").ok).toBe(true);
    expect(inspectTechnicalGrounding(doc("장비의 시험압력 30 MPa"), "장비 질량 30 kg").ok).toBe(false);
  });
  it("한글·대소문자 압력 단위와 하이픈 범위도 검사한다", () => {
    expect(technicalValues("280바 / 280BAR / 28mpa / 28MPa").map((value) => value.value))
      .toEqual([28e6, 28e6, 28e6, 28e6]);
    expect(inspectTechnicalGrounding(doc("경보45-55바"), "경보4.5~5.5MPa").ok).toBe(true);
    expect(inspectTechnicalGrounding(doc("99999바"), "280bar").ok).toBe(false);
  });
  it("원문 내부의 대괄호 소제목을 출처 경계로 잘라내지 않는다", () => {
    const deck: GeneratedSlideDeck = { title: "점검", sources: [], sourceLabels: ["[공기호흡기 교범 p.1]", "[주의사항]"], slides: [{ title: "점검",
      bullets: ["착용 전 압력 280bar"], notes: "확인", sourceRefs: ["[공기호흡기 교범 p.1]"] }] };
    const evidence = "[공기호흡기 교범 p.1]\n점검 항목\n[주의사항]\n착용 전 압력280bar";
    expect(generationEvidenceForPart(deck, 0, evidence)).toContain("[주의사항]");
    expect(inspectTechnicalGrounding(deck, evidence).ok).toBe(true);
  });
  it("덱 제목은 전체 출처로 검토하되 첫 장 본문은 다른 장 출처로 대신하지 않는다", () => {
    const deck: GeneratedSlideDeck = { title: "300bar 장비 점검", sources: [], slides: [{ title: "교육 목표",
      bullets: ["점검 순서를 설명합니다."], notes: "목표를 확인합니다.", sourceRefs: ["[개요 p.1]"] }] };
    const evidence = "[개요 p.1]\n점검 순서를 설명합니다.\n\n---\n\n[장비 p.2]\n정격 압력300bar";
    expect(inspectTechnicalGrounding(deck, evidence).ok).toBe(true);
    expect(inspectTechnicalGrounding({ ...deck, slides: [{ ...deck.slides[0], bullets: ["압력300bar를 적용합니다."] }] }, evidence).ok).toBe(false);
  });

  it("교육 시간·인원·분량을 기술 한계값으로 오인하지 않는다", () => {
    expect(inspectTechnicalGrounding(doc("20명, 교관 2명, 4개 조가 60분간 3회 실습합니다."), "").ok).toBe(true);
  });

  it("명시된 훈련장의 거리 조건과 Unicode 단위·범위 양끝을 읽는다", () => {
    expect(inspectTechnicalGrounding(doc("6 m 훈련장에서 실시합니다."), "", { conditions: "훈련장 길이 6m" }).ok).toBe(true);
    expect(technicalValues("산소농도 19.5~23.5%, 기온 −10℃, ２０㎝").map((v) => [v.dimension, v.value]))
      .toEqual([["percent", 19.5], ["percent", 23.5], ["temperature", -10], ["length", 0.2]]);
  });

  it.each(["conditions", "topic", "focus"] as const)("요청의 %s에 쓴 기술 한계값을 원문 근거로 취급하지 않는다", (field) => {
    const text = "시험압력 99999 MPa, 산소농도 19.5%, 유해가스 20 ppm, 사용온도 40℃, 허용하중 100 kg 및 1 kN";
    const report = inspectTechnicalGrounding(doc(text), "", { [field]: text });
    expect(report.ok).toBe(false);
    expect(report.issues).toHaveLength(6);
  });

  it.each([
    "실습 체크리스트 항목의 80% 이상 수행하면 통과합니다.",
    "평가 정답률이 80% 이상이면 합격입니다.",
    "수행 평가 점수가 85% 이상이면 통과합니다.",
  ])("교육 평가의 비율은 원문 기술 한계값으로 오인하지 않는다: %s", (text) => {
    expect(inspectTechnicalGrounding(doc(text), "").ok).toBe(true);
  });

  it.each([
    "평가 체크리스트에서 산소농도 80% 이상이면 통과합니다.",
    "산소 포화도를 80%로 유지하면 평가에 합격합니다.",
    "압력이 80%이면 체크리스트 평가를 통과합니다.",
    "농도 80%를 정답률로 기록하면 통과합니다.",
    "체크리스트 평가 점수 101% 이상이면 통과합니다.",
    "80% 이상을 유지합니다.",
  ])("기술 맥락과 일반 비율에는 교육 평가 예외를 적용하지 않는다: %s", (text) => {
    expect(inspectTechnicalGrounding(doc(text), "").ok).toBe(false);
  });

  it("가상훈련 구간과 명시한 훈련장 평면 크기만 시나리오 조건으로 허용한다", () => {
    expect(inspectTechnicalGrounding(doc("가상훈련 구간 길이를 10m로 표시합니다."), "").ok).toBe(true);
    expect(inspectTechnicalGrounding(doc("모의 실습 코스 10 m"), "").ok).toBe(true);
    expect(inspectTechnicalGrounding(doc("훈련장 길이 600 cm에서 실습합니다."), "", { conditions: "훈련장 길이 6m" }).ok).toBe(true);
    expect(inspectTechnicalGrounding(doc("훈련장 길이 10m에서 실습합니다."), "", { conditions: "훈련장 길이 6m" }).ok).toBe(false);
    expect(inspectTechnicalGrounding(doc("훈련장 길이 6m에서 실습합니다."), "", { topic: "훈련장 길이 6m" }).ok).toBe(false);
    expect(inspectTechnicalGrounding(doc("6 m를 유지합니다."), "", { conditions: "훈련장 길이 6m" }).ok).toBe(false);
  });

  it.each([
    "가상훈련 구간의 최소 안전거리는 10m입니다.",
    "가상훈련 구간의 허용 이격 거리는 10m입니다.",
    "가상훈련 구간의 로프 길이는 10m입니다.",
    "가상훈련 구간에서 10m 높이로 올라갑니다.",
    "훈련장 최소 안전거리를 10m로 설정합니다.",
    "훈련장 호스 길이를 10m로 설정합니다.",
  ])("훈련이라는 표현이 기술 안전거리를 면제하지 않는다: %s", (text) => {
    expect(inspectTechnicalGrounding(doc(text), "", { conditions: "훈련장 길이 10m" }).ok).toBe(false);
    expect(inspectTechnicalGrounding(doc(text), text).ok).toBe(true);
  });

  it("기술 한계가 섞인 요청을 훈련장 크기로 재사용하지 않는다", () => {
    expect(inspectTechnicalGrounding(doc("10m 훈련장에서 실시합니다."), "", {
      conditions: "훈련장 최소 안전거리 10m",
    }).ok).toBe(false);
    expect(inspectTechnicalGrounding(doc("10m 훈련장에서 실시합니다."), "", {
      conditions: "훈련장 길이 10m의 로프가 필요합니다.",
    }).ok).toBe(false);
  });

  it("먼저 허용된 교육 수치와 같아도 뒤의 기술 주장과 중복 제거하지 않는다", () => {
    const report = inspectTechnicalGrounding(doc(
      "체크리스트 항목의 80%를 수행하면 통과합니다. 산소농도를 80%로 유지합니다.\n" +
      "가상훈련 구간 10m를 표시합니다. 최소 안전거리는 10m입니다."
    ), "");
    expect(report.issues.map((issue) => issue.excerpt)).toEqual(["80 %", "10 m"]);
  });

  it("전체 문서 제목도 첫 기존 항목에서 검사해 보완 경로와 순서를 유지한다", () => {
    const draft: GeneratedDoc = { ...doc("원문 확인"), title: "99999 MPa 장비 점검", sections: [
      { heading: "첫 항목", content: "원문 확인" }, { heading: "둘째 항목", content: "다른 절차" },
    ] };
    expect(generationTextParts(draft)).toEqual([
      { path: "sections.0.content", text: "99999 MPa 장비 점검\n첫 항목\n원문 확인" },
      { path: "sections.1.content", text: "둘째 항목\n다른 절차" },
    ]);
    expect(inspectTechnicalGrounding(draft, "압력 30MPa").issues).toEqual([
      expect.objectContaining({ path: "sections.0.content", excerpt: "99999 MPa" }),
    ]);
    expect(generationTextParts({ ...draft, sections: [] })).toEqual([{ path: "title", text: draft.title }]);
    expect(inspectTechnicalGrounding({ ...draft, sections: [] }, "").ok).toBe(false);
  });

  it("슬라이드 제목·설명·그림 캡션도 검사한다", () => {
    const deck: GeneratedSlideDeck = { title: "점검", sources: [], slides: [{
      title: "장비 점검", bullets: ["원문 확인"], notes: "절차 설명", visual: { mode: "none", caption: "압력 99999 MPa" },
    }] };
    expect(inspectTechnicalGrounding(deck, "압력 30 MPa").issues).toHaveLength(1);
    const titledDeck = { ...deck, title: "온도 99999℃ 장비 점검" };
    expect(inspectTechnicalGrounding(titledDeck, "압력 99999 MPa").issues).toEqual([
      expect.objectContaining({ path: "slides.0.notes", excerpt: "99999 °C" }),
    ]);
    expect(generationTextParts({ ...titledDeck, slides: [] })).toEqual([{ path: "title", text: titledDeck.title }]);
  });

  it("다른 페이지에 같은 숫자가 있다는 것만으로 적용 조건의 정합성을 보증하지 않는다", () => {
    // 결정론적 값 대조의 한계: 장비/조건은 별도 의미 검토에서 판정한다.
    expect(inspectTechnicalGrounding(doc("장비 B의 사용압력 30 MPa"), "장비 A의 사용압력 30 MPa").ok).toBe(true);
  });

  it("같은 경고를 중복 표시하지 않으며 의미 검토 오류도 핵심 오류로 처리한다", () => {
    const report = inspectTechnicalGrounding(doc("99999MPa"), "");
    const merged = mergeGroundingQuality(report, report, { ok: false, issues: [
      { code: "unsupported_evidence_claim", path: "sections.0.content", message: "장비의 적용 조건이 원문과 다릅니다." },
      { code: "unmet_training_condition", path: "sections.0.content", message: "요청한 장소에서 할 수 없는 훈련입니다." },
    ] });
    expect(blockingGenerationQualityIssues(merged)).toHaveLength(3);
  });
});

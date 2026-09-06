import { describe, expect, it } from "vitest";
import {
  inspectSlideDiagram, slideDiagramSchema, slideDiagramText, validSlideDiagram,
} from "@/lib/slide-diagram";
import {
  blockingGenerationQualityIssues, buildGeneratePrompt, buildSlideRegenPrompt,
  generatedSlideSchema, inspectGeneratedSlides, strictGeneratedSlideSchemaFor,
  type GeneratedSlide,
} from "@/lib/generate";

const process: GeneratedSlide = {
  title: "동작 후 결과를 확인합니다", composition: "process",
  steps: ["점검", "수행", "보고"],
  bullets: ["장비의 손상과 결합 상태를 먼저 점검합니다.", "지정된 동작을 수행한 뒤 동료와 결과를 확인합니다.", "이상이 있으면 중단하고 교관에게 보고합니다."],
  notes: "교관은 단계마다 대원의 확인 결과를 점검합니다.", sourceRefs: ["[교범 p.1]"],
  diagram: { kind: "process", nodes: [
    { stepIndex: 0, bulletIndices: [0] }, { stepIndex: 1, bulletIndices: [1] }, { stepIndex: 2, bulletIndices: [2] },
  ] },
};
const comparison: GeneratedSlide = {
  ...process, composition: "comparison", steps: ["교관", "대원", "실습", "평가"],
  bullets: ["시범을 보입니다.", "동작을 따라 수행합니다.", "수행을 관찰합니다.", "확인 결과를 설명합니다."],
  diagram: { kind: "comparison", columnStepIndices: [0, 1], rows: [
    { labelStepIndex: 2, cells: [[0], [1]] }, { labelStepIndex: 3, cells: [[2], [3]] },
  ] },
};
const decision: GeneratedSlide = {
  ...process, composition: "decision-flow", steps: ["이상 발견 여부", "이상 있음", "이상 없음"],
  bullets: ["수행을 중단하고 교관에게 보고합니다.", "동료 확인 후 다음 교육 동작을 수행합니다."],
  diagram: { kind: "decision", conditionStepIndex: 0, branches: [
    { labelStepIndex: 1, bulletIndices: [0] }, { labelStepIndex: 2, bulletIndices: [1] },
  ] },
};

describe("본문 번호로 연결하는 슬라이드 도식", () => {
  it.each([process, comparison, decision])("모든 기존 문장을 한 번 연결하고 저장·생성 스키마에서 관계를 보존한다", (slide) => {
    expect(inspectSlideDiagram(slide)).toEqual({ valid: true, issues: [] });
    expect(validSlideDiagram(slide)).toEqual(slide.diagram);
    expect(generatedSlideSchema.parse(slide).diagram).toEqual(slide.diagram);
    expect(strictGeneratedSlideSchemaFor(["[교범 p.1]"]).parse(slide).diagram).toEqual(slide.diagram);
    const text = slideDiagramText(slide);
    for (const content of slide.bullets) expect(text.split(content)).toHaveLength(2);
    for (const content of slide.steps!) expect(text).toContain(content);
  });

  it("분기 연결을 바꾸면 원문 검토에 전달하는 조건·행동 연결도 달라진다", () => {
    const changed = { ...decision, diagram: { kind: "decision" as const, conditionStepIndex: 0, branches: [
      { labelStepIndex: 1, bulletIndices: [1] }, { labelStepIndex: 2, bulletIndices: [0] },
    ] } };
    expect(slideDiagramText(decision)).toContain(`이상 있음 → ${decision.bullets[0]}`);
    expect(slideDiagramText(changed)).toContain(`이상 없음 → ${decision.bullets[0]}`);
    expect(slideDiagramText(changed)).not.toBe(slideDiagramText(decision));
  });

  it("구형 판단 흐름에는 임의의 분기나 새 본문을 만들지 않는다", () => {
    const legacy = { ...decision, diagram: undefined };
    expect(inspectSlideDiagram(legacy)).toEqual({ valid: true, issues: [] });
    expect(validSlideDiagram(legacy)).toBeNull();
    expect(slideDiagramText(legacy)).toBe("");
    expect(inspectGeneratedSlides({ title: "교안", slides: [legacy] }, "1시간").issues.some((issue) => issue.code === "invalid_slide_diagram")).toBe(false);
  });

  it.each([
    ["단계 중복", { kind: "process", nodes: [{ stepIndex: 0, bulletIndices: [0] }, { stepIndex: 0, bulletIndices: [1, 2] }] }],
    ["본문 중복", { kind: "process", nodes: [{ stepIndex: 0, bulletIndices: [0] }, { stepIndex: 1, bulletIndices: [0, 1] }, { stepIndex: 2, bulletIndices: [2] }] }],
    ["미연결 단계", { kind: "process", nodes: [{ stepIndex: 0, bulletIndices: [0] }, { stepIndex: 1, bulletIndices: [1, 2] }] }],
    ["미연결 본문", { kind: "process", nodes: [{ stepIndex: 0, bulletIndices: [0] }, { stepIndex: 1, bulletIndices: [1] }, { stepIndex: 2, bulletIndices: [] }] }],
    ["범위 밖", { kind: "process", nodes: [{ stepIndex: 0, bulletIndices: [0] }, { stepIndex: 1, bulletIndices: [1] }, { stepIndex: 4, bulletIndices: [2] }] }],
    ["새 사실 문자열", { kind: "process", nodes: [{ stepIndex: 0, bulletIndices: [0], label: "임의 안전 기준" }, { stepIndex: 1, bulletIndices: [1, 2] }] }],
  ])("%s 도식은 렌더링·공식 저장을 막고 원래 본문을 변경하지 않는다", (_name, diagram) => {
    const slide = { ...process, diagram } as GeneratedSlide;
    const before = JSON.stringify(slide);
    expect(inspectSlideDiagram(slide).valid).toBe(false);
    expect(validSlideDiagram(slide)).toBeNull();
    const report = inspectGeneratedSlides({ title: "교안", slides: [slide] }, "1시간");
    expect(blockingGenerationQualityIssues(report)).toContainEqual(expect.objectContaining({ code: "invalid_slide_diagram", path: expect.stringContaining("slides.0.diagram") }));
    expect(JSON.stringify(slide)).toBe(before);
  });

  it("명시적인 갈림길 이름과 양쪽 행동이 없는 판단 도식은 거절한다", () => {
    expect(slideDiagramSchema.safeParse({ kind: "decision", conditionStepIndex: 0, branches: [{ bulletIndices: [0] }, { bulletIndices: [1] }] }).success).toBe(false);
    expect(inspectSlideDiagram({ ...decision, steps: ["조건", "같음", "같음"] }).valid).toBe(false);
    expect(inspectSlideDiagram({ ...comparison, steps: ["같음", "같음", "행1", "행2"] }).valid).toBe(false);
  });

  it("본문 삭제·단계 추가·구도 변경 뒤의 낡은 연결은 그대로 재사용하지 않는다", () => {
    expect(validSlideDiagram({ ...process, bullets: process.bullets.slice(0, 2) })).toBeNull();
    expect(validSlideDiagram({ ...process, steps: [...process.steps!, "새 단계"] })).toBeNull();
    expect(validSlideDiagram({ ...process, composition: "comparison" })).toBeNull();
  });

  it.each(["process", "list", "statement"] as const)("%s 구도도 초과 단계를 삭제하지 않고 저장 전 진단한다", (composition) => {
    const slide = { ...process, diagram: undefined, composition, steps: ["준비", "확인", "수행", "보고", "평가", "재확인"] };
    const report = inspectGeneratedSlides({ title: "교안", slides: [slide] }, "1시간");
    expect(blockingGenerationQualityIssues(report)).toContainEqual(expect.objectContaining({
      code: "slide_step_count_limit", path: "slides.0.steps",
    }));
    expect(slide.steps).toHaveLength(6);
  });

  it("전체 생성과 한 장 재생성 모두 근거 관계와 모든 항목 연결을 요구한다", () => {
    const request = { type: "slides" as const, category: "화재", topic: "공기호흡기 점검", audience: "일반 대원" as const, duration: "1시간" as const };
    const prompts = [buildGeneratePrompt(request), buildSlideRegenPrompt({ ...request, deckTitle: "교안", outline: [process.title], index: 0, current: process })];
    for (const prompt of prompts) {
      expect(prompt).toContain("conditionStepIndex");
      expect(prompt).toContain("columnStepIndices");
      expect(prompt).toContain("steps와 bullets의 모든 항목을 각각 정확히 한 번");
      expect(prompt).toContain("관계가 불명확하면 diagram을 생략");
    }
  });
});

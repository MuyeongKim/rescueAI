import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildSlideLayoutPlan, inspectSlideDeckLayout } from "@/lib/slide-layout";
import { SlidePlanPreview } from "@/components/generate/SlidePlanPreview";
import { normalizedCompositionPatch } from "@/components/generate/SlideDeckResult";
import type { GeneratedSlide } from "@/lib/generate";

const base: GeneratedSlide = {
  title: "마지막 중단·보고 조건도 화면에서 확인합니다",
  bullets: ["조건확인문장", "수행조치문장", "비상중단문장", "보고재개문장"],
  steps: ["현장평가", "상황판단", "안전조치", "중단보고", "재진입결정"],
  notes: "별도 교관 설명",
};

describe("공통 PPT 화면 구성", () => {
  it("설명 길이가 다른 비교 항목에 필요한 높이를 배정해 작은 글씨를 줄인다", () => {
    const slide: GeneratedSlide = { title: "교관과 대원의 역할", notes: "원문 설명", composition: "comparison", steps: ["교관", "대원"],
      bullets: ["실습 전 장비 상태와 역할을 설명하고 각 대원의 이해 여부를 확인합니다. ".repeat(3).trim(), "결과를 확인합니다.", "동료와 조건을 확인합니다.", "결과를 보고합니다."],
      diagram: { kind: "comparison", columnStepIndices: [0, 1], rows: [{ cells: [[0, 1], [2, 3]] }] } };
    const plan = buildSlideLayoutPlan(slide);
    expect(plan.variant).toBe("comparison-table");
    expect(plan.issues).toEqual([]);
    const long = plan.texts.find((item) => item.id === "bullet-0")!;
    const short = plan.texts.find((item) => item.id === "bullet-1")!;
    expect(long.h).toBeGreaterThan(short.h);
    expect(long.fontSize).toBeGreaterThanOrEqual(20);
    expect(short.fontSize).toBe(long.fontSize);
    expect(long.y + long.h).toBeLessThan(short.y);
    for (const content of [...slide.bullets, ...slide.steps!]) expect(plan.texts.filter((item) => item.text === content)).toHaveLength(1);
  });

  it("긴 절차 설명은 해당 행을 늘려 연결 관계를 유지한 채 배치한다", () => {
    const slide: GeneratedSlide = { title: "확인과 수행 순서", notes: "원문 설명", composition: "process", steps: ["첫 확인", "동료 확인", "수행", "보고"],
      bullets: ["교관은 장비의 연결 상태를 확인하고 실습 전 역할과 중단 조건을 설명합니다. ".repeat(4).trim(), "동료와 확인합니다.", "실습을 수행합니다.", "결과를 보고합니다."],
      diagram: { kind: "process", nodes: [0, 1, 2, 3].map((index) => ({ stepIndex: index, bulletIndices: [index] })) } };
    const plan = buildSlideLayoutPlan(slide);
    expect(plan.variant).toBe("process-rows");
    expect(plan.issues).toEqual([]);
    expect(plan.texts.find((item) => item.id === "bullet-0")!.h).toBeGreaterThan(plan.texts.find((item) => item.id === "bullet-1")!.h);
    for (const content of [...slide.bullets, ...slide.steps!]) expect(plan.texts.filter((item) => item.text === content)).toHaveLength(1);
    for (const item of plan.texts) expect(item.y + item.h).toBeLessThan(6.96);
  });

  it("다섯 단계가 있는 절차를 비교 구도로 바꿔도 중단·보고·재개 단계를 지우지 않는다", () => {
    const patch = normalizedCompositionPatch({ ...base, composition: "process" }, "comparison");
    expect(patch.steps).toEqual(base.steps);
    const plan = buildSlideLayoutPlan({ ...base, ...patch });
    expect(plan.layout).toBe("content");
    expect(plan.issues).toContainEqual(expect.objectContaining({ code: "slide_diagram_unmapped", severity: "warning" }));
    for (const step of base.steps!) expect(plan.texts.some((item) => item.text === step)).toBe(true);
  });
  it.each(["timeline", "decision-flow", "comparison", "list", "summary"] as const)("%s의 모든 문장·단계와 도형을 같은 계획으로 미리 보여 준다", (composition) => {
    const slide = { ...base, composition };
    const plan = buildSlideLayoutPlan(slide, "detailed");
    const html = renderToStaticMarkup(createElement(SlidePlanPreview, { slide, index: 0, accent: "#b91c1c", mode: "detailed" }));
    expect(html).toContain(`data-slide-layout="${plan.layout}"`);
    for (const content of [...slide.bullets, ...slide.steps!]) {
      expect(plan.texts.filter((item) => item.text === content)).toHaveLength(1);
      expect(html).toContain(content);
    }
    for (const item of plan.texts) {
      expect(item.fontSize).toBeGreaterThanOrEqual(16);
      expect(item.y + item.h).toBeLessThan(6.96);
      expect(item.x + item.w).toBeLessThan(13.33);
    }
    if (composition === "decision-flow") expect(html).not.toContain("<polygon");
  });

  it("단계와 설명의 실제 인덱스를 연결하고 임의로 대응시키지 않는다", () => {
    const slide: GeneratedSlide = { ...base, composition: "process", diagram: { kind: "process", nodes: [
      { stepIndex: 0, bulletIndices: [2] }, { stepIndex: 1, bulletIndices: [] },
      { stepIndex: 2, bulletIndices: [0] }, { stepIndex: 3, bulletIndices: [3] }, { stepIndex: 4, bulletIndices: [1] },
    ] } };
    const plan = buildSlideLayoutPlan(slide);
    expect(plan.issues).toEqual([]);
    expect(plan.variant).toBe("process-columns");
    const step = plan.texts.find((item) => item.id === "step-0")!;
    const body = plan.texts.find((item) => item.id === "bullet-2")!;
    expect(Math.abs(body.x - step.x)).toBeLessThan(0.02);
    expect(body.y).toBeGreaterThan(step.y);
    for (const content of [...slide.bullets, ...slide.steps!]) expect(plan.texts.filter((item) => item.text === content)).toHaveLength(1);
  });

  it("내용이 넓은 본문에도 맞지 않으면 전문을 유지하고 정확한 항목을 오류로 안내한다", () => {
    const content = "중단 조건과 보고 절차를 확인합니다. ".repeat(100);
    const slide = { title: "긴 본문", bullets: [content], notes: "교관 설명" };
    const plan = buildSlideLayoutPlan(slide);
    expect(plan.texts.find((item) => item.id === "bullet-0")?.text).toBe(content.trim());
    const report = inspectSlideDeckLayout({ title: "검증", slides: [slide], sources: [] });
    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({ severity: "error", path: "slides.0.bullets.0" }));
    expect(plan.texts.every((item) => item.fontSize >= 16)).toBe(true);
  });
});

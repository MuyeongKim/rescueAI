import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildSlideLayoutPlan } from "@/lib/slide-layout";
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
  it("다섯 단계가 있는 절차를 비교 구도로 바꿔도 중단·보고·재개 단계를 지우지 않는다", () => {
    const patch = normalizedCompositionPatch({ ...base, composition: "process" }, "comparison");
    expect(patch.steps).toEqual(base.steps);
    const plan = buildSlideLayoutPlan({ ...base, ...patch });
    expect(plan.layout).toBe("comparison");
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
    if (composition === "decision-flow") expect(html).toContain("<polygon");
  });
});

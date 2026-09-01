import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CategoryRecommendationPanel } from "@/components/generate/CategoryRecommendationPanel";

type PanelProps = Parameters<typeof CategoryRecommendationPanel>[0];

const noop = () => undefined;

function renderPanel(overrides: Partial<PanelProps> = {}): string {
  const props: PanelProps = {
    topic: "암모니아 누출 대응",
    status: "ready",
    category: "화학사고",
    confidence: "high",
    source: "model",
    confirmed: true,
    alternatives: [],
    categories: ["화학사고", "화재", "일반구조"],
    pickerOpen: false,
    disabled: false,
    onConfirm: noop,
    onTogglePicker: noop,
    onSelect: noop,
    onRetry: noop,
    ...overrides,
  };

  return renderToStaticMarkup(createElement(CategoryRecommendationPanel, props));
}

describe("자료제작 분야 자동 추천 패널", () => {
  it("자동 판정 분야에 추천 표시를 한 번만 하고 완료 상태를 알린다", () => {
    const html = renderPanel();

    expect(html.match(/\(추천\)/g)).toHaveLength(1);
    expect(html).toContain("자동 추천 분야");
    expect(html).toContain("화학사고");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).not.toContain("추천 분야 확인");
  });

  it("확신도가 낮은 추천은 48px 확인 버튼과 명시적인 안내를 제공한다", () => {
    const html = renderPanel({
      confidence: "low",
      confirmed: false,
      alternatives: ["일반구조"],
    });

    expect(html).toContain("추천 분야 확인");
    expect(html).toContain("추천 결과를 한 번 확인해 주세요");
    expect(html).toMatch(/<button[^>]*class="[^"]*min-h-12[^"]*"[^>]*>추천 분야 확인<\/button>/);
    expect(html.match(/\(추천\)/g)).toHaveLength(1);
    expect(html).toContain('id="category-recommendation-change"');
  });

  it("자동 판정 오류는 alert와 재시도·직접 선택 복구 경로를 제공한다", () => {
    const html = renderPanel({
      status: "error",
      category: undefined,
      confidence: undefined,
      source: undefined,
      confirmed: false,
      error: "연결 상태를 확인해 주세요.",
    });

    expect(html).toContain('role="alert"');
    expect(html).toContain("연결 상태를 확인해 주세요.");
    expect(html).toContain("다시 확인");
    expect(html).toContain("분야 직접 선택");
    expect(html).toContain("min-h-12");
  });

  it("분야 변경 목록은 네이티브 라디오와 48px 라벨을 사용한다", () => {
    const html = renderPanel({
      source: "manual",
      pickerOpen: true,
      alternatives: ["일반구조"],
    });

    expect(html).toContain("<fieldset");
    expect(html).toContain("분야 직접 변경");
    expect(html).toContain('type="radio"');
    expect(html).toContain('name="training-category"');
    expect(html).toContain('value="화학사고"');
    expect(html).toContain('checked=""');
    expect(html).toContain("min-h-12");
    expect(html).not.toContain('role="radio"');
    expect(html).not.toContain("(추천)");
  });

  it("두 글자 미만 주제에는 판정 UI를 노출하지 않는다", () => {
    const html = renderPanel({ topic: "암" });

    expect(html).toContain('id="category-recommendation-heading"');
    expect(html).toContain('class="sr-only"');
    expect(html).not.toContain("<section");
  });
});

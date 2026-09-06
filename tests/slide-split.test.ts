import { describe, expect, it } from "vitest";
import { planSlideSplit, replaceSlideRange } from "@/lib/slide-split";
import { inspectSlideDiagram } from "@/lib/slide-diagram";
import { generatedSlideSchema, type GeneratedSlide, type GeneratedSlideDeck } from "@/lib/generate";

const base: GeneratedSlide = { title: "실습 전 준비 사항", bullets: ["원문에 있는 첫 번째 조건입니다.", "동료와 확인하는 두 번째 조건입니다.", "수행 중단과 보고 조건을 확인합니다."],
  notes: "적용 조건과 근거를 포함한 원래 발표자 노트를 전체 보존합니다.", sourceRefs: ["[교범 p.1]"], composition: "list" };

describe("편집 가능한 장 나누기", () => {
  it("본문을 재작성하지 않고 순서를 유지하며 양쪽에 원래 노트와 출처를 남긴다", () => {
    const before = JSON.stringify(base);
    const result = planSlideSplit(base, 12);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slides.flatMap((slide) => slide.bullets)).toEqual(base.bullets);
    expect(result.slides.map((slide) => slide.title)).toEqual([`${base.title} (1/2)`, `${base.title} (2/2)`]);
    for (const slide of result.slides) {
      expect(slide.notes).toBe(base.notes);
      expect(slide.sourceRefs).toEqual(base.sourceRefs);
      expect(generatedSlideSchema.safeParse(slide).success).toBe(true);
    }
    expect(JSON.stringify(base)).toBe(before);
  });

  it("비순차 인덱스인 절차도 단계 순서와 설명 연결을 그대로 다시 매긴다", () => {
    const slide: GeneratedSlide = { ...base, composition: "process", steps: ["점검", "동료 확인", "수행", "중단 보고"],
      bullets: ["중단한 결과를 보고합니다.", "장비 상태를 점검합니다.", "동료가 조건을 확인합니다.", "실습을 수행합니다."],
      diagram: { kind: "process", nodes: [{ stepIndex: 0, bulletIndices: [1] }, { stepIndex: 1, bulletIndices: [2] }, { stepIndex: 2, bulletIndices: [3] }, { stepIndex: 3, bulletIndices: [0] }] } };
    const result = planSlideSplit(slide, 19);
    if (!result.ok) throw new Error(result.reason);
    const connections = (value: GeneratedSlide) => value.diagram?.kind === "process" ? value.diagram.nodes.map((node) => [value.steps![node.stepIndex], node.bulletIndices.map((index) => value.bullets[index])]) : [];
    expect(result.slides.flatMap(connections)).toEqual(connections(slide));
    expect(result.slides.flatMap((part) => part.bullets).sort()).toEqual([...slide.bullets].sort());
    for (const part of result.slides) expect(inspectSlideDiagram(part).valid).toBe(true);
  });

  it.each([
    { ...base, composition: "decision-flow" as const, steps: ["조건", "예", "아니오"] },
    { ...base, composition: "comparison" as const },
    { ...base, steps: ["연결되지 않은 단계", "보고"] },
    { ...base, visual: { mode: "source-page" as const, documentId: 1, page: 1 } },
    { ...base, bullets: ["한 문장 내부는 자동으로 나누지 않습니다."] },
    { ...base, title: "가".repeat(95) },
  ])("조건/원문 관계를 안전하게 나눌 수 없는 자료는 이유를 알려 준다", (slide) => {
    expect(planSlideSplit(slide, 12)).toEqual({ ok: false, reason: expect.any(String) });
  });

  it("짧은 절차를 단일 노드 도식으로 바꾸거나 설명 없는 장을 만들지 않는다", () => {
    const process: GeneratedSlide = { ...base, composition: "process", steps: ["확인", "실행", "보고"], diagram: { kind: "process", nodes: [0, 1, 2].map((index) => ({ stepIndex: index, bulletIndices: [index] })) } };
    expect(planSlideSplit(process, 10).ok).toBe(false);
  });

  it("20장 상한과 다른 편집을 보존하며 변경 없는 분할만 되돌린다", () => {
    expect(planSlideSplit(base, 20).ok).toBe(false);
    const result = planSlideSplit(base, 10);
    if (!result.ok) throw new Error(result.reason);
    const original: GeneratedSlideDeck = { title: "교육", sources: [], slides: [base, { ...base, title: "다른 장" }] };
    const split = replaceSlideRange(original, 0, [base], result.slides);
    expect(split.slides).toHaveLength(3);
    const otherEdited = { ...split, slides: [...split.slides.slice(0, 2), { ...split.slides[2], notes: "다른 장 편집" }] };
    const undo = replaceSlideRange(otherEdited, 0, result.slides, [base]);
    expect(undo.slides[0]).toEqual(base);
    expect(undo.slides[1].notes).toBe("다른 장 편집");
    const edited = { ...split, slides: [{ ...split.slides[0], notes: "새로운 편집" }, ...split.slides.slice(1)] };
    expect(replaceSlideRange(edited, 0, result.slides, [base])).toBe(edited);
    const maximum = { ...original, slides: Array.from({ length: 20 }, () => base) };
    expect(replaceSlideRange(maximum, 0, [base], result.slides)).toBe(maximum);
  });
});

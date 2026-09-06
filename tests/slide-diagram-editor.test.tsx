import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneratedSlide } from "@/lib/generate";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useId: () => "diagram-test",
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[index], (next: unknown) => {
      hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next;
    }];
  },
}));
import { SlideDiagramEditor } from "@/components/generate/SlideDiagramEditor";

type Element = ReactElement<Record<string, unknown>>;
function find(node: ReactNode, predicate: (node: Element) => boolean): Element {
  if (isValidElement<Record<string, unknown>>(node)) {
    if (predicate(node)) return node;
    return find(node.props.children as ReactNode, predicate);
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      try { return find(child, predicate); } catch { /* Next sibling. */ }
    }
  }
  throw new Error("Control not found");
}
const decision: GeneratedSlide = {
  title: "접근 전 판단", composition: "decision-flow", notes: "교관 설명 보존",
  steps: ["안전 조건 확인", "조건 충족", "조건 불충족"], bullets: ["확보 후 접근", "중단 후 보고"],
  sourceRefs: ["[교육 교범 p.2]"],
};

function editor(initial: GeneratedSlide) {
  let slide = initial;
  const onChange = vi.fn();
  const render = () => {
    hooks.cursor = 0;
    return SlideDiagramEditor({ slide, index: 0, disabled: false, onChange });
  };
  return {
    render, onChange, setSlide: (next: GeneratedSlide) => { slide = next; },
    select: (label: string, value: string) => {
      const control = find(render(), (node) => node.props.label === label);
      (control.props.onChange as (value: string) => void)(value);
    },
    button: (text: string) => find(render(), (node) => node.props.children === text && typeof node.props.onClick === "function"),
  };
}

function connectDecision(ui: ReturnType<typeof editor>) {
  ui.select("판단할 조건", "0");
  ui.select("1번 갈림길 이름", "1");
  ui.select("2번 갈림길 이름", "2");
  ui.select("핵심 내용 1을 수행할 갈림길", "0");
  ui.select("핵심 내용 2을 수행할 갈림길", "1");
}

beforeEach(() => { hooks.values = []; hooks.cursor = 0; });

describe("사용자가 확인한 도식 연결만 적용", () => {
  it("빈 선택을 임의 조건으로 채우지 않고 명시적인 조건·행동 선택 뒤 적용한다", () => {
    const original = structuredClone(decision);
    const ui = editor(decision);
    expect(ui.button("도식 연결 적용").props.disabled).toBe(true);
    connectDecision(ui);
    expect(ui.onChange).not.toHaveBeenCalled();
    const apply = ui.button("도식 연결 적용");
    expect(apply.props.disabled).toBe(false);
    (apply.props.onClick as () => void)();
    expect(ui.onChange).toHaveBeenCalledWith({
      kind: "decision", conditionStepIndex: 0,
      branches: [{ labelStepIndex: 1, bulletIndices: [0] }, { labelStepIndex: 2, bulletIndices: [1] }],
    });
    expect(decision).toEqual(original);
  });

  it("같은 번호의 본문이 바뀌어도 작성 중 선택을 새 문장에 적용하지 않는다", () => {
    const ui = editor(decision);
    connectDecision(ui);
    ui.setSlide({ ...decision, bullets: ["변경한 접근 조건", decision.bullets[1]] });
    expect(find(ui.render(), (node) => node.props.role === "alert")).toBeTruthy();
    expect(find(ui.render(), (node) => node.props.label === "핵심 내용 1을 수행할 갈림길").props.value).toBe("0");
    const apply = ui.button("도식 연결 적용");
    expect(apply.props.disabled).toBe(true);
    (apply.props.onClick as () => void)();
    expect(ui.onChange).not.toHaveBeenCalled();
    (ui.button("현재 내용으로 다시 연결").props.onClick as () => void)();
    expect(find(ui.render(), (node) => node.props.label === "핵심 내용 1을 수행할 갈림길").props.value).toBe("");
    expect(ui.button("도식 연결 적용").props.disabled).toBe(true);
  });

  it("선택하기 전 본문·단계를 바꾼 경우 최신 항목으로 경고 없이 시작한다", () => {
    const ui = editor({ ...decision, steps: ["이전 조건", "이전 갈림길"] });
    ui.render();
    ui.setSlide({ ...decision, bullets: ["새 접근 조건", "새 중단 조건", "추가 보고"] });
    expect(() => find(ui.render(), (node) => node.props.role === "alert")).toThrow("Control not found");
    const condition = find(ui.render(), (node) => node.props.label === "판단할 조건");
    expect(condition.props.disabled).toBe(false);
    expect(condition.props.options).toEqual(decision.steps!.map((text, index) => ({ value: String(index), label: `${index + 1}. ${text}` })));
    connectDecision(ui);
    ui.select("핵심 내용 3을 수행할 갈림길", "1");
    expect(ui.button("도식 연결 적용").props.disabled).toBe(false);
    (ui.button("도식 연결 적용").props.onClick as () => void)();
    expect(ui.onChange).toHaveBeenCalledWith({ kind: "decision", conditionStepIndex: 0,
      branches: [{ labelStepIndex: 1, bulletIndices: [0] }, { labelStepIndex: 2, bulletIndices: [1, 2] }] });
  });

  it("선택을 원래대로 비운 경우 이후 본문 변경을 작성 중 연결로 오인하지 않는다", () => {
    const ui = editor(decision);
    ui.select("판단할 조건", "0");
    ui.select("판단할 조건", "");
    ui.setSlide({ ...decision, steps: ["변경 조건", ...decision.steps!.slice(1)] });
    expect(() => find(ui.render(), (node) => node.props.role === "alert")).toThrow("Control not found");
    expect(find(ui.render(), (node) => node.props.label === "판단할 조건").props.disabled).toBe(false);
  });

  it("적용된 연결이 외부에서 바뀌어도 이전 작성 상태로 덮어쓰지 않는다", () => {
    const ui = editor(decision);
    connectDecision(ui);
    ui.setSlide({ ...decision, diagram: {
      kind: "decision", conditionStepIndex: 0,
      branches: [{ labelStepIndex: 1, bulletIndices: [1] }, { labelStepIndex: 2, bulletIndices: [0] }],
    } });
    expect(ui.button("도식 연결 적용").props.disabled).toBe(true);
  });

  it("조건과 갈림길의 중복·연결되지 않은 본문을 허용하지 않는다", () => {
    const ui = editor(decision);
    ui.select("판단할 조건", "0");
    ui.select("1번 갈림길 이름", "0");
    ui.select("2번 갈림길 이름", "2");
    ui.select("핵심 내용 1을 수행할 갈림길", "0");
    expect(ui.button("도식 연결 적용").props.disabled).toBe(true);
    expect(ui.onChange).not.toHaveBeenCalled();
  });

  it("비교 대상과 항목별 설명을 연결하고 원문·발표자 노트·출처를 건드리지 않는다", () => {
    const slide: GeneratedSlide = { ...decision, composition: "comparison", steps: ["방법 A", "방법 B", "확인 기준"], bullets: ["A 특징", "A 확인", "B 특징", "B 확인"] };
    const original = structuredClone(slide);
    const ui = editor(slide);
    ui.select("왼쪽 비교 대상", "0");
    ui.select("오른쪽 비교 대상", "1");
    ui.select("1번 비교 항목 이름 (선택)", "2");
    for (let bullet = 0; bullet < 4; bullet++) ui.select(`핵심 내용 ${bullet + 1}의 비교 위치`, bullet < 2 ? "0:0" : "0:1");
    expect(ui.button("도식 연결 적용").props.disabled).toBe(false);
    (ui.button("도식 연결 적용").props.onClick as () => void)();
    expect(ui.onChange).toHaveBeenCalledWith({ kind: "comparison", columnStepIndices: [0, 1], rows: [{ labelStepIndex: 2, cells: [[0, 1], [2, 3]] }] });
    expect(slide).toEqual(original);
  });

  it("과정 순서를 바꿔도 각 단계에 연결된 설명과 본문을 유지한다", () => {
    const slide: GeneratedSlide = { ...decision, composition: "process", diagram: {
      kind: "process", nodes: [{ stepIndex: 0, bulletIndices: [0] }, { stepIndex: 1, bulletIndices: [] }, { stepIndex: 2, bulletIndices: [1] }],
    } };
    const ui = editor(slide);
    const move = find(ui.render(), (node) => node.props["aria-label"] === "안전 조건 확인 뒤로 이동");
    (move.props.onClick as () => void)();
    (ui.button("도식 연결 적용").props.onClick as () => void)();
    expect(ui.onChange).toHaveBeenCalledWith({ kind: "process", nodes: [
      { stepIndex: 1, bulletIndices: [] }, { stepIndex: 0, bulletIndices: [0] }, { stepIndex: 2, bulletIndices: [1] },
    ] });
    expect(slide.steps).toEqual(decision.steps);
  });

  it("도식 해제는 metadata만 제거하고 입력을 보존한다", () => {
    const slide: GeneratedSlide = { ...decision, diagram: { kind: "decision", conditionStepIndex: 0, branches: [{ labelStepIndex: 1, bulletIndices: [0] }, { labelStepIndex: 2, bulletIndices: [1] }] } };
    const original = structuredClone(slide);
    const ui = editor(slide);
    (ui.button("도식 연결 해제").props.onClick as () => void)();
    expect(ui.onChange).toHaveBeenCalledWith(undefined);
    expect(slide).toEqual(original);
  });
});

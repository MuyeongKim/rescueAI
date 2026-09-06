import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneratedSlideDeck } from "@/lib/generate";
import { replaceSlideRange } from "@/lib/slide-split";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: () => undefined,
  useMemo: (factory: () => unknown) => factory(),
  useRef: (initial: unknown) => ({ current: initial }),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next; }];
  },
}));
import { SlideDeckResult } from "@/components/generate/SlideDeckResult";

type Element = ReactElement<Record<string, unknown>>;
const text = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(text).join("") : isValidElement<Record<string, unknown>>(node) ? text(node.props.children as ReactNode) : "";
function find(node: ReactNode, predicate: (node: Element) => boolean): Element | undefined {
  if (isValidElement<Record<string, unknown>>(node)) return predicate(node) ? node : find(node.props.children as ReactNode, predicate);
  if (Array.isArray(node)) for (const child of node) { const match = find(child, predicate); if (match) return match; }
}
const base: GeneratedSlideDeck = { title: "교육자료", mode: "detailed", sources: [], slides: [{ title: "실습 준비", bullets: ["조건을 확인합니다.", "결과를 기록합니다."], notes: "원문 조건 설명", composition: "list" }] };
function editor(initial = base, saving = false) {
  let deck = structuredClone(initial);
  const onReplace = vi.fn((index, expected, replacement) => { deck = replaceSlideRange(deck, index, expected, replacement); });
  const render = () => {
    hooks.cursor = 0;
    return SlideDeckResult({ deck,
      chrome: { accent: "#b91c1c", editing: true, saving, saved: false, loadedId: null, onToggleEdit: vi.fn(), onSave: vi.fn() },
      regen: { openIndex: null, loadingIndex: null, text: "", onTextChange: vi.fn(), onOpen: vi.fn(), onClose: vi.fn(), onApply: vi.fn() },
      onTitleChange: vi.fn(), onPatchSlide: vi.fn(), onPatchBullet: vi.fn(), onAddSlide: vi.fn(), onDuplicateSlide: vi.fn(), onReplaceSlideRange: onReplace,
      onMoveSlide: vi.fn(), onDeleteSlide: vi.fn(), onDownloadPptx: vi.fn(), pptxLoading: false });
  };
  return { render, onReplace, deck: () => deck, editFirst: () => { deck = { ...deck, slides: [{ ...deck.slides[0], notes: "나눈 후 수정" }, ...deck.slides.slice(1)] }; },
    button: (label: string) => find(render(), (node) => typeof node.props.onClick === "function" && text(node.props.children as ReactNode).trim() === label) };
}
beforeEach(() => { hooks.values = []; hooks.cursor = 0; });

describe("장 나누기 편집 동작", () => {
  it("한 번의 교체로 나누고 즉시 되돌릴 수 있다", () => {
    const ui = editor();
    expect(ui.button("장 나누기")!.props.disabled).toBe(false);
    (ui.button("장 나누기")!.props.onClick as () => void)();
    expect(ui.onReplace).toHaveBeenCalledTimes(1);
    expect(ui.deck().slides).toHaveLength(2);
    (ui.button("나누기 되돌리기")!.props.onClick as () => void)();
    expect(ui.deck()).toEqual(base);
  });
  it("나눈 장이 편집되면 되돌리기로 새 내용을 덮어쓰지 않는다", () => {
    const ui = editor();
    (ui.button("장 나누기")!.props.onClick as () => void)();
    ui.editFirst();
    expect(ui.button("나누기 되돌리기")).toBeUndefined();
    expect(text(ui.render())).toContain("현재 편집 내용은 유지됩니다");
    expect(ui.deck().slides[0].notes).toBe("나눈 후 수정");
  });
  it("저장 중에는 클릭 핸들러를 직접 호출해도 장을 바꾸지 않는다", () => {
    const ui = editor(base, true);
    expect(ui.button("장 나누기")!.props.disabled).toBe(true);
    (ui.button("장 나누기")!.props.onClick as () => void)();
    expect(ui.onReplace).not.toHaveBeenCalled();
  });
  it("판단 조건을 나눌 수 없는 이유를 버튼과 연결해 안내한다", () => {
    const ui = editor({ ...base, slides: [{ ...base.slides[0], composition: "decision-flow", steps: ["조건", "예", "아니오"] }] });
    const button = ui.button("장 나누기")!;
    expect(button.props.disabled).toBe(true);
    expect(button.props["aria-describedby"]).toBe("slide-split-guidance");
    expect(text(find(ui.render(), (node) => node.props.id === "slide-split-guidance"))).toContain("비교·판단 조건");
  });
});

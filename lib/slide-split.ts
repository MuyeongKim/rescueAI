import type { GeneratedSlide, GeneratedSlideDeck } from "@/lib/generate";
import { validSlideDiagram } from "@/lib/slide-diagram";
import { resolveSlideLayout } from "@/lib/slide-layout";
import { conservativeSlideTextMeasure } from "@/lib/slide-text";

export type SlideSplitPlan = { ok: true; slides: [GeneratedSlide, GeneratedSlide]; description: string }
  | { ok: false; reason: string };

/** 문장/연결된 단계 묶음의 경계에서만 나눈다. 문장 내부의 조건이나 수치를 재작성하지 않는다. */
export function planSlideSplit(slide: GeneratedSlide, contentSlideCount: number): SlideSplitPlan {
  if (contentSlideCount >= 20) return { ok: false, reason: "최대 20장입니다. 다른 장을 정리한 뒤 나눌 수 있습니다." };
  if (slide.title.length > 94) return { ok: false, reason: "구분 번호를 넣을 수 있도록 제목을 94자 이내로 다듬어 주세요." };
  if (slide.visual?.mode === "source-page" || slide.visual?.mode === "source-crop") return { ok: false, reason: "원문 그림과 설명의 연결을 유지해야 합니다. 이 장은 복제한 뒤 직접 나누어 주세요." };
  const diagram = validSlideDiagram(slide);
  const base = (part: number): GeneratedSlide => ({ ...slide, title: `${slide.title} (${part}/2)`,
    sourceRefs: slide.sourceRefs ? [...slide.sourceRefs] : undefined, visual: slide.visual ? { ...slide.visual } : undefined });
  const weight = (text: string) => conservativeSlideTextMeasure(text, 22, false);
  if (diagram?.kind === "process") {
    const choices = Array.from({ length: Math.max(0, diagram.nodes.length - 3) }, (_, index) => index + 2)
      .filter((cut) => [diagram.nodes.slice(0, cut), diagram.nodes.slice(cut)].every((nodes) => nodes.some((node) => node.bulletIndices.length > 0)));
    if (!choices.length) return { ok: false, reason: "절차는 각 장에 연결된 단계 2개 이상과 설명이 남을 때 나눌 수 있습니다." };
    const nodeWeight = diagram.nodes.map((node) => weight(slide.steps![node.stepIndex]) + node.bulletIndices.reduce((sum, index) => sum + weight(slide.bullets[index]), 0));
    const cut = choices.sort((a, b) => imbalance(nodeWeight, a) - imbalance(nodeWeight, b))[0];
    const parts = [diagram.nodes.slice(0, cut), diagram.nodes.slice(cut)].map((nodes, part) => {
      const bulletIndices = nodes.flatMap((node) => node.bulletIndices).sort((a, b) => a - b);
      return { ...base(part + 1), steps: nodes.map((node) => slide.steps![node.stepIndex]), bullets: bulletIndices.map((index) => slide.bullets[index]),
        diagram: { kind: "process" as const, nodes: nodes.map((node, stepIndex) => ({ stepIndex, bulletIndices: node.bulletIndices.map((index) => bulletIndices.indexOf(index)) })) } };
    }) as [GeneratedSlide, GeneratedSlide];
    return { ok: true, slides: parts, description: "연결된 절차 묶음을 두 장으로 나눕니다. 단계 순서·설명 연결과 전체 발표자 노트·출처를 유지합니다." };
  }
  if (diagram || slide.diagram || (slide.steps?.length ?? 0) > 0 || ["process", "timeline", "comparison", "decision-flow"].includes(resolveSlideLayout(slide))) {
    return { ok: false, reason: "비교·판단 조건이나 연결이 없는 단계를 자동으로 분리하지 않습니다. 복제 후 관계를 확인하며 직접 나누어 주세요." };
  }
  if (slide.bullets.length < 2) return { ok: false, reason: "핵심 문장이 2개 이상일 때 문장 사이에서 나눌 수 있습니다. 긴 한 문장은 먼저 직접 나누어 주세요." };
  const weights = slide.bullets.map(weight);
  const cut = Array.from({ length: weights.length - 1 }, (_, index) => index + 1).sort((a, b) => imbalance(weights, a) - imbalance(weights, b))[0];
  return { ok: true, slides: [{ ...base(1), bullets: slide.bullets.slice(0, cut) }, { ...base(2), bullets: slide.bullets.slice(cut) }],
    description: "핵심 문장의 순서를 유지해 두 장으로 나눕니다. 전체 발표자 노트와 출처는 두 장 모두에 남습니다." };
}

function imbalance(weights: number[], cut: number) {
  return Math.abs(weights.slice(0, cut).reduce((sum, value) => sum + value, 0) - weights.slice(cut).reduce((sum, value) => sum + value, 0));
}

/** 분할/되돌리기 사이에 바뀐 장을 덮어쓰지 않는 원자적 교체. 다른 장의 편집은 그대로 둔다. */
export function replaceSlideRange(deck: GeneratedSlideDeck, index: number, expected: readonly GeneratedSlide[], replacement: readonly GeneratedSlide[]): GeneratedSlideDeck {
  if (!Number.isInteger(index) || index < 0 || expected.length === 0 || replacement.length === 0 || index + expected.length > deck.slides.length ||
    deck.slides.length - expected.length + replacement.length > 20 || JSON.stringify(deck.slides.slice(index, index + expected.length)) !== JSON.stringify(expected)) return deck;
  return { ...deck, slides: [...deck.slides.slice(0, index), ...replacement, ...deck.slides.slice(index + expected.length)] };
}

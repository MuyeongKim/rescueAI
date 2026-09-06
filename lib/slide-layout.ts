import type { GeneratedSlide, SlideDeckMode } from "@/lib/generate";

/** 웹 미리보기와 PPTX가 함께 쓰는 화면 구성. 좌표는 인치, 글꼴 크기는 pt. */
export type RenderLayout =
  | "objectives" | "process" | "checklist" | "scenario" | "comparison"
  | "timeline" | "decision-flow" | "visual-explanation" | "summary" | "content";
export type SlideColor = "ink" | "body" | "accent" | "muted" | "tint" | "white" | "line";
type Box = { x: number; y: number; w: number; h: number };
export type SlidePlanText = Box & {
  id: string; text: string; fontSize: number; color: SlideColor;
  bold?: boolean; align?: "left" | "center" | "right";
};
export type SlidePlanShape = Box & {
  kind: "rect" | "roundRect" | "ellipse" | "diamond" | "line";
  fill?: SlideColor; stroke?: SlideColor; arrow?: boolean;
};
export type SlideLayoutPlan = {
  layout: RenderLayout; texts: SlidePlanText[]; shapes: SlidePlanShape[];
  image?: Box; dark: boolean;
};
export const SLIDE_TITLE_BOX = { x: 1.54, y: 0.22, w: 11.07, h: 1.02 } as const;
export function slideTitleFontSize(title: string): number {
  const width = Array.from(title.trim()).reduce((total, character) =>
    total + (/\s/.test(character) ? 0.45 : /^[\x00-\xff]$/.test(character) ? 0.62 : 1), 0);
  return width <= 21 ? 35 : width <= 25 ? 32 : 29;
}

/** 분야 색은 도형에 유지하고, 작은 강조 글씨에는 읽을 수 있는 같은 계열 색을 사용한다. */
export function slideAccentTextColor(accent: string, dark = false): string {
  const raw = accent.replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(raw)) return dark ? "#ffffff" : "#1a2b4a";
  let rgb = [0, 2, 4].map((start) => parseInt(raw.slice(start, start + 2), 16));
  const luminance = (channels: number[]) => channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const background = luminance(dark ? [18, 35, 63] : [244, 246, 249]);
  for (let round = 0; round < 20; round += 1) {
    const value = luminance(rgb);
    if ((Math.max(value, background) + 0.05) / (Math.min(value, background) + 0.05) >= 4.5) break;
    rgb = rgb.map((channel) => Math.round(dark ? channel + (255 - channel) * 0.15 : channel * 0.85));
  }
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export const SLIDE_LAYOUT_LABELS: Record<RenderLayout, { label: string; eyebrow: string }> = {
  objectives: { label: "교육 목표", eyebrow: "오늘 교육이 끝나면" },
  process: { label: "절차", eyebrow: "현장 절차" },
  checklist: { label: "점검 목록", eyebrow: "현장 확인 체크" },
  scenario: { label: "상황 사례", eyebrow: "상황을 읽고 대응합니다" },
  comparison: { label: "비교", eyebrow: "두 기준을 나란히 비교합니다" },
  timeline: { label: "시간 흐름", eyebrow: "시간 흐름에 따라 확인합니다" },
  "decision-flow": { label: "판단 흐름", eyebrow: "조건에 따라 다음 행동을 결정합니다" },
  "visual-explanation": { label: "원문 자료와 설명", eyebrow: "원문 시각자료와 함께 확인합니다" },
  summary: { label: "핵심 정리", eyebrow: "교육 핵심 정리" },
  content: { label: "핵심 내용", eyebrow: "핵심 메시지" },
};

export function resolveSlideLayout(slide: GeneratedSlide): RenderLayout {
  const composition = slide.composition;
  if (composition === "process" || composition === "comparison" || composition === "timeline" ||
      composition === "decision-flow" || composition === "visual-explanation" || composition === "summary") return composition;
  if (composition === "checklist") return "checklist";
  if (composition === "scenario") return "scenario";
  if (composition === "statement" || composition === "list") return "content";
  const role = slide.role;
  if (role === "objectives") return "objectives";
  if (role === "procedure") return "process";
  if (role === "equipment" || role === "safety") return "checklist";
  if (role === "comparison") return "comparison";
  if (role === "timeline") return "timeline";
  if (role === "decision") return "decision-flow";
  if (role === "case") return "scenario";
  if (role === "evidence") return "visual-explanation";
  if (role === "summary") return "summary";
  const requested: unknown = slide.layout;
  if (requested === "objectives" || requested === "process" || requested === "summary") return requested;
  if (requested === "equipment" || requested === "safety" || requested === "checklist") return "checklist";
  if (requested === "case" || requested === "scenario") return "scenario";
  if (requested === "concept" || requested === "content") return "content";
  const title = slide.title.replace(/\s+/g, "");
  if (/(학습|교육|훈련)?목표/.test(title)) return "objectives";
  if ((slide.steps ?? []).filter(Boolean).length >= 2) return "process";
  if (/(점검|확인|체크|준비|장비|안전수칙)/.test(title)) return "checklist";
  if (/(사례|상황|시나리오|현장대응)/.test(title)) return "scenario";
  if (/(핵심요약|요약|정리|마무리)/.test(title)) return "summary";
  return "content";
}

/** 모든 문장·단계를 화면에 남긴다. 구도를 바꿔도 잔여 단계가 사라지지 않는다. */
export function buildSlideLayoutPlan(slide: GeneratedSlide, mode: SlideDeckMode = "presenter", occurrence = 0): SlideLayoutPlan {
  const bullets = slide.bullets.map((value) => value.trim()).filter(Boolean);
  const steps = (slide.steps ?? []).map((value) => value.trim()).filter(Boolean);
  let layout = resolveSlideLayout(slide);
  if (layout === "process" && steps.length < 2) layout = "content";
  if ((layout === "comparison" || layout === "scenario") && bullets.length < 2) layout = "content";
  if (layout === "timeline" && steps.length < 3) layout = steps.length >= 2 ? "process" : "content";
  if (layout === "decision-flow" && (steps.length < 3 || bullets.length < 2)) layout = bullets.length >= 2 ? "scenario" : "content";
  const plan: SlideLayoutPlan = { layout, texts: [], shapes: [], dark: layout === "summary" };
  const body = plan.dark ? "white" : "body";
  const font = (value: number) => Math.max(16, value - (mode === "detailed" ? 2 : 0));
  const text = (id: string, value: string, box: Box, size = 20, options: Partial<SlidePlanText> = {}) => {
    if (!value) return;
    let fontSize = font(size);
    const widths = value.split("\n").map((line) => Array.from(line).reduce((width, character) =>
      width + (/\s/.test(character) ? 0.45 : /^[\x00-\xff]$/.test(character) ? 0.62 : 1), 0));
    // 자동 축소는 PowerPoint마다 결과가 다르므로 같은 크기를 두 출력에 전달한다.
    // 한글 긴 문장도 16pt 아래로 줄이지 않으며, 레이아웃은 이 최소 크기의 공간을 확보한다.
    while (fontSize > 16) {
      const lineWidth = Math.max(1, Math.floor(box.w * 72 / fontSize));
      const lines = widths.reduce((count, width) => count + Math.max(1, Math.ceil(width / lineWidth)), 0);
      if (lines * fontSize * 1.12 <= box.h * 72) break;
      fontSize -= 1;
    }
    plan.texts.push({ id, text: value, ...box, fontSize, color: body, ...options });
  };
  const shape = (kind: SlidePlanShape["kind"], box: Box, options: Partial<SlidePlanShape> = {}) => plan.shapes.push({ kind, ...box, ...options });
  const bullet = (index: number, box: Box, size = 20) => text(`bullet-${index}`, bullets[index], box, size);
  const step = (index: number, box: Box, size = 18) => text(`step-${index}`, steps[index], box, size, { bold: true, color: "accent", align: "center" });
  const numberedRows = (indices: number[], x: number, y: number, w: number, h: number) => {
    const row = h / Math.max(1, indices.length);
    indices.forEach((index, position) => {
      text(`number-${index}`, String(index + 1).padStart(2, "0"), { x, y: y + row * position, w: 0.45, h: 0.36 }, 18, { color: "accent", bold: true });
      bullet(index, { x: x + 0.6, y: y + row * position, w: w - 0.6, h: row - 0.1 }, 20);
    });
  };
  const allIndices = bullets.map((_, index) => index);
  const usedSteps = new Set<number>();

  if (layout === "process" || layout === "timeline") {
    const width = 11.3 / Math.max(1, steps.length);
    steps.forEach((_, index) => {
      const center = 1 + width * (index + 0.5);
      if (index < steps.length - 1) shape("line", { x: center, y: 2.5, w: width, h: 0 }, { stroke: "accent", arrow: layout === "process" });
      shape("ellipse", { x: center - 0.25, y: 2.25, w: 0.5, h: 0.5 }, { fill: "accent" });
      text(`step-number-${index}`, String(index + 1), { x: center - 0.25, y: 2.34, w: 0.5, h: 0.3 }, 16, { color: "white", bold: true, align: "center" });
      step(index, { x: center - width / 2 + 0.06, y: 2.92, w: width - 0.12, h: 0.68 });
      usedSteps.add(index);
    });
    const rows = Math.ceil(bullets.length / 2);
    bullets.forEach((_, index) => {
      const x = 0.94 + (index % 2) * 5.95;
      const y = 3.92 + Math.floor(index / 2) * (2.5 / Math.max(1, rows));
      shape("roundRect", { x, y, w: 5.5, h: 2.5 / Math.max(1, rows) - 0.07 }, { fill: "tint" });
      bullet(index, { x: x + 0.18, y: y + 0.06, w: 5.14, h: 2.5 / Math.max(1, rows) - 0.15 }, 19);
    });
  } else if (layout === "decision-flow") {
    bullet(0, { x: 0.94, y: 2.02, w: 11.4, h: 0.62 }, 19);
    shape("diamond", { x: 5.44, y: 2.67, w: 2.42, h: 0.94 }, { fill: "tint", stroke: "accent" });
    step(0, { x: 5.74, y: 2.94, w: 1.82, h: 0.48 }, 16);
    usedSteps.add(0);
    shape("line", { x: 6.65, y: 3.61, w: 0, h: 0.13 }, { stroke: "accent" });
    shape("line", { x: 3.69, y: 3.74, w: 5.95, h: 0 }, { stroke: "accent" });
    [1, 2].forEach((index) => {
      const x = index === 1 ? 0.94 : 6.89;
      shape("line", { x: x + 2.75, y: 3.74, w: 0, h: 0.11 }, { stroke: "accent", arrow: true });
      shape("roundRect", { x, y: 3.85, w: 5.5, h: 1.66 }, { fill: "tint", stroke: "accent" });
      step(index, { x: x + 0.2, y: 4, w: 5.1, h: 0.36 });
      if (bullets[index]) bullet(index, { x: x + 0.2, y: 4.45, w: 5.1, h: 1.01 }, 18);
      usedSteps.add(index);
    });
    // 판단 장의 네 번째 문장은 공통 중단·보고 조건일 수 있으므로 별도 화면 행에 보존한다.
    bullets.slice(3).forEach((_, index) => bullet(index + 3, { x: 0.94, y: 5.67 + index * 0.63, w: 11.4, h: 0.61 }, 18));
  } else if (layout === "comparison") {
    const split = Math.ceil(bullets.length / 2);
    [allIndices.slice(0, split), allIndices.slice(split)].forEach((indices, index) => {
      const x = index === 0 ? 0.94 : 6.89;
      shape("roundRect", { x, y: 2.12, w: 5.5, h: 4.14 }, { fill: "tint", stroke: "line" });
      if (steps[index]) { step(index, { x: x + 0.2, y: 2.32, w: 5.1, h: 0.56 }, 22); usedSteps.add(index); }
      numberedRows(indices, x + 0.2, 3.15, 5.1, 3);
    });
  } else if (layout === "visual-explanation") {
    plan.image = { x: 0.94, y: 2.16, w: 5.7, h: 3.5 };
    const caption = slide.visual?.caption?.trim() || slide.visual?.sourceRef?.trim() || "원문 출처는 발표자 노트에서 확인";
    text("image-caption", caption, { x: 0.94, y: 5.78, w: 5.7, h: 0.6 }, 16, { color: "muted" });
    const rowHeight = 4.27 / Math.max(1, bullets.length);
    bullets.forEach((_, index) => {
      const y = 2.08 + index * rowHeight;
      text(`number-${index}`, String(index + 1).padStart(2, "0"), { x: 7.03, y, w: 0.4, h: 0.36 }, 16, { color: "accent", bold: true });
      bullet(index, { x: 7.56, y, w: 4.75, h: rowHeight - 0.04 }, bullets.length >= 4 ? 16 : 20);
    });
  } else if (layout === "summary") {
    bullets.forEach((_, index) => {
      const x = 0.94 + (index % 2) * 5.95;
      const y = 2.18 + Math.floor(index / 2) * 2.02;
      text(`number-${index}`, String(index + 1).padStart(2, "0"), { x, y, w: 0.5, h: 0.35 }, 18, { color: "accent", bold: true });
      bullet(index, { x: x + 0.64, y, w: 4.9, h: 1.75 }, 23);
    });
  } else if (layout === "objectives" || layout === "checklist") {
    numberedRows(allIndices, 0.94, 2.15, 11.4, 4.3);
  } else if (bullets.length > 1) {
    const mirrored = layout === "content" && occurrence % 2 === 1;
    const x = mirrored ? 7.03 : 0.94;
    shape("rect", { x, y: 2.15, w: 5.25, h: 4.15 }, { fill: "tint" });
    bullet(0, { x: x + 0.28, y: 2.5, w: 4.69, h: 3.3 }, 26);
    numberedRows(allIndices.slice(1), mirrored ? 0.94 : 6.92, 2.32, 5.38, 4.0);
  } else {
    if (bullets.length) bullet(0, { x: 1.15, y: 2.5, w: 11, h: 3.7 }, 30);
  }

  const remaining = steps.map((_, index) => index).filter((index) => !usedSteps.has(index));
  if (remaining.length) {
    // 구도를 바꿔도 남은 단계를 노트로 숨기지 않고 본문 하단에 보존한다.
    const width = 11.4 / remaining.length;
    remaining.forEach((index, position) => step(index, { x: 0.94 + position * width, y: 6.24, w: width - 0.05, h: 0.62 }, 16));
  }
  return plan;
}

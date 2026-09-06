import type { GeneratedSlide, GeneratedSlideDeck, SlideDeckMode } from "@/lib/generate";
import { validSlideDiagram, type SlideDiagram } from "@/lib/slide-diagram";
import { SOURCE_VISUAL_FOCUS_LABELS, validSourceVisualFocus } from "@/lib/source-visual-focus";
import { fitSlideText, fitSlideTitle, type SlideTextMeasurer, type SlideTextBox } from "@/lib/slide-text";
export { SLIDE_FONT_FAMILY, SLIDE_LINE_HEIGHT } from "@/lib/slide-text";
export type { SlideTextMeasurer } from "@/lib/slide-text";

/** 웹 미리보기와 PPTX가 함께 쓰는 화면 구성. 좌표는 인치, 글꼴 크기는 pt. */
export type RenderLayout =
  | "objectives" | "process" | "checklist" | "scenario" | "comparison"
  | "timeline" | "decision-flow" | "visual-explanation" | "summary" | "content";
export type SlideColor = "ink" | "body" | "accent" | "muted" | "tint" | "white" | "line" | "navy";
type Box = SlideTextBox;
export type SlidePlanText = Box & {
  id: string; text: string; fontSize: number; color: SlideColor;
  lines: string[]; bold?: boolean; align?: "left" | "center" | "right";
};
export type SlidePlanShape = Box & {
  kind: "rect" | "roundRect" | "ellipse" | "diamond" | "line";
  fill?: SlideColor; stroke?: SlideColor; arrow?: boolean;
};
export type SlideLayoutPlan = {
  layout: RenderLayout; texts: SlidePlanText[]; shapes: SlidePlanShape[];
  image?: Box; imageContext?: Box; dark: boolean; title: SlidePlanText; issues: SlideLayoutIssue[];
  variant: string;
};
export type SlideLayoutIssue = {
  code: "slide_layout_overflow" | "slide_layout_fallback" | "slide_diagram_unmapped";
  severity: "error" | "warning"; path: string; message: string;
};
export type SlideLayoutOptions = { measureText?: SlideTextMeasurer };
export const SLIDE_TITLE_BOX = { x: 0.8, y: 0.4, w: 11.73, h: 1.12 } as const;
export const SLIDE_COVER_TITLE_BOX = { x: 0.9, y: 2.25, w: 11.55, h: 2.25 } as const;
export function slideTitleFontSize(title: string): number {
  const width = Array.from(title.trim()).reduce((total, character) =>
    total + (/\s/.test(character) ? 0.45 : /^[\x00-\xff]$/.test(character) ? 0.62 : 1), 0);
  return width <= 21 ? 36 : width <= 25 ? 32 : 28;
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

/** 표지와 부록도 같은 글폭·최소 크기 규칙을 사용한다. */
export function coverTitlePlan(title: string, options: SlideLayoutOptions = {}) {
  return fitSlideTitle(title, SLIDE_COVER_TITLE_BOX, [44, 38, 32, 28], options.measureText);
}

function itemPath(id: string): string {
  if (id.startsWith("bullet-")) return `bullets.${id.slice(7)}`;
  if (id.startsWith("step-")) return `steps.${id.slice(5)}`;
  if (id === "title") return "title";
  return "visual.caption";
}

/** 인덱스는 정규화로 다시 매기지 않는다. diagram이 가리키는 원문과 같은 항목을 유지한다. */
export function buildSlideLayoutPlan(slide: GeneratedSlide, mode: SlideDeckMode = "presenter", occurrence = 0,
  options: SlideLayoutOptions = {}): SlideLayoutPlan {
  const bullets = slide.bullets.map((value) => value.trim());
  const steps = (slide.steps ?? []).map((value) => value.trim());
  const requested = resolveSlideLayout(slide);
  const diagram = validSlideDiagram(slide);
  const measure = options.measureText;
  const titleFit = fitSlideTitle(slide.title, SLIDE_TITLE_BOX, [36, 32, 28], measure);
  const title: SlidePlanText = { id: "title", text: slide.title, ...SLIDE_TITLE_BOX,
    fontSize: titleFit.fontSize, lines: titleFit.lines, bold: true, color: requested === "summary" ? "white" : "ink" };
  const headerIssues: SlideLayoutIssue[] = titleFit.fits ? [] : [{ code: "slide_layout_overflow", severity: "error", path: "title",
    message: "슬라이드 제목이 화면을 넘습니다. 결론을 유지해 제목을 짧게 나누어 주세요." }];
  const makePlan = (layout: RenderLayout, variant: string): SlideLayoutPlan => ({
    layout, variant, texts: [], shapes: [], title, issues: [...headerIssues], dark: requested === "summary",
  });
  const overflow = (plan: SlideLayoutPlan, id: string) => plan.issues.push({
    code: "slide_layout_overflow", severity: "error", path: itemPath(id),
    message: id.startsWith("step-") ? "단계 문구가 배정된 공간을 넘습니다. 문구를 나누거나 다른 장으로 옮겨 주세요."
      : "문장이 배정된 공간을 넘습니다. 내용을 다른 장으로 나누거나 핵심 문장을 다듬어 주세요.",
  });
  const add = (plan: SlideLayoutPlan, id: string, value: string, box: Box, sizes: number[],
    settings: { bold?: boolean; color?: SlideColor; align?: "left" | "center" | "right" } = {}) => {
    if (!value) return;
    const fit = fitSlideText(value, box, sizes, settings.bold, measure);
    plan.texts.push({ id, text: value, ...box, fontSize: fit.fontSize, lines: fit.lines,
      color: plan.dark ? "white" : "body", ...settings });
    if (!fit.fits) overflow(plan, id);
  };
  const shape = (plan: SlideLayoutPlan, kind: SlidePlanShape["kind"], box: Box,
    style: Pick<SlidePlanShape, "fill" | "stroke" | "arrow"> = {}) => plan.shapes.push({ kind, ...box, ...style });
  const bullet = (plan: SlideLayoutPlan, index: number, box: Box, sizes = [22, 20, 18], bold = false) =>
    add(plan, `bullet-${index}`, bullets[index] ?? "", box, sizes, { bold });
  const step = (plan: SlideLayoutPlan, index: number, box: Box, sizes = [24, 22, 20], align: "left" | "center" = "left", color: SlideColor = "accent") =>
    add(plan, `step-${index}`, steps[index] ?? "", box, sizes, { bold: true, align, color });
  const describe = (plan: SlideLayoutPlan, indices: number[], box: Box, sizes = [22, 20, 18]) => {
    const gap = indices.length > 1 ? 0.12 : 0;
    const available = box.h - Math.max(0, indices.length - 1) * gap;
    let fontSize = sizes.at(-1) ?? 18;
    let heights: number[] = [];
    for (const size of sizes) {
      fontSize = size;
      heights = indices.map((index) => fitSlideText(bullets[index], { ...box, h: 100 }, [size], false, measure).requiredHeight);
      if (heights.reduce((sum, height) => sum + height, 0) <= available) break;
    }
    const total = heights.reduce((sum, height) => sum + height, 0);
    let y = box.y;
    indices.forEach((index, position) => {
      const h = total <= available ? heights[position] + (available - total) / indices.length : available * heights[position] / total;
      bullet(plan, index, { ...box, y, h }, [fontSize]);
      y += h + gap;
    });
  };
  const bodyErrors = (plan: SlideLayoutPlan) => plan.issues.some((issue) => issue.severity === "error" && issue.path !== "title");
  const groupHeight = (indices: number[], width: number, size = 22) => indices.reduce((sum, index) =>
    sum + fitSlideText(bullets[index], { x: 0, y: 0, w: width, h: 100 }, [size], false, measure).requiredHeight, 0) + Math.max(0, indices.length - 1) * 0.12;
  const rowHeights = (desired: number[], available: number) => {
    const total = desired.reduce((sum, height) => sum + height, 0);
    return desired.map((height) => total <= available ? height + (available - total) / desired.length : height * available / total);
  };

  const generic = (): SlideLayoutPlan => {
    const plan = makePlan(requested === "summary" ? "summary" : "content", "full-width");
    const entries = [
      ...bullets.flatMap((text, index) => text ? [{ text, id: `bullet-${index}`, bold: false }] : []),
      ...steps.flatMap((text, index) => text ? [{ text, id: `step-${index}`, bold: true }] : []),
    ];
    const top = 2.12, height = 4.58, gap = 0.1;
    let size = mode === "detailed" ? 22 : 24;
    let fits = entries.map((entry) => fitSlideText(entry.text, { x: 1.25, y: 0, w: 11.14, h: 100 }, [size], entry.bold, measure));
    for (const candidate of [size, 20, 18, 16]) {
      size = candidate;
      fits = entries.map((entry) => fitSlideText(entry.text, { x: 1.25, y: 0, w: 11.14, h: 100 }, [size], entry.bold, measure));
      if (fits.reduce((sum, fit) => sum + fit.requiredHeight, 0) + Math.max(0, entries.length - 1) * gap <= height) break;
    }
    const total = fits.reduce((sum, fit) => sum + fit.requiredHeight, 0) + Math.max(0, entries.length - 1) * gap;
    let y = top;
    entries.forEach((entry, index) => {
      const h = total <= height ? fits[index].requiredHeight + (height - total) / Math.max(1, entries.length) : (height - (entries.length - 1) * gap) / Math.max(1, entries.length);
      if (entry.bold) step(plan, Number(entry.id.slice(5)), { x: 1.25, y, w: 11.14, h }, [size]);
      else bullet(plan, Number(entry.id.slice(7)), { x: 1.25, y, w: 11.14, h }, [size]);
      add(plan, `marker-${index}`, String(index + 1).padStart(2, "0"), { x: 0.8, y: y + 0.02, w: 0.36, h: 0.33 }, [16], { bold: true, color: "accent" });
      y += h + gap;
    });
    return plan;
  };

  const process = (data: Extract<SlideDiagram, { kind: "process" }>, vertical: boolean) => {
    const plan = makePlan(requested === "timeline" ? "timeline" : "process", vertical ? "process-rows" : "process-columns");
    const count = data.nodes.length;
    if (vertical) {
      const heights = rowHeights(data.nodes.map((node) => Math.max(0.5,
        fitSlideText(steps[node.stepIndex], { x: 0, y: 0, w: 2.5, h: 100 }, [24], true, measure).requiredHeight,
        groupHeight(node.bulletIndices, 8.15)) + 0.12), 4.6);
      let y = 2.1;
      data.nodes.forEach((node, index) => {
        const row = heights[index];
        if (index < count - 1) shape(plan, "line", { x: 1.03, y: y + 0.45, w: 0, h: row - 0.38 }, { stroke: "line", arrow: true });
        shape(plan, "ellipse", { x: 0.8, y, w: 0.46, h: 0.46 }, { fill: "navy" });
        add(plan, `number-${index}`, String(index + 1), { x: 0.8, y: y + 0.06, w: 0.46, h: 0.34 }, [16], { bold: true, color: "white", align: "center" });
        step(plan, node.stepIndex, { x: 1.48, y, w: 2.5, h: row - 0.1 }, [24, 22, 20, 18]);
        describe(plan, node.bulletIndices, { x: 4.22, y, w: 8.15, h: row - 0.12 }, [22, 20, 18, 16]);
        y += row;
      });
    } else {
      const w = 11.6 / count;
      data.nodes.forEach((node, index) => {
        const x = 0.86 + index * w, center = x + w / 2;
        if (index < count - 1) shape(plan, "line", { x: center + 0.28, y: 2.55, w: w - 0.56, h: 0 }, { stroke: "line", arrow: true });
        shape(plan, "ellipse", { x: center - 0.28, y: 2.27, w: 0.56, h: 0.56 }, { fill: index === 1 ? "accent" : "navy" });
        add(plan, `number-${index}`, String(index + 1).padStart(2, "0"), { x: center - 0.28, y: 2.37, w: 0.56, h: 0.36 }, [18], { bold: true, color: "white", align: "center" });
        step(plan, node.stepIndex, { x: x + 0.12, y: 3.2, w: w - 0.24, h: 0.86 }, [30, 26, 22], "center", "ink");
        describe(plan, node.bulletIndices, { x: x + 0.13, y: 4.25, w: w - 0.26, h: 2.32 }, [22, 20, 18]);
      });
    }
    return plan;
  };

  const comparison = (data: Extract<SlideDiagram, { kind: "comparison" }>) => {
    const plan = makePlan("comparison", "comparison-table");
    const xs = [0.9, 6.94], w = 5.48;
    data.columnStepIndices.forEach((index, column) => {
      step(plan, index, { x: xs[column], y: 2.08, w, h: 0.77 }, [30, 26, 22]);
      shape(plan, "line", { x: xs[column], y: 2.94, w, h: 0 }, { stroke: "accent" });
    });
    const rowHeight = 3.52 / data.rows.length;
    data.rows.forEach((row, position) => {
      const y = 3.12 + rowHeight * position;
      const headingH = row.labelStepIndex === undefined ? 0 : 0.49;
      if (row.labelStepIndex !== undefined) step(plan, row.labelStepIndex, { x: 0.9, y, w: 11.52, h: 0.42 }, [18, 16]);
      row.cells.forEach((indices, column) => describe(plan, indices, { x: xs[column], y: y + headingH, w, h: rowHeight - headingH - 0.14 }, [24, 22, 20, 18, 16]));
    });
    return plan;
  };

  const decision = (data: Extract<SlideDiagram, { kind: "decision" }>, rows: boolean) => {
    const plan = makePlan("decision-flow", rows ? "decision-rows" : "decision-branches");
    const box = rows ? { x: 0.9, y: 2.06, w: 11.5, h: 0.79 } : { x: 2.87, y: 2.08, w: 7.59, h: 1.03 };
    shape(plan, "rect", box, { fill: "navy" });
    step(plan, data.conditionStepIndex, { x: box.x + 0.18, y: box.y + 0.13, w: box.w - 0.36, h: box.h - 0.18 }, [28, 24, 20], "center", "white");
    if (rows) {
      const heights = rowHeights(data.branches.map((branch) => Math.max(
        fitSlideText(steps[branch.labelStepIndex], { x: 0, y: 0, w: 3.05, h: 100 }, [24], true, measure).requiredHeight,
        groupHeight(branch.bulletIndices, 8.2)) + 0.08), 3.24);
      let y = 3.23;
      data.branches.forEach((branch, index) => {
        const h = heights[index];
        step(plan, branch.labelStepIndex, { x: 0.9, y, w: 3.05, h }, [28, 24, 20]);
        describe(plan, branch.bulletIndices, { x: 4.2, y, w: 8.2, h }, [22, 20, 18, 16]);
        if (index === 0) shape(plan, "line", { x: 0.9, y: y + h + 0.1, w: 11.5, h: 0 }, { stroke: "line" });
        y += h + 0.2;
      });
    } else {
      shape(plan, "line", { x: 6.66, y: 3.11, w: 0, h: 0.36 }, { stroke: "ink" });
      shape(plan, "line", { x: 3.57, y: 3.47, w: 6.18, h: 0 }, { stroke: "ink" });
      data.branches.forEach((branch, index) => {
        const x = index === 0 ? 0.9 : 6.94;
        shape(plan, "line", { x: index === 0 ? 3.57 : 9.75, y: 3.47, w: 0, h: 0.43 }, { stroke: "accent", arrow: true });
        step(plan, branch.labelStepIndex, { x, y: 4.08, w: 5.48, h: 0.85 }, [30, 26, 22], "center");
        describe(plan, branch.bulletIndices, { x, y: 5.15, w: 5.48, h: 1.42 }, [22, 20, 18]);
      });
    }
    return plan;
  };

  let candidate: SlideLayoutPlan;
  if (diagram?.kind === "process") {
    candidate = process(diagram, false);
    const denseColumns = candidate.texts.some((item) => item.id.startsWith("bullet-") && (item.lines.length > 5 || item.fontSize < 20));
    if (bodyErrors(candidate) || denseColumns) {
      const rows = process(diagram, true);
      if (bodyErrors(candidate) || !bodyErrors(rows)) candidate = rows;
    }
  } else if (diagram?.kind === "comparison") candidate = comparison(diagram);
  else if (diagram?.kind === "decision") {
    candidate = decision(diagram, false);
    if (bodyErrors(candidate)) candidate = decision(diagram, true);
  } else if (["process", "timeline", "comparison", "decision-flow"].includes(requested)) {
    candidate = generic();
    candidate.issues.push({ code: "slide_diagram_unmapped", severity: "warning", path: "diagram",
      message: "단계와 설명의 연결이 확인되지 않아 전체 내용을 본문으로 표시합니다. 도식 연결을 확인하면 절차·비교·판단 구도를 사용할 수 있습니다." });
    return candidate;
  } else if (requested === "visual-explanation") {
    candidate = makePlan(requested, "source-explanation");
    const caption = slide.visual?.caption?.trim() || slide.visual?.sourceRef?.trim() || "원문 출처는 발표자 노트에서 확인";
    const visualHeight = steps.length ? 3.64 : 4.5;
    const focus = validSourceVisualFocus(slide.visual?.sourceFocus);
    const showContext = Boolean(focus && slide.visual?.sourcePageImageData);
    const captionWidth = showContext ? 4.43 : 5.58;
    const sourceRef = slide.visual?.sourceRef?.trim();
    const displayCaption = showContext ? `${SOURCE_VISUAL_FOCUS_LABELS[focus!]} 확대 · 왼쪽은 전체 원문\n${caption}${sourceRef && !caption.includes(sourceRef) ? `\n${sourceRef}` : ""}` : caption;
    const captionFit = fitSlideText(displayCaption, { x: 0.9, y: 0, w: captionWidth, h: 100 }, [16], false, measure);
    const captionHeight = Math.max(showContext ? 1.25 : 0.45, captionFit.requiredHeight + 0.05);
    const imageHeight = Math.max(1.15, visualHeight - captionHeight - 0.14);
    candidate.image = { x: 0.9, y: 2.13, w: 5.58, h: imageHeight };
    if (showContext) candidate.imageContext = { x: 0.9, y: 2.13 + imageHeight + 0.14, w: 1, h: visualHeight - imageHeight - 0.14 };
    add(candidate, "image-caption", displayCaption, { x: showContext ? 2.05 : 0.9, y: 2.13 + imageHeight + 0.14, w: captionWidth, h: visualHeight - imageHeight - 0.14 }, [16], { color: "muted" });
    describe(candidate, bullets.map((_, index) => index), { x: 7.02, y: 2.13, w: 5.37, h: steps.length ? 3.64 : 4.5 }, [22, 20, 18, 16]);
    const w = 11.48 / Math.max(1, steps.length);
    steps.forEach((_, index) => step(candidate, index, { x: 0.9 + w * index, y: 5.98, w: w - 0.08, h: 0.71 }, [18, 16], "center"));
    // 원문 그림을 빼고 본문으로 대체하지 않는다. 남은 넘침은 명시적으로 안내한다.
    return candidate;
  } else if (steps.length === 0 && bullets.length <= 3 && (slide.composition === "statement" || requested === "summary")) {
    candidate = makePlan(requested, "focus");
    const firstW = bullets.length === 1 ? 11.5 : 7.45;
    bullet(candidate, 0, { x: 0.9, y: 2.2, w: firstW, h: 4.25 }, mode === "detailed" ? [36, 32, 28] : [42, 36, 30], true);
    if (bullets.length > 1) {
      shape(candidate, "line", { x: 8.65, y: 2.17, w: 0, h: 4.3 }, { stroke: "line" });
      describe(candidate, bullets.map((_, index) => index).slice(1), { x: 9, y: 2.2, w: 3.35, h: 4.28 }, [24, 22, 20]);
    }
  } else {
    candidate = generic();
    // 평범한 본문에도 기존 의미 역할은 남긴다. 임의의 인과·좌우 관계를 만들지 않는다.
    candidate.layout = requested === "summary" ? "summary" : requested;
    candidate.variant = occurrence % 2 ? "full-width-alternate" : "full-width";
    return candidate;
  }
  if (!bodyErrors(candidate)) return candidate;
  const fallback = generic();
  fallback.issues.push({ code: "slide_layout_fallback", severity: "warning", path: "diagram",
    message: "문장 분량에 맞춰 전체 너비의 본문으로 배치했습니다. 단계와 근거 문장은 모두 유지됩니다." });
  return fallback;
}

export function inspectSlideDeckLayout(deck: GeneratedSlideDeck, options: SlideLayoutOptions = {}): { ok: boolean; issues: SlideLayoutIssue[] } {
  const issues: SlideLayoutIssue[] = [];
  if (!coverTitlePlan(deck.title, options).fits) issues.push({ code: "slide_layout_overflow", severity: "error", path: "title", message: "발표 제목이 표지 공간을 넘습니다. 제목을 짧게 다듬어 주세요." });
  const occurrences = new Map<RenderLayout, number>();
  deck.slides.forEach((slide, index) => {
    const layout = resolveSlideLayout(slide);
    const occurrence = occurrences.get(layout) ?? 0;
    occurrences.set(layout, occurrence + 1);
    const plan = buildSlideLayoutPlan(slide, deck.mode ?? "presenter", occurrence, options);
    issues.push(...plan.issues.map((issue) => ({ ...issue, path: `slides.${index}.${issue.path}` })));
  });
  return { ok: !issues.some((issue) => issue.severity === "error"), issues };
}

export class SlideLayoutError extends Error {
  readonly issues: SlideLayoutIssue[];
  constructor(issues: SlideLayoutIssue[]) {
    super("PPT 화면을 넘는 내용이 있습니다. 표시된 장을 나누거나 문장을 다듬은 뒤 다운로드해 주세요.");
    this.name = "SlideLayoutError";
    this.issues = issues;
  }
}

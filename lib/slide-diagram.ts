import { z } from "zod";

const stepIndex = z.number().int().min(0).max(4).describe("현재 steps 배열의 0부터 시작하는 번호");
const bulletIndex = z.number().int().min(0).max(3).describe("현재 bullets 배열의 0부터 시작하는 번호");

/** 관계만 저장한다. 설명·조건·분기 이름은 기존 본문을 참조하며 새 사실 문자열을 만들지 않는다. */
export const slideDiagramSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("process"),
    nodes: z.array(z.object({ stepIndex, bulletIndices: z.array(bulletIndex).max(4) }).strict()).min(2).max(5),
  }).strict(),
  z.object({
    kind: z.literal("comparison"),
    columnStepIndices: z.array(stepIndex).length(2),
    rows: z.array(z.object({
      labelStepIndex: stepIndex.optional(),
      cells: z.array(z.array(bulletIndex).min(1).max(4)).length(2),
    }).strict()).min(1).max(2),
  }).strict(),
  z.object({
    kind: z.literal("decision"),
    conditionStepIndex: stepIndex,
    branches: z.array(z.object({
      labelStepIndex: stepIndex,
      bulletIndices: z.array(bulletIndex).min(1).max(4),
    }).strict()).length(2),
  }).strict(),
]);

export type SlideDiagram = z.infer<typeof slideDiagramSchema>;
export type SlideDiagramIssue = { path: string; message: string };
type DiagramSlide = {
  steps?: readonly string[];
  bullets: readonly string[];
  composition?: string;
  diagram?: unknown;
};

/** 생략된 구형 자료는 정상이다. 제공한 도식은 본문의 모든 항목을 정확히 한 번 연결해야 한다. */
export function inspectSlideDiagram(slide: DiagramSlide): { valid: boolean; issues: SlideDiagramIssue[] } {
  if (slide.diagram === undefined) return { valid: true, issues: [] };
  const parsed = slideDiagramSchema.safeParse(slide.diagram);
  if (!parsed.success) return { valid: false, issues: parsed.error.issues.map((issue) => ({
    path: ["diagram", ...issue.path].join("."),
    message: "도식의 종류·항목 수·참조 번호를 확인하세요. 기존 본문의 번호만 연결할 수 있습니다.",
  })) };
  const diagram = parsed.data;
  const issues: SlideDiagramIssue[] = [];
  const seen = { steps: new Set<number>(), bullets: new Set<number>() };
  const referenceItem = (source: "steps" | "bullets", index: number, path: string) => {
    const values = slide[source] ?? [];
    if (index >= values.length || !values[index]?.trim()) {
      issues.push({ path, message: `${source === "steps" ? "단계" : "본문"} ${index + 1}번이 없거나 비어 있습니다. 연결을 다시 선택하세요.` });
    } else if (seen[source].has(index)) {
      issues.push({ path, message: `${source === "steps" ? "단계" : "본문"} ${index + 1}번을 중복 연결했습니다. 각 항목은 한 번만 사용하세요.` });
    }
    seen[source].add(index);
  };
  const useBullets = (indices: number[], path: string) => indices.forEach((index, position) => referenceItem("bullets", index, `${path}.${position}`));
  if (diagram.kind === "process") {
    diagram.nodes.forEach((node, index) => {
      referenceItem("steps", node.stepIndex, `diagram.nodes.${index}.stepIndex`);
      useBullets(node.bulletIndices, `diagram.nodes.${index}.bulletIndices`);
    });
  } else if (diagram.kind === "comparison") {
    diagram.columnStepIndices.forEach((index, position) => referenceItem("steps", index, `diagram.columnStepIndices.${position}`));
    diagram.rows.forEach((row, rowIndex) => {
      if (row.labelStepIndex !== undefined) referenceItem("steps", row.labelStepIndex, `diagram.rows.${rowIndex}.labelStepIndex`);
      row.cells.forEach((cell, column) => useBullets(cell, `diagram.rows.${rowIndex}.cells.${column}`));
    });
  } else {
    referenceItem("steps", diagram.conditionStepIndex, "diagram.conditionStepIndex");
    diagram.branches.forEach((branch, index) => {
      referenceItem("steps", branch.labelStepIndex, `diagram.branches.${index}.labelStepIndex`);
      useBullets(branch.bulletIndices, `diagram.branches.${index}.bulletIndices`);
    });
  }
  for (const source of ["steps", "bullets"] as const) {
    (slide[source] ?? []).forEach((_value, index) => {
      if (!seen[source].has(index)) issues.push({ path: "diagram", message: `${source === "steps" ? "단계" : "본문"} ${index + 1}번이 도식에 연결되지 않았습니다. 모든 내용을 연결하거나 도식을 해제하세요.` });
    });
  }
  const expected = diagram.kind === "process" ? ["process", "timeline"] : diagram.kind === "decision" ? ["decision-flow"] : ["comparison"];
  if (slide.composition && !expected.includes(slide.composition)) issues.push({ path: "diagram.kind", message: "현재 화면 구도와 도식 종류가 다릅니다. 구도에 맞게 연결을 다시 설정하세요." });
  const labels = diagram.kind === "comparison" ? diagram.columnStepIndices
    : diagram.kind === "decision" ? diagram.branches.map((branch) => branch.labelStepIndex) : [];
  if (labels.length === 2 && slide.steps?.[labels[0]]?.trim() === slide.steps?.[labels[1]]?.trim()) {
    issues.push({ path: "diagram", message: "양쪽 기준 또는 분기 이름이 같습니다. 서로 다른 조건을 명확히 표시하세요." });
  }
  return { valid: issues.length === 0, issues };
}

/** 렌더러는 null일 때 전체 본문을 일반 배치로 표시하고 관계를 추측하지 않는다. */
export function validSlideDiagram(slide: DiagramSlide): SlideDiagram | null {
  if (slide.diagram === undefined || !inspectSlideDiagram(slide).valid) return null;
  return slideDiagramSchema.parse(slide.diagram);
}

/** 원문 검토에도 실제 그려지는 연결을 전달한다. 본문 인용은 그대로 유지한다. */
export function slideDiagramText(slide: DiagramSlide): string {
  const diagram = validSlideDiagram(slide);
  if (!diagram) return "";
  const step = (index: number) => slide.steps![index];
  const bullets = (indices: number[]) => indices.map((index) => slide.bullets[index]).join(" / ");
  if (diagram.kind === "process") return "[도식 연결: 과정]\n" + diagram.nodes.map((node, index) =>
    `${index + 1}. ${step(node.stepIndex)}${node.bulletIndices.length ? ` → ${bullets(node.bulletIndices)}` : ""}`).join("\n");
  if (diagram.kind === "comparison") return "[도식 연결: 비교]\n" + diagram.rows.flatMap((row) => row.cells.map((cell, column) =>
    `${row.labelStepIndex === undefined ? "" : `${step(row.labelStepIndex)} / `}${step(diagram.columnStepIndices[column])} → ${bullets(cell)}`)).join("\n");
  return `[도식 연결: 판단]\n조건: ${step(diagram.conditionStepIndex)}\n` + diagram.branches.map((branch) =>
    `${step(branch.labelStepIndex)} → ${bullets(branch.bulletIndices)}`).join("\n");
}

/** 전체 생성과 한 장 재생성이 같은 관계 작성 규칙을 사용한다. */
export const SLIDE_DIAGRAM_PROMPT = `도식 diagram은 기존 steps·bullets의 0부터 시작하는 번호만 연결합니다. 새 문장이나 사실을 diagram에 쓰지 마세요.
- process/timeline: kind=process, nodes의 stepIndex는 단계 번호, bulletIndices는 그 단계의 설명 번호입니다. 설명이 없는 단계는 빈 배열을 씁니다.
- comparison: kind=comparison, columnStepIndices는 양쪽 기준명 2개의 단계 번호, rows의 cells는 각 열에 대응하는 본문 번호 배열 2개입니다. 행 이름이 있으면 labelStepIndex로 단계 번호를 연결합니다.
- decision-flow: kind=decision, conditionStepIndex는 판단 조건의 단계 번호, branches는 분기 2개입니다. labelStepIndex는 명시적인 각 분기 이름의 단계 번호, bulletIndices는 해당 조건에서 할 행동의 본문 번호입니다. steps는 조건 1개와 서로 다른 분기 이름 2개로 구성하세요.
- 도식을 쓰면 steps와 bullets의 모든 항목을 각각 정확히 한 번 연결하세요. 번호 중복·범위 밖 참조·내용 누락은 허용하지 않습니다.
- 원문에서 과정 순서·비교 대응·판단 조건과 분기 행동의 관계가 확인될 때만 연결하세요. 관계가 불명확하면 diagram을 생략하고 일반 본문으로 전달하세요. 기존 단계나 문장을 도식에 맞추려고 삭제하지 마세요.`;

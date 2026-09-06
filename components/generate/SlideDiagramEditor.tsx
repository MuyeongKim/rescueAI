"use client";

import { useId, useState } from "react";
import type { GeneratedSlide } from "@/lib/generate";
import { inspectSlideDiagram, validSlideDiagram, type SlideDiagram } from "@/lib/slide-diagram";
import { Button } from "@/components/ui/button";

type DiagramKind = SlideDiagram["kind"];
type DiagramDraft = {
  order: number[];
  columns: number[];
  rowLabels: number[];
  condition: number;
  branches: number[];
  targets: string[];
};

export function editableDiagramKind(composition: string | undefined): DiagramKind | null {
  if (composition === "process" || composition === "timeline") return "process";
  if (composition === "comparison") return "comparison";
  if (composition === "decision-flow") return "decision";
  return null;
}

function diagramBasis(slide: GeneratedSlide): string {
  return JSON.stringify([slide.composition, slide.steps, slide.bullets, slide.diagram]);
}

function initialDraft(slide: GeneratedSlide): DiagramDraft {
  const diagram = validSlideDiagram(slide);
  const draft: DiagramDraft = {
    order: (slide.steps ?? []).map((_, index) => index),
    columns: [-1, -1], rowLabels: [-1], condition: -1, branches: [-1, -1],
    targets: slide.bullets.map(() => ""),
  };
  if (diagram?.kind === "process") {
    draft.order = diagram.nodes.map((node) => node.stepIndex);
    for (const node of diagram.nodes) for (const index of node.bulletIndices) draft.targets[index] = String(node.stepIndex);
  } else if (diagram?.kind === "comparison") {
    draft.columns = [...diagram.columnStepIndices];
    draft.rowLabels = diagram.rows.map((row) => row.labelStepIndex ?? -1);
    diagram.rows.forEach((row, rowIndex) => row.cells.forEach((cell, column) => {
      for (const index of cell) draft.targets[index] = `${rowIndex}:${column}`;
    }));
  } else if (diagram?.kind === "decision") {
    draft.condition = diagram.conditionStepIndex;
    draft.branches = diagram.branches.map((branch) => branch.labelStepIndex);
    diagram.branches.forEach((branch, branchIndex) => {
      for (const index of branch.bulletIndices) draft.targets[index] = String(branchIndex);
    });
  }
  return draft;
}

function diagramCandidate(kind: DiagramKind, draft: DiagramDraft): SlideDiagram {
  const assigned = (target: string) => draft.targets.flatMap((value, index) => value === target ? [index] : []);
  if (kind === "process") return {
    kind, nodes: draft.order.map((stepIndex) => ({ stepIndex, bulletIndices: assigned(String(stepIndex)) })),
  };
  if (kind === "comparison") return {
    kind, columnStepIndices: [...draft.columns],
    rows: draft.rowLabels.map((label, row) => ({
      ...(label >= 0 ? { labelStepIndex: label } : {}),
      cells: [assigned(`${row}:0`), assigned(`${row}:1`)],
    })),
  };
  return {
    kind, conditionStepIndex: draft.condition,
    branches: draft.branches.map((labelStepIndex, branch) => ({ labelStepIndex, bulletIndices: assigned(String(branch)) })),
  };
}

function ReferenceSelect({ id, label, value, options, onChange, emptyLabel = "선택해 주세요", disabled }: {
  id: string; label: string; value: string; options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void; emptyLabel?: string; disabled: boolean;
}) {
  return <label htmlFor={id} className="block min-w-0 space-y-1.5 text-base">
    <span className="font-medium">{label}</span>
    <select id={id} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}
      className="min-h-12 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60">
      <option value="">{emptyLabel}</option>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </label>;
}

/** 연결만 편집한다. 작성 중인 선택은 명시적 적용 전 본문·저장 결과를 바꾸지 않는다. */
export function SlideDiagramEditor({ slide, index, disabled, onChange }: {
  slide: GeneratedSlide; index: number; disabled: boolean; onChange: (diagram: SlideDiagram | undefined) => void;
}) {
  const id = useId();
  const [state, setState] = useState(() => ({ basis: diagramBasis(slide), draft: initialDraft(slide), edited: false }));
  const kind = editableDiagramKind(slide.composition);
  if (!kind) return null;
  const basis = diagramBasis(slide);
  // 아직 선택을 바꾸지 않았다면 본문 편집 후 처음 열어도 최신 항목으로 시작한다.
  // 실제 작성 중인 연결만 이전 기준에 묶어, 다른 문장에 잘못 적용되지 않게 한다.
  const current = !state.edited && state.basis !== basis
    ? { basis, draft: initialDraft(slide), edited: false }
    : state;
  const { draft } = current;
  const stale = current.basis !== basis;
  const steps = slide.steps ?? [];
  const candidate = diagramCandidate(kind, draft);
  const checked = inspectSlideDiagram({ ...slide, diagram: candidate });
  const messages = Array.from(new Set(checked.issues.map((issue) => issue.message)));
  const ready = !stale && checked.valid;
  const stepOptions = steps.map((text, step) => ({ value: String(step), label: `${step + 1}. ${text || "빈 단계"}` }));
  const stepLabel = (step: number, fallback: string) => steps[step]?.trim() || fallback;
  const update = (patch: Partial<DiagramDraft>) => {
    const nextDraft = { ...draft, ...patch };
    setState({ basis, draft: nextDraft, edited: JSON.stringify(nextDraft) !== JSON.stringify(initialDraft(slide)) });
  };
  const selectionDisabled = disabled || stale;
  const targetOptions = kind === "process" ? draft.order.map((step) => ({ value: String(step), label: stepLabel(step, `단계 ${step + 1}`) }))
    : kind === "decision" ? draft.branches.map((step, branch) => ({ value: String(branch), label: `${branch + 1}번 갈림길 · ${stepLabel(step, "갈림길 이름 선택 전")}` }))
      : draft.rowLabels.flatMap((label, row) => draft.columns.map((columnStep, column) => ({
        value: `${row}:${column}`, label: `${row + 1}번 항목${label >= 0 ? ` ${stepLabel(label, "")}` : ""} · ${column === 0 ? "왼쪽" : "오른쪽"} ${stepLabel(columnStep, "비교 대상 선택 전")}`,
      })));

  return <details className="rounded-lg border border-border/70 bg-muted/20" data-slide-diagram-editor>
    <summary className="min-h-12 cursor-pointer px-3 py-3 text-base font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      도식 연결 설정 · {validSlideDiagram(slide) ? "연결됨" : "연결 확인 필요"}
    </summary>
    <div className="space-y-4 border-t p-3">
      <p className="text-base leading-relaxed text-muted-foreground">
        {kind === "decision" ? "판단 조건 1개와 갈림길 2개를 고르고, 각 상황에서 할 행동을 연결하세요."
          : kind === "comparison" ? "왼쪽·오른쪽 비교 대상과 비교 항목을 고르고, 각 대상의 설명을 연결하세요."
            : "단계의 순서를 확인하고 각 핵심 문장을 해당 단계에 연결하세요."}
        {" "}이 장에 입력한 단계와 문장을 각각 한 번씩 사용합니다. 이름과 내용은 위 입력란에서 수정할 수 있습니다.
      </p>
      {stale && <div role="alert" className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-base leading-relaxed text-amber-950 dark:bg-amber-950/40 dark:text-amber-100">
        <p>본문·단계 또는 적용된 연결이 바뀌었습니다. 작성 중인 선택은 유지했으며, 현재 내용으로 다시 연결한 뒤 적용해 주세요.</p>
        <Button type="button" variant="outline" className="min-h-12 bg-background text-base" disabled={disabled}
          onClick={() => setState({ basis, draft: initialDraft(slide), edited: false })}>현재 내용으로 다시 연결</Button>
      </div>}
      <fieldset disabled={selectionDisabled} className="min-w-0 space-y-4">
        <legend className="sr-only">슬라이드 {index + 1} 도식 관계</legend>
        {kind === "process" && <ol className="space-y-2" aria-label="도식의 단계 순서">
          {draft.order.map((step, position) => <li key={step} className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background p-3">
            <span className="min-w-0 break-words text-base">{position + 1}. {stepLabel(step, "빈 단계")}</span>
            <div className="flex shrink-0 gap-2">{([-1, 1] as const).map((direction) => <Button key={direction} type="button" variant="outline" className="min-h-12 min-w-12 text-base"
              disabled={selectionDisabled || position + direction < 0 || position + direction >= draft.order.length}
              aria-label={`${stepLabel(step, `단계 ${step + 1}`)} ${direction < 0 ? "앞으로" : "뒤로"} 이동`}
              onClick={() => {
                const order = [...draft.order];
                [order[position], order[position + direction]] = [order[position + direction], order[position]];
                update({ order });
              }}>{direction < 0 ? "앞으로" : "뒤로"}</Button>)}</div>
          </li>)}
        </ol>}
        {kind === "decision" && <div className="space-y-3">
          <ReferenceSelect id={`${id}-condition`} label="판단할 조건" value={draft.condition < 0 ? "" : String(draft.condition)} options={stepOptions} disabled={selectionDisabled}
            onChange={(value) => update({ condition: value === "" ? -1 : Number(value) })} />
          <div className="grid gap-3 sm:grid-cols-2">{draft.branches.map((step, branch) => <ReferenceSelect key={branch} id={`${id}-branch-${branch}`} label={`${branch + 1}번 갈림길 이름`}
            value={step < 0 ? "" : String(step)} options={stepOptions} disabled={selectionDisabled}
            onChange={(value) => update({ branches: draft.branches.map((current, position) => position === branch ? value === "" ? -1 : Number(value) : current) })} />)}</div>
          {steps.length !== 3 && <p className="text-base leading-relaxed text-amber-800 dark:text-amber-200">판단 도식에는 조건·갈림길로 사용할 단계가 총 3개 필요합니다. 현재 {steps.length}개를 삭제하거나 합치지 않고 그대로 보관 중입니다.</p>}
        </div>}
        {kind === "comparison" && <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">{draft.columns.map((step, column) => <ReferenceSelect key={column} id={`${id}-column-${column}`} label={`${column === 0 ? "왼쪽" : "오른쪽"} 비교 대상`}
            value={step < 0 ? "" : String(step)} options={stepOptions} disabled={selectionDisabled}
            onChange={(value) => update({ columns: draft.columns.map((current, position) => position === column ? value === "" ? -1 : Number(value) : current) })} />)}</div>
          {draft.rowLabels.map((step, row) => <ReferenceSelect key={row} id={`${id}-row-${row}`} label={`${row + 1}번 비교 항목 이름 (선택)`} emptyLabel="별도 항목 이름 없음"
            value={step < 0 ? "" : String(step)} options={stepOptions} disabled={selectionDisabled}
            onChange={(value) => update({ rowLabels: draft.rowLabels.map((current, position) => position === row ? value === "" ? -1 : Number(value) : current) })} />)}
          <Button type="button" variant="outline" className="min-h-12 text-base" disabled={selectionDisabled}
            onClick={() => update(draft.rowLabels.length === 1 ? { rowLabels: [...draft.rowLabels, -1] }
              : { rowLabels: draft.rowLabels.slice(0, 1), targets: draft.targets.map((target) => target.startsWith("1:") ? "" : target) })}>
            {draft.rowLabels.length === 1 ? "두 번째 비교 항목 추가" : "두 번째 비교 항목 연결 해제"}
          </Button>
          <p className="text-base leading-relaxed text-muted-foreground">비교 항목은 최대 2개이며 각 항목의 양쪽 설명이 필요합니다. 연결을 해제해도 본문과 단계는 보존합니다.</p>
        </div>}
        <div className="space-y-3">{slide.bullets.map((text, bullet) => <div key={bullet} className="min-w-0 space-y-2 rounded-md border bg-background p-3">
          <p className="whitespace-pre-wrap break-words text-base leading-relaxed"><span className="font-semibold">핵심 내용 {bullet + 1}</span>{" · "}{text || "본문을 먼저 입력해 주세요."}</p>
          <ReferenceSelect id={`${id}-bullet-${bullet}`} label={kind === "decision" ? `핵심 내용 ${bullet + 1}을 수행할 갈림길` : kind === "comparison" ? `핵심 내용 ${bullet + 1}의 비교 위치` : `핵심 내용 ${bullet + 1}에 연결할 단계`}
            value={draft.targets[bullet] ?? ""} options={targetOptions} disabled={selectionDisabled}
            onChange={(value) => update({ targets: draft.targets.map((current, position) => position === bullet ? value : current) })} />
        </div>)}</div>
      </fieldset>
      {!stale && !checked.valid && <div id={`${id}-help`} className="rounded-md border bg-background p-3 text-base leading-relaxed" aria-live="polite">
        <p className="font-medium">연결을 적용하기 전에 확인해 주세요.</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">{messages.slice(0, 4).map((message) => <li key={message}>{message}</li>)}</ul>
        {messages.length > 4 && <p className="mt-1">연결을 선택하면 나머지 {messages.length - 4}개 항목도 차례로 확인할 수 있습니다.</p>}
      </div>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" className="min-h-12 text-base" disabled={disabled || !ready} aria-describedby={!stale && !checked.valid ? `${id}-help` : undefined}
          onClick={() => {
            if (!ready || disabled) return;
            onChange(candidate);
            setState({ basis: diagramBasis({ ...slide, diagram: candidate }), draft, edited: false });
          }}>도식 연결 적용</Button>
        <Button type="button" variant="outline" className="min-h-12 text-base" disabled={disabled || slide.diagram === undefined}
          onClick={() => {
            onChange(undefined);
            const next = { ...slide, diagram: undefined };
            setState({ basis: diagramBasis(next), draft: initialDraft(next), edited: false });
          }}>도식 연결 해제</Button>
      </div>
    </div>
  </details>;
}

/** 확대하지 않아도, 보조기술에서도 같은 조건·대상·설명 연결을 읽을 수 있게 한다. */
export function SlideDiagramReadable({ slide }: { slide: GeneratedSlide }) {
  const diagram = validSlideDiagram(slide);
  if (!diagram) return null;
  const step = (index: number) => slide.steps![index];
  const descriptions = (indices: number[]) => <ul className="list-disc space-y-1.5 pl-5 text-base leading-relaxed">{indices.map((index) => <li key={index} className="whitespace-pre-wrap break-words">{slide.bullets[index]}</li>)}</ul>;
  if (diagram.kind === "process") return <ol className="space-y-3" aria-label="단계와 연결된 설명">{diagram.nodes.map((node, index) => <li key={node.stepIndex} className="space-y-1.5">
    <p className="text-base font-semibold">{index + 1}. {step(node.stepIndex)}</p>{descriptions(node.bulletIndices)}
  </li>)}</ol>;
  if (diagram.kind === "decision") return <div className="space-y-3" aria-label="판단 조건과 갈림길별 행동">
    <p className="text-base font-semibold">판단 조건: {step(diagram.conditionStepIndex)}</p>
    {diagram.branches.map((branch) => <section key={branch.labelStepIndex} className="space-y-1.5 rounded-md border p-3">
      <h4 className="text-base font-semibold">{step(branch.labelStepIndex)}</h4>{descriptions(branch.bulletIndices)}
    </section>)}
  </div>;
  return <div className="overflow-x-auto rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" role="region" tabIndex={0} aria-label="비교 대상별 설명">
    <table className="w-full min-w-[420px] text-left text-base"><caption className="sr-only">비교 항목과 대상별 설명</caption>
      <thead><tr><th className="border-b p-3" scope="col">비교 항목</th>{diagram.columnStepIndices.map((index) => <th key={index} className="border-b p-3" scope="col">{step(index)}</th>)}</tr></thead>
      <tbody>{diagram.rows.map((row, index) => <tr key={index}><th className="border-b p-3 align-top font-medium" scope="row">{row.labelStepIndex === undefined ? "설명" : step(row.labelStepIndex)}</th>
        {row.cells.map((cell, column) => <td key={column} className="border-b p-3 align-top">{descriptions(cell)}</td>)}
      </tr>)}</tbody>
    </table>
  </div>;
}

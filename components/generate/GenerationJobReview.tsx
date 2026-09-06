"use client";

import { useEffect, useState } from "react";
import type { PublicGenerationJob } from "@/lib/generation-job";
import type { GenerationOutlineEdit, GenerationOutlineReview } from "@/lib/generation-job-review";

export type GenerationJobReviewProps = {
  job: PublicGenerationJob;
  busy?: boolean;
  onApprove: (outline: GenerationOutlineEdit, revision?: number) => void;
  onRepair: (indices: number[]) => void;
  onOpenDraft?: (draft: Record<string, unknown>) => void;
};
const fieldClass = "mt-1 min-h-12 w-full rounded-xl border border-border bg-background px-3 py-2 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const lines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);

function OutlineEditor({ outline, revision, job, busy, onApprove }: { outline: GenerationOutlineReview; revision: number; job: PublicGenerationJob; busy?: boolean; onApprove: GenerationJobReviewProps["onApprove"] }) {
  const [baseOutline, setBaseOutline] = useState(outline);
  const [baseRevision, setBaseRevision] = useState(revision);
  const [title, setTitle] = useState(outline.title);
  const [items, setItems] = useState<GenerationOutlineEdit["items"]>(outline.items.map(({ title, purpose, keyPoints, actionRequirements, minutes }) => ({ title, purpose, keyPoints, actionRequirements, minutes })));
  const [keyPointText, setKeyPointText] = useState(outline.items.map((item) => item.keyPoints.join("\n")));
  const [actionText, setActionText] = useState(outline.items.map((item) => item.actionRequirements.join("\n")));
  const [confirmReload, setConfirmReload] = useState(false);
  const changedElsewhere = job.revision !== baseRevision || job.status !== "awaiting_review";
  const currentItems = items.map((item, index) => ({ ...item, keyPoints: lines(keyPointText[index] ?? ""), actionRequirements: lines(actionText[index] ?? "") }));
  const expectedMinutes = baseOutline.items.reduce((total, item) => total + (item.minutes ?? 0), 0);
  const totalMinutes = items.reduce((total, item) => total + (item.minutes ?? 0), 0);
  const timeValid = baseOutline.type === "slides" || (totalMinutes === expectedMinutes && items.every((item, index) => baseOutline.items[index].minutes === null || (item.minutes ?? 0) > 0));
  const patch = (index: number, values: Partial<GenerationOutlineEdit["items"][number]>) => setItems((current) => current.map((item, position) => position === index ? { ...item, ...values } : item));
  const validation = [
    ...(title.trim().length < 4 || title.length > 100 ? ["자료 제목은 4~100자로 입력해 주세요."] : []),
    ...currentItems.flatMap((item, index) => [
      ...(item.title.trim().length < 1 || item.title.length > 100 ? [`${index + 1}번 제목은 1~100자로 입력해 주세요.`] : []),
      ...(item.purpose.trim().length < 4 || item.purpose.length > 300 ? [`${index + 1}번 중점 내용은 4~300자로 입력해 주세요.`] : []),
      ...(item.actionRequirements.length > 6 || item.keyPoints.length > 6 ? [`${index + 1}번 핵심 내용과 행동 기준은 각각 최대 6줄입니다.`] : []),
      ...([...item.actionRequirements, ...item.keyPoints].some((line) => line.length > 160) ? [`${index + 1}번 핵심 내용과 행동 기준은 한 줄에 160자 이내로 입력해 주세요.`] : []),
      ...(item.minutes != null && (!Number.isInteger(item.minutes) || item.minutes < 1 || item.minutes > 240) ? [`${index + 1}번 시간은 1~240분의 정수로 입력해 주세요.`] : []),
    ]),
  ];
  const reloadLatest = () => {
    if (!job.outlineReview || job.status !== "awaiting_review") return;
    const latest = job.outlineReview;
    setBaseOutline(latest); setBaseRevision(job.revision); setTitle(latest.title);
    setItems(latest.items.map(({ title, purpose, keyPoints, actionRequirements, minutes }) => ({ title, purpose, keyPoints, actionRequirements, minutes })));
    setKeyPointText(latest.items.map((item) => item.keyPoints.join("\n")));
    setActionText(latest.items.map((item) => item.actionRequirements.join("\n")));
    setConfirmReload(false);
  };
  return <section className="space-y-4 rounded-2xl border border-primary/25 bg-card p-4 sm:p-6" aria-labelledby="generation-outline-heading">
    <div><h3 id="generation-outline-heading" className="text-lg font-semibold">본문 제작 전 목차 확인</h3><p className="mt-1 text-sm leading-relaxed text-muted-foreground">제목·중점 내용·시간을 확인하세요. 각 항목을 펼쳐 수정한 뒤 본문 제작을 시작할 수 있습니다.</p></div>
    {changedElsewhere && <div role="alert" className="space-y-2 rounded-xl bg-amber-50 p-3 text-sm leading-relaxed text-amber-950 dark:bg-amber-950/30 dark:text-amber-100"><p>작업 상태가 변경되었습니다. 이 화면에서 입력한 목차는 보존했으며, 이전 개정의 목차로 다시 진행할 수 없습니다.</p>{job.status === "awaiting_review" && job.outlineReview ? <>{confirmReload ? <><p>최신 목차를 불러오면 이 화면의 편집 내용이 바뀝니다.</p><div className="flex flex-wrap gap-2"><button type="button" onClick={reloadLatest} disabled={busy} className="min-h-12 rounded-lg border border-current px-3">최신 목차로 바꾸기</button><button type="button" onClick={() => setConfirmReload(false)} className="min-h-12 rounded-lg px-3">편집본 유지</button></div></> : <button type="button" onClick={() => setConfirmReload(true)} disabled={busy} className="min-h-12 rounded-lg border border-current px-3">최신 목차 불러오기</button>}</> : <p>현재 작업의 진행 상태를 확인해 주세요. 아래 편집본은 복사하거나 비교할 수 있습니다.</p>}</div>}
    <label className="block text-sm font-medium">자료 제목<input value={title} maxLength={100} disabled={busy} onChange={(event) => setTitle(event.target.value)} className={fieldClass} /></label>
    {baseOutline.evidenceGaps.length > 0 && <div className="rounded-xl bg-amber-50 p-3 text-sm leading-relaxed text-amber-950 dark:bg-amber-950/30 dark:text-amber-100"><p className="font-medium">추가 확인할 근거 {baseOutline.evidenceGaps.length}개</p><ul className="mt-2 list-disc space-y-1 pl-5">{baseOutline.evidenceGaps.map((gap, index) => <li key={index}>{gap.itemIndex + 1}번 · {gap.requirement}</li>)}</ul><p className="mt-2">본문 제작 시 사용자 조건과 안전 항목을 우선 검색합니다. 확인되지 않는 내용은 추정하지 않고 구분합니다.</p></div>}
    <div className="space-y-2">{items.map((item, index) => <details key={index} className="rounded-xl border border-border p-3">
      <summary className="min-h-12 cursor-pointer content-center text-base font-medium">{index + 1}. {item.title}{item.minutes != null ? ` · ${item.minutes}분` : ""}</summary>
      <div className="mt-3 space-y-3">
        {baseOutline.type === "slides" && <label className="block text-sm font-medium">슬라이드 제목<input value={item.title} maxLength={100} disabled={busy} onChange={(event) => patch(index, { title: event.target.value })} className={fieldClass} /></label>}
        <label className="block text-sm font-medium">중점 내용<textarea value={item.purpose} rows={2} maxLength={300} disabled={busy} onChange={(event) => patch(index, { purpose: event.target.value })} className={fieldClass} /></label>
        {baseOutline.type !== "slides" && <label className="block text-sm font-medium">핵심 내용 · 최대 6줄, 한 줄 160자<textarea value={keyPointText[index] ?? ""} rows={3} maxLength={3000} disabled={busy} onChange={(event) => setKeyPointText((current) => current.map((text, position) => position === index ? event.target.value : text))} className={fieldClass} /></label>}
        <label className="block text-sm font-medium">행동·확인 기준 · 최대 6줄, 한 줄 160자<textarea value={actionText[index] ?? ""} rows={3} maxLength={3000} disabled={busy} onChange={(event) => setActionText((current) => current.map((text, position) => position === index ? event.target.value : text))} className={fieldClass} /></label>
        {baseOutline.items[index].minutes !== null && <label className="block text-sm font-medium">배정 시간(분)<input type="number" min={1} max={240} value={item.minutes ?? 0} disabled={busy} onChange={(event) => patch(index, { minutes: Number(event.target.value) })} className={fieldClass} /></label>}
        <p className="text-sm text-muted-foreground">연결된 참고 근거 {baseOutline.items[index].sourceRefs.length}개</p>
      </div>
    </details>)}</div>
    {baseOutline.type !== "slides" && <p role={timeValid ? undefined : "alert"} className={timeValid ? "text-sm text-muted-foreground" : "text-sm text-destructive"}>시간 합계 {totalMinutes}분 / 교육 시간 {expectedMinutes}분{timeValid ? "" : " · 합계와 각 단계 시간을 맞춰 주세요."}</p>}
    {validation.length > 0 && <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-destructive">{validation.map((message) => <li key={message}>{message}</li>)}</ul>}
    <button type="button" className="min-h-12 w-full rounded-xl bg-primary px-4 py-3 text-base font-semibold text-primary-foreground disabled:opacity-50 sm:w-auto" disabled={busy || changedElsewhere || !timeValid || validation.length > 0} onClick={() => onApprove({ title, items: currentItems }, baseRevision)}>{busy ? "진행 준비 중…" : "이 목차로 본문 제작"}</button>
  </section>;
}

function QualityReview({ job, busy, onRepair, onOpenDraft }: GenerationJobReviewProps) {
  const issues = job.qualityIssues ?? [];
  const draftParts = job.reviewDraft?.sections ?? job.reviewDraft?.slides;
  const count = Array.isArray(draftParts) ? draftParts.length : 0;
  const issueIndices = Array.from(new Set(issues.flatMap((issue) => {
    const match = issue.path.match(/^(?:sections|slides)\.(\d+)(?:\.|$)/);
    return match ? [Number(match[1])] : Array.from({ length: count }, (_, index) => index);
  }))).filter((index) => index >= 0 && index < count);
  const [selected, setSelected] = useState<number[]>(issueIndices);
  return <section className="space-y-4 rounded-2xl border border-amber-300/60 bg-card p-4 sm:p-6" aria-labelledby="generation-quality-review-heading">
    <div><h3 id="generation-quality-review-heading" className="text-lg font-semibold">보완할 내용 확인</h3><p className="mt-1 text-sm leading-relaxed text-muted-foreground">아래 초안은 검토용입니다. 수정 후 원문 근거와 전체 품질 검사를 다시 통과해야 완성본이 됩니다.</p></div>
    {issues.length > 0 && <ul className="space-y-3">{issues.map((issue, index) => <li key={`${issue.code}:${issue.path}:${index}`} className="rounded-xl border border-border p-3"><p className="font-medium">{issue.blocking ? "필수 보완" : "개선 권장"} · {issue.path.match(/^(?:sections|slides)\.(\d+)/) ? `${Number(issue.path.match(/^(?:sections|slides)\.(\d+)/)![1]) + 1}번 항목` : "전체 구성"}</p><p className="mt-1 text-sm leading-relaxed">{issue.message}</p><p className="mt-1 text-sm leading-relaxed text-muted-foreground">{issue.suggestion}</p></li>)}</ul>}
    {issueIndices.length > 0 && <fieldset><legend className="text-sm font-medium">AI로 보완할 항목</legend><div className="mt-2 flex flex-wrap gap-2">{issueIndices.map((index) => <label key={index} className="flex min-h-12 cursor-pointer items-center gap-2 rounded-xl border border-border px-3"><input type="checkbox" className="size-5 accent-primary" disabled={busy} checked={selected.includes(index)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, index] : current.filter((value) => value !== index))} />{index + 1}번</label>)}</div></fieldset>}
    <div className="flex flex-col gap-2 sm:flex-row">{issueIndices.length > 0 && <button type="button" disabled={busy || !selected.length} onClick={() => onRepair(selected)} className="min-h-12 rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground disabled:opacity-50">선택 항목 AI 보완</button>}{job.reviewDraft && onOpenDraft && <button type="button" disabled={busy} onClick={() => onOpenDraft(job.reviewDraft!)} className="min-h-12 rounded-xl border border-border px-4 py-3 font-medium disabled:opacity-50">검토용 초안 열고 수정</button>}</div>
  </section>;
}

export function GenerationJobReview(props: GenerationJobReviewProps) {
  const [heldOutline, setHeldOutline] = useState<{ outline: GenerationOutlineReview; revision: number } | null>(() => props.job.outlineReview ? { outline: props.job.outlineReview, revision: props.job.revision } : null);
  useEffect(() => {
    if (!heldOutline && props.job.outlineReview) setHeldOutline({ outline: props.job.outlineReview, revision: props.job.revision });
  }, [heldOutline, props.job.outlineReview, props.job.revision]);
  const snapshot = heldOutline ?? (props.job.outlineReview ? { outline: props.job.outlineReview, revision: props.job.revision } : null);
  const waiting = props.job.status === "awaiting_review";
  return <div className="space-y-4">
    {snapshot && <details open={waiting} className={waiting ? "" : "rounded-xl border border-border p-3"}>
      <summary className={waiting ? "hidden" : "min-h-12 cursor-pointer content-center text-sm font-medium"}>이 화면의 목차 편집본</summary>
      <OutlineEditor key={props.job.id} outline={snapshot.outline} revision={snapshot.revision} job={props.job} busy={props.busy} onApprove={props.onApprove} />
    </details>}
    {["needs_attention", "failed", "cancelled"].includes(props.job.status) && (props.job.reviewDraft || props.job.qualityIssues?.length) && <QualityReview key={`${props.job.id}:${props.job.revision}`} {...props} />}
  </div>;
}

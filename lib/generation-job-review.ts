import { z } from "zod";
import { durationMinutes, extractSourceLabels, type GenerationQualityIssue } from "@/lib/generate";
import { outlineEvidenceGaps, type EvidenceOutlineItem } from "@/lib/generation-evidence-coverage";
import type { ValidatedGenerateRequest } from "@/lib/generation-request";
import type { Json } from "@/lib/database.types";

const textList = (max: number) => z.array(z.string().trim().min(1).max(160)).max(max);
export const generationOutlineEditSchema = z.object({
  title: z.string().trim().min(4).max(100),
  items: z.array(z.object({
    title: z.string().trim().min(1).max(100),
    purpose: z.string().trim().min(4).max(300),
    keyPoints: textList(6).optional(),
    actionRequirements: textList(6),
    minutes: z.number().int().min(0).max(240).nullable().optional(),
  }).strict()).min(1).max(20),
}).strict();
export type GenerationOutlineEdit = z.infer<typeof generationOutlineEditSchema>;

export const generationOutlineReviewSchema = generationOutlineEditSchema.extend({
  type: z.enum(["plan", "lesson", "slides"]),
  items: z.array(generationOutlineEditSchema.shape.items.element.extend({
    keyPoints: textList(6),
    minutes: z.number().int().min(0).max(240).nullable(),
    sourceRefs: z.array(z.string().max(500)).max(4),
  })).min(1).max(20),
  evidenceGaps: z.array(z.object({
    itemIndex: z.number().int().min(0).max(19),
    requirement: z.string().max(160),
  })).max(60),
});
export type GenerationOutlineReview = z.infer<typeof generationOutlineReviewSchema>;

export const generationPublicQualityIssueSchema = z.object({
  code: z.string().max(100), path: z.string().max(200), message: z.string().max(1000),
  suggestion: z.string().max(500), blocking: z.boolean(),
});
export type GenerationPublicQualityIssue = z.infer<typeof generationPublicQualityIssueSchema>;

const reviewDraftEditSchema = z.object({
  title: z.string().trim().min(4).max(100),
  sections: z.array(z.object({ heading: z.string().max(100), content: z.string().min(1).max(20_000) }).strip()).min(1).max(7).optional(),
  slides: z.array(z.object({ title: z.string().trim().min(1).max(120), bullets: z.array(z.string().min(1).max(500)).min(1).max(8), notes: z.string().max(16_000),
    steps: z.array(z.string().max(100)).max(5).optional(), clearDiagram: z.boolean().optional(),
  }).strip()).min(1).max(20).optional(),
}).strip();

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Only user-authored text may change. Source refs, SOP state and execution data stay server-owned. */
export function applyGenerationReviewDraftEdit(checkpoint: Json, type: ValidatedGenerateRequest["type"], input: unknown): Json {
  const edit = reviewDraftEditSchema.parse(input);
  const saved = record(checkpoint);
  if (!saved) throw new Error("저장된 초안을 확인하지 못했습니다.");
  if (type === "slides") {
    const slides = saved.slides;
    const outline = record(saved.outline);
    if (!outline || !Array.isArray(slides) || !edit.slides || edit.slides.length !== slides.length || edit.sections) throw new Error("저장된 슬라이드 수와 순서를 유지해 주세요.");
    return JSON.parse(JSON.stringify({ ...saved, outline: { ...outline, title: edit.title },
      slides: slides.map((slide, index) => {
        const previous = record(slide);
        const { clearDiagram, ...text } = edit.slides![index];
        const changed = JSON.stringify(previous?.bullets) !== JSON.stringify(text.bullets) ||
          (text.steps !== undefined && JSON.stringify(previous?.steps) !== JSON.stringify(text.steps));
        return { ...previous, ...text, diagram: changed || clearDiagram ? undefined : previous?.diagram };
      }), groundingReview: undefined,
    })) as Json;
  }
  const draft = record(saved.draft);
  const sections = draft?.sections;
  if (!draft || !Array.isArray(sections) || !edit.sections || edit.slides || edit.sections.length !== sections.length || edit.sections.some((section, index) => section.heading !== record(sections[index])?.heading)) throw new Error("저장된 문서 섹션 이름과 순서를 유지해 주세요.");
  const outline = record(saved.documentOutline);
  return JSON.parse(JSON.stringify({ ...saved, draft: { ...draft, title: edit.title, sections: edit.sections },
    ...(outline ? { documentOutline: { ...outline, title: edit.title } } : {}), groundingReview: undefined,
  })) as Json;
}

/** Whole checkpoints are private. Build a small, explicitly selected user review projection. */
export function projectGenerationOutline(checkpoint: unknown, type: ValidatedGenerateRequest["type"]): GenerationOutlineReview | undefined {
  const saved = record(checkpoint);
  const outline = record(type === "slides" ? saved?.outline : saved?.documentOutline);
  const items = outline?.[type === "slides" ? "slides" : "sections"];
  if (!Array.isArray(items) || !items.length) return undefined;
  const context = record(saved?.context);
  const result = generationOutlineReviewSchema.safeParse({
    type, title: outline?.title,
    items: items.map((value) => {
      const item = record(value) ?? {};
      return {
        title: type === "slides" ? item.title : item.heading,
        purpose: item.purpose, keyPoints: item.keyPoints ?? [],
        actionRequirements: item.actionRequirements ?? [],
        minutes: item.minutes ?? null, sourceRefs: item.sourceRefs ?? [],
      };
    }),
    evidenceGaps: outlineEvidenceGaps(items as EvidenceOutlineItem[], typeof context?.contextText === "string" ? context.contextText : "")
      .map(({ itemIndex, requirement }) => ({ itemIndex, requirement })),
  });
  return result.success ? result.data : undefined;
}

/** Preserve source bindings on unchanged items; edited technical requirements must be checked again. */
export function applyGenerationOutlineEdit(checkpoint: Json, request: ValidatedGenerateRequest, edit: GenerationOutlineEdit): Json {
  const original = projectGenerationOutline(checkpoint, request.type);
  if (!original || edit.items.length !== original.items.length) throw new Error("목차 항목 수와 순서는 유지해 주세요.");
  const saved = record(checkpoint)!;
  const outlineKey = request.type === "slides" ? "outline" : "documentOutline";
  const itemsKey = request.type === "slides" ? "slides" : "sections";
  const outline = record(saved[outlineKey])!;
  const savedItems = outline[itemsKey] as Array<Record<string, unknown>>;
  if (request.type !== "slides") {
    if (edit.items.some((item, index) => item.title !== original.items[index].title)) throw new Error("문서의 필수 섹션 이름과 순서는 유지해 주세요.");
    const timed = edit.items.filter((_, index) => original.items[index].minutes !== null);
    if (timed.some((item) => item.minutes == null || item.minutes <= 0) || timed.reduce((sum, item) => sum + (item.minutes ?? 0), 0) !== durationMinutes(request.duration)) {
      throw new Error(`단계별 시간 합계를 ${durationMinutes(request.duration)}분으로 맞춰 주세요.`);
    }
  }
  let contentChanged = false;
  const nextItems = edit.items.map((item, index) => {
    const previous = original.items[index];
    const changed = item.title !== previous.title || item.purpose !== previous.purpose ||
      JSON.stringify(item.keyPoints ?? []) !== JSON.stringify(previous.keyPoints) ||
      JSON.stringify(item.actionRequirements) !== JSON.stringify(previous.actionRequirements);
    contentChanged ||= changed;
    const next: Record<string, unknown> = {
      ...savedItems[index], purpose: item.purpose, actionRequirements: item.actionRequirements,
      ...(request.type === "slides" ? { title: item.title } : {
        keyPoints: item.keyPoints ?? [], minutes: previous.minutes === null ? null : item.minutes,
      }),
    };
    if (changed) {
      // New user wording is a request, never an asserted source quote.
      next.evidenceRequirements = [...item.actionRequirements, ...(item.keyPoints ?? []), item.purpose]
        .filter((value, position, all) => all.indexOf(value) === position).slice(0, 3)
        .map((requirement) => ({ requirement: requirement.slice(0, 160), sourceRef: null, excerpt: null }));
    }
    return next;
  });
  return JSON.parse(JSON.stringify({
    ...saved,
    [outlineKey]: { ...outline, title: edit.title, [itemsKey]: nextItems },
    ...(request.type === "slides" ? {} : { draft: { title: edit.title, sections: [] } }),
    outlineApproved: true,
    ...(contentChanged ? { outlineEvidence: undefined, groundingReview: undefined } : {}),
  })) as Json;
}

export function publicGenerationQualityIssues(issues: readonly GenerationQualityIssue[], blocking: readonly GenerationQualityIssue[]): GenerationPublicQualityIssue[] {
  const blockingKeys = new Set(blocking.map((issue) => `${issue.code}:${issue.path}`));
  return issues.slice(0, 80).map((issue) => ({
    code: issue.code, path: issue.path, message: issue.message.slice(0, 1000),
    blocking: blockingKeys.has(`${issue.code}:${issue.path}`),
    suggestion: /source|evidence|technical|condition|sop/.test(issue.code)
      ? "해당 부분의 원문과 적용 조건을 확인하고, 확인되지 않는 내용은 제거하거나 확인 필요로 구분하세요."
      : /time/.test(issue.code) ? "해당 단계의 시간을 조정해 전체 교육 시간과 합계를 맞춰 주세요."
        : /safety/.test(issue.code) ? "원문에 근거한 예방·중단·보고 기준을 해당 부분에 보완하세요."
          : /evaluation/.test(issue.code) ? "훈련목표와 연결되는 관찰 가능한 평가·통과 기준을 보완하세요."
            : "표시된 부분을 직접 수정하거나 해당 항목만 선택해 AI 보완을 실행하세요.",
  }));
}

/** Incomplete drafts are a separate review surface, never an official result. */
export function projectGenerationReviewDraft(checkpoint: unknown): Record<string, unknown> | undefined {
  const saved = record(checkpoint);
  const draft = record(saved?.draft);
  const outline = record(saved?.outline);
  const context = record(saved?.context);
  const sections = Array.isArray(draft?.sections) ? draft.sections.filter((value) => {
    const section = record(value);
    return typeof section?.heading === "string" && typeof section?.content === "string";
  }).map((value) => { const section = record(value)!; return { heading: section.heading, content: section.content }; }) : undefined;
  // Slides are generated against a strict schema before checkpointing; keep only material fields.
  const slides = Array.isArray(saved?.slides) ? saved.slides.map((value) => {
    const slide = record(value) ?? {};
    return Object.fromEntries(["title", "bullets", "notes", "role", "composition", "layout", "visual", "sourceRefs", "steps", "diagram"].filter((key) => key in slide).map((key) => [key, slide[key]]));
  }) : undefined;
  if (!sections?.length && !slides?.length) return undefined;
  return {
    title: draft?.title ?? outline?.title ?? "검토 중인 초안",
    ...(sections?.length ? { sections } : { slides, mode: "presenter" }),
    sources: context?.sources ?? [], sourceLabels: extractSourceLabels(typeof context?.contextText === "string" ? context.contextText : ""),
    sopEvidence: context?.sopEvidence,
  };
}

import { z } from "zod";
import { slideDiagramSchema } from "@/lib/slide-diagram";
import {
  AUDIENCES, DURATIONS, SLIDE_COMPOSITION_TYPES, SLIDE_DECK_MODES,
  SLIDE_LAYOUT_TYPES, SLIDE_ROLE_TYPES, SLIDE_VISUAL_FITS, SLIDE_VISUAL_MODES,
  type GeneratedDoc, type GeneratedSlideDeck,
} from "@/lib/generate";

export const MAX_GENERATION_DRAFT_BYTES = 900 * 1024;
export const generationDraftKeySchema = z.string().regex(
  /^(?:material:[1-9]\d{0,14}|(?:job|local):[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i
);
const text = (max: number) => z.string().max(max);
const labels = z.array(text(300)).max(80);
const source = z.object({ document_id: z.number().int().safe(), doc: text(300), page: z.number().int().safe().nullable() });
const evidence = z.object({ status: z.enum(["found", "not_found", "degraded"]), sourceLabels: labels });
const sources = {
  sources: z.array(source).max(80), sourceLabels: labels.optional(), sopEvidence: evidence.optional(),
};
export const generationDraftContextSchema = z.object({
  category: text(50), audience: z.enum(AUDIENCES), duration: z.enum(DURATIONS),
  topic: text(100), focus: text(100), conditions: text(500),
  date: z.string().regex(/^(?:\d{4}-\d{2}-\d{2})?$/), place: text(100),
  slideMode: z.enum(SLIDE_DECK_MODES),
});
const docSchema = z.object({
  title: text(200), sections: z.array(z.object({ heading: text(200), content: text(20_000) })).max(8), ...sources,
});
const slideSchema = z.object({
  title: text(200), bullets: z.array(text(500)).max(4), notes: text(30_000),
  // 공식 자료는 최대 5개다. 편집 중 초과 입력도 복구할 수 있도록 임시보관 범위는 넓힌다.
  steps: z.array(text(500)).max(50).optional(), sourceRefs: labels.optional(),
  layout: z.enum(SLIDE_LAYOUT_TYPES).optional(), role: z.enum(SLIDE_ROLE_TYPES).optional(),
  composition: z.enum(SLIDE_COMPOSITION_TYPES).optional(),
  diagram: slideDiagramSchema.optional(),
  visual: z.object({
    mode: z.enum(SLIDE_VISUAL_MODES), assetId: text(200).optional(),
    documentId: z.number().int().safe().positive().optional(), page: z.number().int().safe().positive().optional(),
    sourceRef: text(300).optional(), altText: text(300).optional(), caption: text(200).optional(),
    fit: z.enum(SLIDE_VISUAL_FITS).optional(),
  }).optional(),
});
/** 미완성 편집도 보존한다. 공식 저장·공유·내보내기의 품질 게이트를 대신하지 않는다. */
export const generationDraftSnapshotSchema = z.object({
  version: z.literal(1), kind: z.enum(["plan", "lesson", "slides", "notebooklm"]),
  context: generationDraftContextSchema,
  doc: docSchema.nullable(),
  deck: z.object({ title: text(200), mode: z.enum(SLIDE_DECK_MODES).optional(), slides: z.array(slideSchema).max(30), ...sources }).nullable(),
  nlm: text(100_000).nullable(),
  materialId: z.number().int().safe().positive().nullable(),
  materialRevision: z.number().int().safe().positive().nullable(), saved: z.boolean(),
}).superRefine((value, ctx) => {
  if ((value.kind === "slides" && !value.deck) ||
      ((value.kind === "plan" || value.kind === "lesson") && !value.doc) ||
      (value.kind === "notebooklm" && value.nlm === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "편집 결과 유형이 맞지 않습니다." });
  }
});
export type GenerationDraftSnapshot = z.infer<typeof generationDraftSnapshotSchema>;
export type GenerationDraft = { id: string; draftKey: string; revision: number; updatedAt: string; snapshot: GenerationDraftSnapshot };
export type GenerationDraftSummary = Pick<GenerationDraft, "id" | "draftKey" | "updatedAt"> & { title: string; kind: string };

export function generationDraftTitle(snapshot: GenerationDraftSnapshot): string {
  return snapshot.doc?.title || snapshot.deck?.title || snapshot.context.topic || "제목 없는 편집 초안";
}

export function restoreGenerationDraft(snapshot: GenerationDraftSnapshot) {
  return { doc: snapshot.doc as GeneratedDoc | null, deck: snapshot.deck as GeneratedSlideDeck | null, nlm: snapshot.nlm,
    ...snapshot.context };
}

/** 런타임 원문 이미지와 알 수 없는 필드는 저장/지문 모두에서 제외한다. */
export function generationDraftFingerprint(snapshot: GenerationDraftSnapshot): string {
  return JSON.stringify(generationDraftSnapshotSchema.parse(snapshot));
}

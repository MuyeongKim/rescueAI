import { z } from "zod";
import { inspectSlideDiagram, slideDiagramSchema } from "@/lib/slide-diagram";
import { SOURCE_VISUAL_FOCUS } from "@/lib/source-visual-focus";

import {
  MAX_GENERATION_CONDITIONS_CHARS,
  SLIDE_COMPOSITION_TYPES,
  SLIDE_DECK_MODES,
  SLIDE_LAYOUT_TYPES,
  SLIDE_ROLE_TYPES,
  SLIDE_VISUAL_FITS,
  SLIDE_VISUAL_MODES,
  bindSlideVisualsToSources,
  resolveSlideDeckMode,
  type GenType,
  type GeneratedDocSource,
  type GeneratedSlide,
} from "@/lib/generate";

export const MAX_GENERATED_MATERIAL_REQUEST_BYTES = 120 * 1024;
export const MAX_GENERATED_MATERIALS_PER_USER = 200;

export class LimitedJsonBodyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413
  ) {
    super(message);
    this.name = "LimitedJsonBodyError";
  }
}

/**
 * Content-Length가 없거나 거짓이어도 실제 스트림 바이트를 세어 상한을 지킨다.
 * JSON reviver 단계에서 원문·확대 런타임 이미지를 제거해 어떤 스키마에서도 저장되지 않게 한다.
 */
export async function readLimitedJsonBody(
  request: Request,
  maxBytes = MAX_GENERATED_MATERIAL_REQUEST_BYTES
): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength.trim())) {
      throw new LimitedJsonBodyError("올바르지 않은 Content-Length입니다.", 400);
    }
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes)) {
      throw new LimitedJsonBodyError("올바르지 않은 Content-Length입니다.", 400);
    }
    if (declaredBytes > maxBytes) {
      throw new LimitedJsonBodyError("저장 요청이 너무 큽니다.", 413);
    }
  }

  if (!request.body) {
    throw new LimitedJsonBodyError("JSON 요청 본문이 필요합니다.", 400);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("request body too large").catch(() => undefined);
        throw new LimitedJsonBodyError("저장 요청이 너무 큽니다.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new LimitedJsonBodyError("요청 본문은 UTF-8 JSON이어야 합니다.", 400);
  }

  try {
    return JSON.parse(text, (key, value) => (key === "imageData" || key === "sourcePageImageData" ? undefined : value));
  } catch {
    throw new LimitedJsonBodyError("올바른 JSON 요청이 아닙니다.", 400);
  }
}

const requiredText = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => value || undefined)
    .optional();

const sourceSchema = z
  .object({
    document_id: z.number().int().safe().nonnegative(),
    doc: requiredText(300),
    page: z.number().int().safe().positive().nullable(),
  })
  .strip();

const sourceLabelsSchema = z.array(requiredText(300)).max(80).optional();
const sopEvidenceSchema = z
  .object({
    status: z.enum(["found", "not_found", "degraded"]),
    sourceLabels: z.array(requiredText(300)).max(20).default([]),
  })
  .strip()
  .optional();
const commonDocumentFields = {
  sources: z.array(sourceSchema).max(80).default([]),
  sourceLabels: sourceLabelsSchema,
  sopEvidence: sopEvidenceSchema,
  focus: optionalText(100),
  conditions: optionalText(MAX_GENERATION_CONDITIONS_CHARS),
};

const sectionSchema = z
  .object({
    heading: requiredText(200),
    content: requiredText(20_000),
  })
  .strip();

const planContentSchema = z
  .object({
    sections: z.array(sectionSchema).min(1).max(8),
    ...commonDocumentFields,
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .or(z.literal(""))
      .optional(),
    place: optionalText(100),
  })
  .strip();

const lessonContentSchema = z
  .object({
    sections: z.array(sectionSchema).min(1).max(8),
    ...commonDocumentFields,
  })
  .strip();

const visualSchema = z
  .object({
    mode: z.enum(SLIDE_VISUAL_MODES),
    documentId: z.number().int().safe().positive().optional(),
    page: z.number().int().safe().positive().optional(),
    sourceRef: optionalText(300),
    altText: optionalText(300),
    caption: optionalText(200),
    fit: z.enum(SLIDE_VISUAL_FITS).optional(),
    sourceFocus: z.enum(SOURCE_VISUAL_FOCUS).optional(),
  })
  .strip();

const slideSchema = z
  .object({
    title: requiredText(200),
    bullets: z.array(requiredText(500)).min(1).max(4),
    steps: z.array(requiredText(100)).max(5).optional(),
    notes: z.string().trim().max(30_000).default(""),
    layout: z.enum(SLIDE_LAYOUT_TYPES).optional(),
    role: z.enum(SLIDE_ROLE_TYPES).optional(),
    composition: z.enum(SLIDE_COMPOSITION_TYPES).optional(),
    diagram: slideDiagramSchema.optional(),
    visual: visualSchema.optional(),
    sourceRefs: z.array(requiredText(300)).max(4).optional(),
  })
  .strip();

const slidesContentSchema = z
  .object({
    mode: z.enum(SLIDE_DECK_MODES).default("presenter"),
    slides: z.array(slideSchema).min(1).max(20),
    ...commonDocumentFields,
  })
  .strip();

const notebookContentSchema = z
  .object({
    prompt: requiredText(100_000),
    focus: optionalText(100),
    conditions: optionalText(MAX_GENERATION_CONDITIONS_CHARS),
  })
  .strip();

export type NormalizedGeneratedMaterialContent = Record<string, unknown>;

export type GeneratedMaterialContentResult =
  | { ok: true; content: NormalizedGeneratedMaterialContent }
  | { ok: false; error: string };

/** 서버가 RAG에서 재확인한 출처만으로 저장 슬라이드의 원문 페이지 연결을 다시 만든다. */
export function rebindNormalizedSlideContent(
  content: NormalizedGeneratedMaterialContent,
  trustedSources: readonly GeneratedDocSource[]
): NormalizedGeneratedMaterialContent {
  const rebound = bindSlideVisualsToSources(
    {
      title: "",
      mode: resolveSlideDeckMode(content.mode),
      slides: Array.isArray(content.slides) ? (content.slides as GeneratedSlide[]) : [],
    },
    trustedSources,
    { rejectMismatchedMetadata: true }
  );
  return {
    ...content,
    mode: rebound.mode,
    slides: rebound.slides,
    sources: [...trustedSources],
  };
}

/** 저장 유형별 허용 필드만 남기고 배열 상한·필수 구조를 서버에서 고정한다. */
export function normalizeGeneratedMaterialContent(
  kind: GenType,
  content: unknown
): GeneratedMaterialContentResult {
  const schema =
    kind === "plan"
      ? planContentSchema
      : kind === "lesson"
        ? lessonContentSchema
        : kind === "slides"
          ? slidesContentSchema
          : notebookContentSchema;
  const result = schema.safeParse(content);
  if (!result.success) {
    return { ok: false, error: "저장 내용의 구조나 분량이 올바르지 않습니다." };
  }
  const normalized = result.data as NormalizedGeneratedMaterialContent;
  if (kind !== "slides") return { ok: true, content: normalized };
  const slides = normalized.slides as GeneratedSlide[];
  const invalidDiagramIndex = slides.findIndex((slide) => !inspectSlideDiagram(slide).valid);
  if (invalidDiagramIndex !== -1) {
    return { ok: false, error: `${invalidDiagramIndex + 1}번 슬라이드의 도식 연결을 확인해 주세요.` };
  }

  // 브라우저가 보낸 documentId/page를 신뢰하지 않는다. 정규화된 sources의 정확한
  // sourceRef와 일치할 때만 다시 결합하고, 제출 메타데이터가 충돌하면 안전한 도형으로 내린다.
  return {
    ok: true,
    content: rebindNormalizedSlideContent(
      normalized,
      normalized.sources as GeneratedDocSource[]
    ),
  };
}

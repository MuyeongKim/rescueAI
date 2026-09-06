import { generateObject } from "ai";
import { z } from "zod";
import { slideDiagramSchema } from "@/lib/slide-diagram";

import { requireApiUser } from "@/lib/auth";
import { DEMO } from "@/lib/demo";
import { fetchCategoryContext } from "@/lib/generate-context";
import { buildFocusedTrainingQuery } from "@/lib/generate-focus";
import {
  AUDIENCES,
  DURATIONS,
  MAX_GENERATION_CONDITIONS_CHARS,
  SLIDE_COMPOSITION_TYPES,
  SLIDE_DECK_MODES,
  SLIDE_LAYOUT_TYPES,
  SLIDE_ROLE_TYPES,
  SLIDE_VISUAL_FITS,
  SLIDE_VISUAL_MODES,
  bindSlideVisualsToSources,
  buildGenerateSystemPrompt,
  extractSourceLabels,
  type GeneratedDocSource,
  type GeneratedSlide,
  type GeneratedSlideDeck,
} from "@/lib/generate";
import {
  LimitedJsonBodyError,
  MAX_GENERATED_MATERIAL_REQUEST_BYTES,
  readLimitedJsonBody,
} from "@/lib/generated-material-save";
import { getChatModel } from "@/lib/llm";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import type { SopEvidence } from "@/lib/sop-evidence";

export const maxDuration = 60;

const EVIDENCE_CALL_TIMEOUT_MS = 50_000;

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

const sopEvidenceSchema = z
  .object({
    status: z.enum(["found", "not_found", "degraded"]),
    sourceLabels: z.array(requiredText(300)).max(20).default([]),
  })
  .strip()
  .optional();

const visualSchema = z
  .object({
    mode: z.enum(SLIDE_VISUAL_MODES),
    assetId: optionalText(200),
    documentId: z.number().int().safe().positive().optional(),
    page: z.number().int().safe().positive().optional(),
    sourceRef: optionalText(300),
    altText: optionalText(300),
    caption: optionalText(200),
    fit: z.enum(SLIDE_VISUAL_FITS).optional(),
  })
  .strip();

// sourceRefs 자체가 이 API의 복구 대상이므로 빈 배열과 현재 RAG에 없는 문자열도 입력 단계에서는 받는다.
const repairableSlideSchema = z
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
    // 허용 개수 초과도 이 API가 고쳐야 할 invalid 상태이므로 신규 출력 상한(4)보다 넓게 받는다.
    sourceRefs: z.array(z.string().trim().max(300)).max(20).optional(),
  })
  .strip();

const deckSchema = z
  .object({
    title: requiredText(200),
    mode: z.enum(SLIDE_DECK_MODES).optional(),
    slides: z.array(repairableSlideSchema).min(1).max(20),
    // 아래 세 필드는 전체 GeneratedSlideDeck 계약상 받되 서버가 현재 RAG 값으로 항상 덮는다.
    sources: z.array(sourceSchema).max(80).default([]),
    sourceLabels: z.array(requiredText(300)).max(80).optional(),
    sopEvidence: sopEvidenceSchema,
  })
  .strip();

const requestSchema = z
  .object({
    category: requiredText(50),
    audience: z.enum(AUDIENCES),
    duration: z.enum(DURATIONS),
    topic: requiredText(100).refine((value) => value.length >= 2),
    focus: optionalText(100),
    conditions: optionalText(MAX_GENERATION_CONDITIONS_CHARS),
    slideMode: z.enum(SLIDE_DECK_MODES).optional(),
    model: optionalText(100),
    deck: deckSchema,
  })
  .strip();

type EvidenceRepairResponse = {
  deck: GeneratedSlideDeck;
  repairedIndices: number[];
  unresolvedIndices: number[];
  remainingIssuePaths: string[];
  warnings?: string[];
};

function normalizedAllowedSourceRefs(contextText: string): string[] {
  const labels = new Set<string>();
  for (const rawLabel of extractSourceLabels(contextText)) {
    const label = rawLabel.trim();
    if (
      label.length < 4 ||
      label.length > 300 ||
      !label.startsWith("[") ||
      !label.endsWith("]") ||
      /[\r\n]/.test(label)
    ) {
      continue;
    }
    labels.add(label);
    if (labels.size >= 80) break;
  }
  return Array.from(labels);
}

function sourceProblemIndices(
  slides: readonly GeneratedSlide[],
  allowedSourceRefs: ReadonlySet<string>
): number[] {
  const indices: number[] = [];
  slides.forEach((slide, index) => {
    const refs = slide.sourceRefs ?? [];
    if (
      refs.length === 0 ||
      refs.length > 4 ||
      refs.some((sourceRef) => !sourceRef || !allowedSourceRefs.has(sourceRef))
    ) {
      indices.push(index);
    }
  });
  return indices;
}

function remainingIssuePaths(unresolvedIndices: readonly number[]): string[] {
  return unresolvedIndices.map((index) => `slides.${index}.sourceRefs`);
}

function withTrustedEvidence(
  deck: GeneratedSlideDeck,
  slides: GeneratedSlide[],
  sources: readonly GeneratedDocSource[],
  sourceLabels: readonly string[],
  sopEvidence: SopEvidence
): GeneratedSlideDeck {
  const rebound = bindSlideVisualsToSources(
    { title: deck.title, mode: deck.mode, slides },
    sources,
    { rejectMismatchedMetadata: true }
  );
  return {
    ...rebound,
    sources: [...sources],
    sourceLabels: [...sourceLabels],
    sopEvidence,
  };
}

function repairBatchPrompt(args: {
  category: string;
  audience: string;
  duration: string;
  topic: string;
  focus?: string;
  conditions?: string;
  slideMode?: string;
  deckTitle: string;
  slides: readonly GeneratedSlide[];
  problemIndices: readonly number[];
  allowedSourceRefs: readonly string[];
}): string {
  const targets = args.problemIndices.map((index) => {
    const slide = args.slides[index];
    return {
      index,
      title: slide.title,
      bullets: slide.bullets,
      steps: slide.steps,
      composition: slide.composition,
      diagram: slide.diagram,
      // 과도한 사용자 입력이 프롬프트를 잠식하지 않도록 근거 판별에 충분한 범위만 전달한다.
      notes: slide.notes.slice(0, 2_000),
      currentSourceRefs: slide.sourceRefs ?? [],
    };
  });
  return `전북소방본부 교육용 슬라이드의 근거 출처만 복구합니다.

[요청 조건]
- 분야: ${args.category}
- 대상: ${args.audience}
- 교육 시간: ${args.duration}
- 주제: ${args.topic}
- 세부 방향: ${args.focus ?? "입력되지 않음"}
- 현장 조건: ${args.conditions ?? "입력되지 않음"}
- 제작 모드: ${args.slideMode ?? "덱 설정 유지"}
- 발표 제목: ${args.deckTitle}

[복구 대상 — index는 0부터 시작]
${JSON.stringify(targets, null, 2)}

[서버가 허용한 출처 라벨]
${args.allowedSourceRefs.map((label) => `- ${label}`).join("\n")}

[출력 규칙]
- 위 복구 대상 index의 sourceRefs만 반환하세요. 제목·본문·노트·구도는 다시 쓰지 않습니다.
- 한 번의 배치 응답에 각 index를 최대 한 번만 넣으세요.
- 해당 장의 구체적 주장·절차를 참고 자료가 직접 뒷받침할 때만 1~4개 라벨을 연결하세요.
- 라벨은 [서버가 허용한 출처 라벨]에서 글자 하나 바꾸지 않고 고르세요. 새 문서명이나 페이지를 만들지 마세요.
- 직접 근거를 확인할 수 없는 index는 repairs에서 생략하세요.
- 전달받지 않은 index는 repairs에 넣지 마세요.`;
}

function unavailableResponse(args: {
  deck: GeneratedSlideDeck;
  code: string;
  error: string;
}) {
  const unresolvedIndices = args.deck.slides.map((_, index) => index);
  return Response.json(
    {
      error: args.error,
      code: args.code,
      repairedIndices: [],
      unresolvedIndices,
      remainingIssuePaths: remainingIssuePaths(unresolvedIndices),
    },
    { status: 422 }
  );
}

export async function POST(request: Request) {
  // 비용이 드는 RAG·LLM 엔드포인트이므로 공개 데모가 아닐 때는 본문보다 인증·제한을 먼저 확인한다.
  if (!DEMO) {
    const auth = await requireApiUser();
    if (!auth.ok) return auth.response;
    const rl = rateLimit(`generate-evidence:${auth.user.id}`, 20, 60_000);
    if (!rl.ok) return tooManyRequests(rl.retryAfterSec);
  }

  let raw: unknown;
  try {
    raw = await readLimitedJsonBody(request, MAX_GENERATED_MATERIAL_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof LimitedJsonBodyError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "요청 내용을 확인해 주세요." }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: "분야·대상·시간·주제와 전체 슬라이드 내용을 확인해 주세요." },
      { status: 400 }
    );
  }

  const body = parsed.data;
  const inputDeck = body.deck as GeneratedSlideDeck;

  // 공개 데모에서는 실제 RAG나 LLM을 호출하지 않고, 클라이언트 출처를 검증 완료로 간주하지 않는다.
  if (DEMO) {
    return unavailableResponse({
      deck: inputDeck,
      code: "demo_evidence_repair_unavailable",
      error: "데모 모드에서는 실제 자료 검색을 통한 근거 보완을 실행하지 않습니다.",
    });
  }

  try {
    const context = await fetchCategoryContext(
      body.category,
      40,
      buildFocusedTrainingQuery(body.topic, body.focus ?? ""),
      undefined,
      { conditions: body.conditions }
    );
    const allowedSourceRefs = normalizedAllowedSourceRefs(context.contextText);
    if (allowedSourceRefs.length === 0) {
      return unavailableResponse({
        deck: inputDeck,
        code: "no_grounded_sources",
        error: "현재 연결 자료에서 검증 가능한 출처 라벨을 찾지 못했습니다.",
      });
    }

    const allowedSourceSet = new Set(allowedSourceRefs);
    const problemIndices = sourceProblemIndices(inputDeck.slides, allowedSourceSet);
    if (problemIndices.length === 0) {
      const deck = withTrustedEvidence(
        inputDeck,
        inputDeck.slides,
        context.bindingSources,
        allowedSourceRefs,
        context.sopEvidence
      );
      const warnings = context.degraded
        ? ["자료 검색 일부 기능이 제한되어 현재 확인 가능한 근거만 반영했습니다."]
        : [];
      return Response.json({
        deck,
        repairedIndices: [],
        unresolvedIndices: [],
        remainingIssuePaths: [],
        ...(warnings.length > 0 ? { warnings } : {}),
      } satisfies EvidenceRepairResponse);
    }

    const batchSchema = z.object({
      repairs: z
        .array(
          z.object({
            // 모델 오류 하나가 배치 전체를 폐기하지 않도록 범위는 후단에서 problemSet과 대조한다.
            index: z.number().int().safe(),
            sourceRefs: z.array(requiredText(300)).min(1).max(4),
          })
        )
        .max(40),
    });
    const generated = await generateObject({
      // 출처 라벨 매핑은 짧고 구조화된 작업이므로 정밀 모델을 다시 오래 기다리지 않는다.
      model: getChatModel(body.model === "gemini-pro" ? "gemini-flash" : body.model),
      schema: batchSchema,
      system: buildGenerateSystemPrompt(
        body.category,
        context.contextText,
        context.sopEvidence
      ),
      prompt: repairBatchPrompt({
        category: body.category,
        audience: body.audience,
        duration: body.duration,
        topic: body.topic,
        focus: body.focus,
        conditions: body.conditions,
        slideMode: body.slideMode,
        deckTitle: inputDeck.title,
        slides: inputDeck.slides,
        problemIndices,
        allowedSourceRefs,
      }),
      temperature: 0.1,
      abortSignal: AbortSignal.timeout(EVIDENCE_CALL_TIMEOUT_MS),
    });

    const problemSet = new Set(problemIndices);
    const occurrenceCount = new Map<number, number>();
    for (const repair of generated.object.repairs) {
      occurrenceCount.set(repair.index, (occurrenceCount.get(repair.index) ?? 0) + 1);
    }

    const slides = inputDeck.slides.map((slide) => ({ ...slide }));
    const repairedSet = new Set<number>();
    let rejectedRepair = false;
    for (const repair of generated.object.repairs) {
      const refs = Array.from(new Set(repair.sourceRefs));
      const validRepair =
        problemSet.has(repair.index) &&
        occurrenceCount.get(repair.index) === 1 &&
        refs.length > 0 &&
        refs.length <= 4 &&
        refs.every((sourceRef) => allowedSourceSet.has(sourceRef));
      if (!validRepair) {
        rejectedRepair = true;
        continue;
      }
      slides[repair.index] = { ...slides[repair.index], sourceRefs: refs };
      repairedSet.add(repair.index);
    }

    const finalProblemSet = new Set(sourceProblemIndices(slides, allowedSourceSet));
    const repairedIndices = problemIndices.filter(
      (index) => repairedSet.has(index) && !finalProblemSet.has(index)
    );
    const repairedIndexSet = new Set(repairedIndices);
    const unresolvedIndices = problemIndices.filter((index) => !repairedIndexSet.has(index));
    const deck = withTrustedEvidence(
      inputDeck,
      slides,
      context.bindingSources,
      allowedSourceRefs,
      context.sopEvidence
    );
    const warnings = [
      ...(context.degraded
        ? ["자료 검색 일부 기능이 제한되어 현재 확인 가능한 근거만 반영했습니다."]
        : []),
      ...(rejectedRepair
        ? ["허용 범위를 벗어나거나 중복된 AI 보완 결과는 반영하지 않았습니다."]
        : []),
      ...(unresolvedIndices.length > 0
        ? [`직접 근거를 충분히 확인하지 못한 슬라이드가 ${unresolvedIndices.length}장 남았습니다.`]
        : []),
    ];

    return Response.json({
      deck,
      repairedIndices,
      unresolvedIndices,
      remainingIssuePaths: remainingIssuePaths(unresolvedIndices),
      ...(warnings.length > 0 ? { warnings } : {}),
    } satisfies EvidenceRepairResponse);
  } catch (error) {
    const name =
      error && typeof error === "object" && "name" in error
        ? String((error as { name?: unknown }).name ?? "")
        : "";
    console.error(
      "[generate/evidence] 근거 보완 실패:",
      error instanceof Error ? error.message : error
    );
    if (name === "AbortError" || name === "TimeoutError") {
      return Response.json(
        { error: "근거 보완 시간이 길어 요청을 안전하게 종료했습니다. 다시 시도해 주세요." },
        { status: 503 }
      );
    }
    return Response.json(
      { error: "슬라이드 근거를 보완하는 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}

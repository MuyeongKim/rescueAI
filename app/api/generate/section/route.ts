import { generateObject } from "ai";
import { z } from "zod";
import { getChatModel } from "@/lib/llm";
import { requireApiUser } from "@/lib/auth";
import {
  AUDIENCES,
  DURATIONS,
  SLIDE_COMPOSITION_TYPES,
  SLIDE_DECK_MODES,
  SLIDE_LAYOUT_TYPES,
  SLIDE_ROLE_TYPES,
  SLIDE_VISUAL_FITS,
  SLIDE_VISUAL_MODES,
  bindSlideVisualsToSources,
  buildGenerateSystemPrompt,
  buildSectionRegenPrompt,
  buildSlideRegenPrompt,
  extractSourceLabels,
  MAX_GENERATION_CONDITIONS_CHARS,
  resolveSlideDeckMode,
  regeneratedSectionSchema,
  regeneratedSlideSchema,
  type GeneratedDocSource,
  type GeneratedSection,
  type GeneratedSlide,
} from "@/lib/generate";
import { DEMO } from "@/lib/demo";
import { fetchCategoryContext } from "@/lib/generate-context";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { buildFocusedTrainingQuery } from "@/lib/generate-focus";
import {
  LimitedJsonBodyError,
  readLimitedJsonBody,
} from "@/lib/generated-material-save";
import {
  SOP_APPLICATION_MARKER,
  SOP_DEGRADED_DISCLOSURE,
  SOP_NOT_FOUND_DISCLOSURE,
  inspectSopContract,
} from "@/lib/sop-evidence";

export const maxDuration = 60;

const MAX_REGEN_REQUEST_BYTES = 120 * 1024;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => value || undefined)
    .optional();

const optionalRawText = (max: number) => z.string().max(max).optional();

const commonRegenShape = {
  category: z.string().trim().min(1).max(50),
  audience: z.enum(AUDIENCES),
  duration: z.enum(DURATIONS),
  topic: optionalText(100),
  focus: optionalText(100),
  conditions: optionalText(MAX_GENERATION_CONDITIONS_CHARS),
  slideMode: z.enum(SLIDE_DECK_MODES).optional(),
  model: optionalText(100),
  docTitle: optionalText(200),
  outline: z.array(z.string().trim().max(200)).max(30).default([]),
  index: z.number().int().min(0).max(29),
  instruction: optionalText(200),
};

const sectionCurrentSchema = z
  .object({
    heading: optionalRawText(200),
    content: optionalRawText(20_000),
  })
  .strip();

const slideVisualSchema = z
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

const slideCurrentSchema = z
  .object({
    title: optionalRawText(200),
    bullets: z.array(z.string().max(500)).max(4).optional(),
    steps: z.array(z.string().max(100)).max(5).optional(),
    notes: optionalRawText(30_000),
    layout: z.enum(SLIDE_LAYOUT_TYPES).optional(),
    role: z.enum(SLIDE_ROLE_TYPES).optional(),
    composition: z.enum(SLIDE_COMPOSITION_TYPES).optional(),
    visual: slideVisualSchema.optional(),
    sourceRefs: z.array(z.string().max(300)).max(4).optional(),
  })
  .strip();

const regenRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...commonRegenShape,
      kind: z.literal("section"),
      current: sectionCurrentSchema,
    })
    .strip(),
  z
    .object({
      ...commonRegenShape,
      kind: z.literal("slide"),
      current: slideCurrentSchema,
      sopTarget: z.boolean().optional(),
    })
    .strip(),
]);

// 섹션/슬라이드 1개만 AI로 다시 생성한다. (전체 생성은 /api/generate)
export async function POST(req: Request) {
  // LLM 비용 제한을 회피한 대용량 본문 전송을 막기 위해 인증·레이트리밋을 먼저 확인한다.
  if (!DEMO) {
    const auth = await requireApiUser();
    if (!auth.ok) return auth.response;

    // 부분 재생성 남용 방지 (분당 20회/사용자)
    const rl = rateLimit(`generate-section:${auth.user.id}`, 30, 60_000);
    if (!rl.ok) return tooManyRequests(rl.retryAfterSec);
  }

  let input: unknown;
  try {
    input = await readLimitedJsonBody(req, MAX_REGEN_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof LimitedJsonBodyError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "요청 내용을 확인해 주세요." }, { status: 400 });
  }
  const parsed = regenRequestSchema.safeParse(input);
  if (!parsed.success) {
    return Response.json(
      { error: "재생성할 내용의 구조나 분량을 확인해 주세요." },
      { status: 400 }
    );
  }
  const body = parsed.data;

  const kind = body.kind;
  const category = body.category;
  const audience = body.audience;
  const duration = body.duration;
  const index = body.index;
  const outline = body.outline;
  const instruction = body.instruction;
  const conditions = body.conditions;
  const topic = body.topic?.replace(/\s+/g, " ");
  const focus = body.focus?.replace(/\s+/g, " ");

  // 데모 모드: AI 없이 현재 내용에 지시 라벨만 덧붙여 반환
  if (DEMO) {
    if (kind === "slide") {
      const cur = body.current as GeneratedSlide;
      return Response.json({
        title: cur.title ?? "슬라이드",
        bullets: cur.bullets?.length ? cur.bullets : ["내용"],
        steps: cur.steps,
        notes: `${cur.notes ?? ""} (데모 재생성)`,
        layout: cur.layout,
        role: cur.role,
        composition: cur.composition,
        visual: cur.visual,
        sourceRefs: cur.sourceRefs,
      } satisfies GeneratedSlide);
    }
    const cur = body.current as GeneratedSection;
    return Response.json({
      heading: cur.heading ?? "섹션",
      content: `${cur.content ?? ""}\n(데모 재생성)`,
    } satisfies GeneratedSection);
  }

  const {
    contextText,
    bindingSources: regeneratedBindingSources,
    degraded: retrievalDegraded,
    sopEvidence,
  } = await fetchCategoryContext(
    category,
    40,
    buildFocusedTrainingQuery(topic ?? "", focus ?? "")
  );
  if (!contextText) {
    return Response.json(
      { error: "해당 분야에 인덱싱된 자료가 없어 생성할 수 없습니다." },
      { status: 422 }
    );
  }

  try {
    const system = buildGenerateSystemPrompt(category, contextText, sopEvidence);
    const sourceLabels = extractSourceLabels(contextText);
    let activeModelKey = body.model;
    let modelFallbackUsed = false;
    const withGenerationModel = async <T,>(
      run: (model: ReturnType<typeof getChatModel>) => Promise<T>
    ): Promise<T> => {
      try {
        return await run(getChatModel(activeModelKey));
      } catch (error) {
        if (activeModelKey !== "gemini-pro") throw error;
        activeModelKey = "gemini-flash";
        modelFallbackUsed = true;
        console.warn(
          "[generate/section] 정밀 모델 호출 실패, 빠른 모델로 한 번 재시도:",
          error instanceof Error ? error.message : "unknown error"
        );
        return run(getChatModel(activeModelKey));
      }
    };
    const responseInit = () => {
      const headers: Record<string, string> = {};
      if (retrievalDegraded) headers["X-RAG-Degraded"] = "1";
      if (modelFallbackUsed) headers["X-Model-Fallback"] = "1";
      return Object.keys(headers).length > 0 ? { headers } : undefined;
    };

    if (kind === "slide") {
      const cur = body.current as GeneratedSlide;
      const generateSlide = (currentSlide: GeneratedSlide, extraInstruction?: string) =>
        withGenerationModel(async (model) => {
        const generated = await generateObject({
          model,
          schema: regeneratedSlideSchema,
          system,
          prompt: buildSlideRegenPrompt({
            category,
            audience,
            duration,
            deckTitle: body.docTitle ?? `${category} 발표`,
            outline,
            index,
            current: {
              title: currentSlide.title ?? "",
              bullets: currentSlide.bullets ?? [],
              notes: currentSlide.notes ?? "",
            },
            topic,
            focus,
            sopEvidence,
            sopTarget: body.sopTarget === true,
            slideMode: resolveSlideDeckMode(body.slideMode),
            conditions,
            instruction: [instruction, extraInstruction].filter(Boolean).join(" ") || undefined,
          }),
          temperature: 0.5,
        });
        return generated.object;
      });
      let object = await generateSlide(cur);
      const currentSlideText = `${cur.title ?? ""}\n${cur.bullets?.join("\n") ?? ""}\n${cur.notes ?? ""}`;
      const isSopSlide =
        body.sopTarget === true ||
        currentSlideText.includes(SOP_APPLICATION_MARKER) ||
        currentSlideText.includes(SOP_NOT_FOUND_DISCLOSURE) ||
        currentSlideText.includes(SOP_DEGRADED_DISCLOSURE);
      if (isSopSlide) {
        const sopReport = inspectSopContract("slides", { slides: [object] }, sopEvidence);
        if (!sopReport.ok) {
          object = await generateSlide(
            object,
            `SOP 계약 오류를 모두 수정하세요: ${sopReport.issues.map((issue) => issue.message).join(" / ")}`
          );
        }
        const repairedSopReport = inspectSopContract(
          "slides",
          { slides: [object] },
          sopEvidence
        );
        if (!repairedSopReport.ok) {
          return Response.json(
            {
              code: "sop_contract_invalid",
              error: "SOP 적용 슬라이드를 복구하지 못했습니다. 잠시 후 다시 시도해 주세요.",
              issues: repairedSopReport.issues,
            },
            { status: 422 }
          );
        }
      }
      const verifiedSlide = bindSlideVisualsToSources(
        {
          title: body.docTitle ?? `${category} 발표`,
          mode: resolveSlideDeckMode(body.slideMode),
          slides: [object],
        },
        regeneratedBindingSources
      ).slides[0];
      return Response.json(
        {
          ...verifiedSlide,
          sourceLabels,
          sources: regeneratedBindingSources,
          sopEvidence,
        } satisfies GeneratedSlide & {
          sourceLabels: string[];
          sources: GeneratedDocSource[];
          sopEvidence: typeof sopEvidence;
        },
        responseInit()
      );
    }

    const cur = body.current as GeneratedSection;
    const generateSection = (currentContent: string, extraInstruction?: string) =>
      withGenerationModel(async (model) => {
      const generated = await generateObject({
        model,
        schema: regeneratedSectionSchema,
        system,
        prompt: buildSectionRegenPrompt({
          category,
          audience,
          duration,
          docTitle: body.docTitle ?? `${category} 교육 문서`,
          outline,
          index,
          currentHeading: cur.heading ?? "",
          currentContent,
          topic,
          focus,
          sopEvidence,
          conditions,
          instruction: [instruction, extraInstruction].filter(Boolean).join(" ") || undefined,
        }),
        temperature: 0.5,
      });
      return generated.object;
    });
    let object = await generateSection(cur.content ?? "");
    const isSopSection = cur.heading === "훈련내용" || cur.heading === "핵심이론";
    if (isSopSection) {
      const sopType = cur.heading === "훈련내용" ? "plan" : "lesson";
      const sopReport = inspectSopContract(
        sopType,
        { sections: [{ heading: cur.heading, content: object.content }] },
        sopEvidence
      );
      if (!sopReport.ok) {
        object = await generateSection(
          object.content,
          `SOP 계약 오류를 모두 수정하세요: ${sopReport.issues.map((issue) => issue.message).join(" / ")}`
        );
      }
      const repairedSopReport = inspectSopContract(
        sopType,
        { sections: [{ heading: cur.heading, content: object.content }] },
        sopEvidence
      );
      if (!repairedSopReport.ok) {
        return Response.json(
          {
            code: "sop_contract_invalid",
            error: "SOP 적용 섹션을 복구하지 못했습니다. 잠시 후 다시 시도해 주세요.",
            issues: repairedSopReport.issues,
          },
          { status: 422 }
        );
      }
    }
    // 부분 보완이 훈련계획·교안의 고정 구조를 깨지 않도록 제목은 기존 값을 유지한다.
    return Response.json(
      {
        ...object,
        heading: cur.heading,
        sourceLabels,
        // 부분 재생성으로 새 인용이 추가돼도 저장 단계에서 검증할 수 있도록 전체
        // 바인딩 출처를 돌려준다. UI 출처 배지는 별도로 5개만 노출한다.
        sources: regeneratedBindingSources,
        sopEvidence,
      } satisfies GeneratedSection & {
        sourceLabels: string[];
        sources: GeneratedDocSource[];
        sopEvidence: typeof sopEvidence;
      },
      responseInit()
    );
  } catch (e) {
    console.error("[generate/section] 실패:", e);
    return Response.json({ error: "재생성 중 오류가 발생했습니다." }, { status: 500 });
  }
}

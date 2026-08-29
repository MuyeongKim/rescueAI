import { generateObject } from "ai";
import { z } from "zod";
import { getChatModel } from "@/lib/llm";
import { requireApiUser } from "@/lib/auth";
import {
  AUDIENCES,
  DURATIONS,
  SLIDE_DECK_MODES,
  bindSlideVisualsToSources,
  buildGenerationRepairPrompt,
  buildGeneratePrompt,
  buildGenerateSystemPrompt,
  generatedDocSchemaFor,
  generatedSlidesSchema,
  extractSourceLabels,
  generationQualityMessages,
  inspectCurrentGenerationQuality,
  inspectGenerationQuality,
  MAX_GENERATION_CONDITIONS_CHARS,
  resolveSlideDeckMode,
  type GenerateRequest,
  type GeneratedDoc,
  type GeneratedSlideDeck,
  type GenerationQualityReport,
} from "@/lib/generate";
import { DEMO, demoGeneratedDoc, demoGeneratedSlides } from "@/lib/demo";
import { fetchCategoryContext } from "@/lib/generate-context";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { buildFocusedTrainingQuery } from "@/lib/generate-focus";
import {
  LimitedJsonBodyError,
  readLimitedJsonBody,
} from "@/lib/generated-material-save";
import {
  SOP_NOT_FOUND_DISCLOSURE,
  type SopEvidence,
} from "@/lib/sop-evidence";

export const maxDuration = 120;

const MAX_GENERATE_REQUEST_BYTES = 8 * 1024;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => value || undefined)
    .optional();

const optionalDate = z
  .string()
  .trim()
  .max(10)
  .refine((value) => value === "" || /^\d{4}-\d{2}-\d{2}$/.test(value))
  .transform((value) => value || undefined)
  .optional();

const generateRequestSchema = z
  .object({
    type: z.enum(["plan", "lesson", "slides"]),
    category: z.string().trim().min(1).max(50),
    audience: z.enum(AUDIENCES),
    duration: z.enum(DURATIONS),
    topic: z.string().trim().min(2).max(100),
    focus: optionalText(100),
    date: optionalDate,
    place: optionalText(100),
    conditions: optionalText(MAX_GENERATION_CONDITIONS_CHARS),
    slideMode: z.enum(SLIDE_DECK_MODES).optional(),
    model: optionalText(100),
  })
  .strip();

type QualityMeta = {
  checked: true;
  repaired: boolean;
  errors: string[];
  warnings: string[];
};

function qualityMeta(
  report: GenerationQualityReport,
  repaired: boolean,
  retrievalDegraded = false,
  modelFallbackUsed = false,
  sopEvidence?: SopEvidence
): QualityMeta {
  const messages = generationQualityMessages(
    report,
    [
      ...(retrievalDegraded ? ["자료 검색 일부 기능 제한 — 회수 근거 확인 필요"] : []),
      ...(modelFallbackUsed ? ["정밀 생성 모델 일시 제한 — 빠른 모델로 생성됨"] : []),
      ...(sopEvidence?.status === "not_found"
        ? ["관련 SOP 근거 미확인 — 시행 전 최신 SOP 확인 필요"]
        : sopEvidence?.status === "degraded"
          ? ["SOP 자료 검색 상태 확인 불가 — 시행 전 다시 확인 필요"]
          : []),
    ]
  );
  return { checked: true, repaired, ...messages };
}

// 인덱싱 자료를 근거로 훈련계획/교안을 생성한다. (NotebookLM 프롬프트는 클라이언트에서 조립)
export async function POST(req: Request) {
  // 실제 LLM 요청은 비정상·대용량 본문을 읽기 전에 인증과 비용 제한을 먼저 적용한다.
  if (!DEMO) {
    const auth = await requireApiUser();
    if (!auth.ok) return auth.response;

    // 문서 생성은 비용이 크므로 더 타이트하게 (분당 10회/사용자)
    // 3주 시범운영은 일반계정 1개를 5~6명이 함께 사용한다. 1회 생성+재시도까지 수용하되
    // 무제한 호출은 막도록 사용자 기준 분당 20회로 제한한다.
    const rl = rateLimit(`generate:${auth.user.id}`, 20, 60_000);
    if (!rl.ok) return tooManyRequests(rl.retryAfterSec);
  }

  let input: unknown;
  try {
    input = await readLimitedJsonBody(req, MAX_GENERATE_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof LimitedJsonBodyError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "요청 내용을 확인해 주세요." }, { status: 400 });
  }

  const parsed = generateRequestSchema.safeParse(input);
  if (!parsed.success) {
    return Response.json(
      { error: "자료 유형·분야·훈련 주제와 입력 분량을 확인해 주세요." },
      { status: 400 }
    );
  }
  const body = parsed.data;
  const topic = body.topic;

  // 데모 모드: AI/DB 없이 목 문서/슬라이드 반환
  if (DEMO) {
    const demoCategory = body.category?.trim() || "화재";
    const demoTitle = topic ? `${demoCategory} — ${topic}` : undefined;
    const demoSopEvidence: SopEvidence = { status: "not_found", sourceLabels: [] };
    if (body.type === "slides") {
      const slides = demoGeneratedSlides.slides.map((slide, index) =>
        index === 1
          ? { ...slide, notes: `${SOP_NOT_FOUND_DISCLOSURE}\n${slide.notes}` }
          : { ...slide }
      );
      return Response.json({
        ...demoGeneratedSlides,
        slides,
        mode: resolveSlideDeckMode(body.slideMode),
        title: demoTitle ?? demoGeneratedSlides.title.replace("화재", demoCategory),
        sopEvidence: demoSopEvidence,
        quality: {
          checked: true,
          repaired: false,
          errors: [],
          warnings: ["관련 SOP 근거 미확인 — 시행 전 최신 SOP 확인 필요"],
        },
      } satisfies GeneratedSlideDeck & { quality: QualityMeta });
    }
    const designatedHeading = body.type === "lesson" ? "핵심이론" : "훈련내용";
    const designatedIndex = demoGeneratedDoc.sections.findIndex(
      (section) => section.heading === designatedHeading
    );
    const fallbackIndex = designatedIndex >= 0 ? designatedIndex : 1;
    return Response.json({
      ...demoGeneratedDoc,
      sections: demoGeneratedDoc.sections.map((section, index) =>
        index === fallbackIndex
          ? { ...section, content: `${SOP_NOT_FOUND_DISCLOSURE}\n${section.content}` }
          : { ...section }
      ),
      title: demoTitle ?? demoGeneratedDoc.title.replace("화재", demoCategory),
      sopEvidence: demoSopEvidence,
      quality: {
        checked: true,
        repaired: false,
        errors: [],
        warnings: ["관련 SOP 근거 미확인 — 시행 전 최신 SOP 확인 필요"],
      },
    } satisfies GeneratedDoc & { quality: QualityMeta });
  }

  const type = body.type;
  const category = body.category;
  const audience = body.audience;
  const duration = body.duration;
  const genReq: GenerateRequest = {
    type,
    category,
    audience,
    duration,
    topic,
    focus: body.focus?.replace(/\s+/g, " "),
    date: body.date,
    place: body.place,
    conditions: body.conditions,
    slideMode: type === "slides" ? body.slideMode : undefined,
    model: body.model,
  };

  const {
    contextText,
    bindingSources,
    degraded: retrievalDegraded,
    sopEvidence,
  } = await fetchCategoryContext(
    category,
    40,
    buildFocusedTrainingQuery(genReq.topic ?? "", genReq.focus ?? "")
  );
  if (!contextText) {
    return Response.json(
      { error: "해당 분야에 인덱싱된 자료가 없어 생성할 수 없습니다." },
      { status: 422 }
    );
  }

  try {
    const system = buildGenerateSystemPrompt(category, contextText, sopEvidence);
    const allowedSourceRefs = extractSourceLabels(contextText);
    let activeModelKey = genReq.model;
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
          "[generate] 정밀 모델 호출 실패, 빠른 모델로 한 번 재시도:",
          error instanceof Error ? error.message : "unknown error"
        );
        return run(getChatModel(activeModelKey));
      }
    };

    if (type === "slides") {
      const generateSlides = async (prompt: string) =>
        withGenerationModel(async (model) => {
          const { object } = await generateObject({
            model,
            schema: generatedSlidesSchema,
            system,
            prompt,
            temperature: 0.4,
          });
          return object;
        });
      let object = await generateSlides(buildGeneratePrompt(genReq, sopEvidence));
      let report = inspectGenerationQuality(
        "slides",
        object,
        duration,
        allowedSourceRefs,
        sopEvidence
      );
      let repaired = false;
      if (!report.ok) {
        try {
          object = await generateSlides(
            buildGenerationRepairPrompt({
              type: "slides",
              request: genReq,
              draft: object,
              report,
              sopEvidence,
            })
          );
          report = inspectGenerationQuality(
            "slides",
            object,
            duration,
            allowedSourceRefs,
            sopEvidence
          );
          repaired = true;
        } catch (repairError) {
          console.error("[generate] 슬라이드 자동 보완 실패, 1차 초안 반환:", repairError);
        }
      }
      const verifiedDeck = bindSlideVisualsToSources(
        { ...object, mode: resolveSlideDeckMode(genReq.slideMode) },
        bindingSources
      );
      const finalDeck: GeneratedSlideDeck = {
        ...verifiedDeck,
        // 슬라이드 원문 페이지는 화면에 보이는 5개 밖의 근거도 사용할 수 있다. 저장 API가
        // RAG 메타데이터로 다시 검증할 수 있도록 전체 바인딩 출처를 보존한다.
        sources: bindingSources,
        sourceLabels: allowedSourceRefs,
        sopEvidence,
      };
      report = inspectCurrentGenerationQuality("slides", finalDeck, duration);
      return Response.json({
        ...finalDeck,
        quality: qualityMeta(
          report,
          repaired,
          retrievalDegraded,
          modelFallbackUsed,
          sopEvidence
        ),
      } satisfies GeneratedSlideDeck & { quality: QualityMeta });
    }

    const generateDoc = async (prompt: string) =>
      withGenerationModel(async (model) => {
        const { object } = await generateObject({
          model,
          schema: generatedDocSchemaFor(type),
          system,
          prompt,
          temperature: 0.4,
        });
        return object;
      });
    let object = await generateDoc(buildGeneratePrompt(genReq, sopEvidence));
    let report = inspectGenerationQuality(
      type,
      object,
      duration,
      allowedSourceRefs,
      sopEvidence
    );
    let repaired = false;
    if (!report.ok) {
      try {
        object = await generateDoc(
          buildGenerationRepairPrompt({
            type,
            request: genReq,
            draft: object,
            report,
            sopEvidence,
          })
        );
        report = inspectGenerationQuality(
          type,
          object,
          duration,
          allowedSourceRefs,
          sopEvidence
        );
        repaired = true;
      } catch (repairError) {
        console.error("[generate] 문서 자동 보완 실패, 1차 초안 반환:", repairError);
      }
    }
    const finalDoc: GeneratedDoc = {
      ...object,
      // 생성 본문은 화면 표시용 5개 밖의 근거도 인용할 수 있으므로 전체 검색 출처를
      // 저장 응답에 남긴다. 화면 배지는 SourceBadges에서 별도로 5개만 보여 준다.
      sources: bindingSources,
      sourceLabels: allowedSourceRefs,
      sopEvidence,
    };
    report = inspectCurrentGenerationQuality(type, finalDoc, duration);
    return Response.json({
      ...finalDoc,
      quality: qualityMeta(
        report,
        repaired,
        retrievalDegraded,
        modelFallbackUsed,
        sopEvidence
      ),
    } satisfies GeneratedDoc & { quality: QualityMeta });
  } catch (e) {
    console.error("[generate] 실패:", e);
    return Response.json(
      { error: "문서 생성 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}

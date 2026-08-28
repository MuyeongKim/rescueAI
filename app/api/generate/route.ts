import { generateObject } from "ai";
import { getChatModel } from "@/lib/llm";
import { requireApiUser } from "@/lib/auth";
import {
  AUDIENCES,
  DURATIONS,
  buildGenerationRepairPrompt,
  buildGeneratePrompt,
  buildGenerateSystemPrompt,
  generatedDocSchemaFor,
  generatedSlidesSchema,
  extractSourceLabels,
  generationQualityWarnings,
  inspectGenerationQuality,
  MAX_GENERATION_CONDITIONS_CHARS,
  type GenerateRequest,
  type GeneratedDoc,
  type GeneratedSlideDeck,
  type GenerationQualityReport,
} from "@/lib/generate";
import { DEMO, demoGeneratedDoc, demoGeneratedSlides } from "@/lib/demo";
import { fetchCategoryContext } from "@/lib/generate-context";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const maxDuration = 120;

type QualityMeta = {
  checked: true;
  repaired: boolean;
  warnings: string[];
};

function qualityMeta(
  report: GenerationQualityReport,
  repaired: boolean,
  retrievalDegraded = false,
  modelFallbackUsed = false
): QualityMeta {
  const warnings = generationQualityWarnings(
    report,
    [
      ...(retrievalDegraded ? ["자료 검색 일부 기능 제한 — 회수 근거 확인 필요"] : []),
      ...(modelFallbackUsed ? ["정밀 생성 모델 일시 제한 — 빠른 모델로 생성됨"] : []),
    ]
  );
  return { checked: true, repaired, warnings };
}

// 인덱싱 자료를 근거로 훈련계획/교안을 생성한다. (NotebookLM 프롬프트는 클라이언트에서 조립)
export async function POST(req: Request) {
  let body: Partial<GenerateRequest> = {};
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const topic = (body.topic ?? "").trim().slice(0, 100);
  if (topic.length < 2) {
    return Response.json(
      { error: "훈련 주제를 두 글자 이상 입력해 주세요." },
      { status: 400 }
    );
  }

  // 데모 모드: AI/DB 없이 목 문서/슬라이드 반환
  if (DEMO) {
    if (body.type === "slides") {
      return Response.json({
        ...demoGeneratedSlides,
        title: body.category
          ? demoGeneratedSlides.title.replace("화재", body.category)
          : demoGeneratedSlides.title,
        quality: { checked: true, repaired: false, warnings: [] },
      } satisfies GeneratedSlideDeck & { quality: QualityMeta });
    }
    return Response.json({
      ...demoGeneratedDoc,
      title: body.category
        ? demoGeneratedDoc.title.replace("화재", body.category)
        : demoGeneratedDoc.title,
      quality: { checked: true, repaired: false, warnings: [] },
    } satisfies GeneratedDoc & { quality: QualityMeta });
  }

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  // 문서 생성은 비용이 크므로 더 타이트하게 (분당 10회/사용자)
  const rl = rateLimit(`generate:${auth.user.id}`, 10, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);

  const type = body.type;
  const category = (body.category ?? "").trim();
  const audience = body.audience;
  const duration = body.duration;
  if (
    (type !== "plan" && type !== "lesson" && type !== "slides") ||
    !category ||
    !audience ||
    !AUDIENCES.includes(audience) ||
    !duration ||
    !DURATIONS.includes(duration)
  ) {
    return new Response("잘못된 요청입니다.", { status: 400 });
  }
  const genReq: GenerateRequest = {
    type,
    category,
    audience,
    duration,
    topic,
    date: /^\d{4}-\d{2}-\d{2}$/.test(body.date ?? "") ? body.date : undefined,
    place: body.place?.slice(0, 100),
    conditions:
      typeof body.conditions === "string"
        ? body.conditions.trim().slice(0, MAX_GENERATION_CONDITIONS_CHARS) || undefined
        : undefined,
    model: body.model,
  };

  const {
    contextText,
    sources,
    degraded: retrievalDegraded,
  } = await fetchCategoryContext(category, 40, genReq.topic);
  if (!contextText) {
    return Response.json(
      { error: "해당 분야에 인덱싱된 자료가 없어 생성할 수 없습니다." },
      { status: 422 }
    );
  }

  try {
    const system = buildGenerateSystemPrompt(category, contextText);
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
      let object = await generateSlides(buildGeneratePrompt(genReq));
      let report = inspectGenerationQuality("slides", object, duration, allowedSourceRefs);
      let repaired = false;
      if (!report.ok) {
        try {
          object = await generateSlides(
            buildGenerationRepairPrompt({ type: "slides", request: genReq, draft: object, report })
          );
          report = inspectGenerationQuality("slides", object, duration, allowedSourceRefs);
          repaired = true;
        } catch (repairError) {
          console.error("[generate] 슬라이드 자동 보완 실패, 1차 초안 반환:", repairError);
        }
      }
      return Response.json({
        ...object,
        sources,
        sourceLabels: allowedSourceRefs,
        quality: qualityMeta(report, repaired, retrievalDegraded, modelFallbackUsed),
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
    let object = await generateDoc(buildGeneratePrompt(genReq));
    let report = inspectGenerationQuality(type, object, duration, allowedSourceRefs);
    let repaired = false;
    if (!report.ok) {
      try {
        object = await generateDoc(
          buildGenerationRepairPrompt({ type, request: genReq, draft: object, report })
        );
        report = inspectGenerationQuality(type, object, duration, allowedSourceRefs);
        repaired = true;
      } catch (repairError) {
        console.error("[generate] 문서 자동 보완 실패, 1차 초안 반환:", repairError);
      }
    }
    return Response.json({
      ...object,
      sources,
      sourceLabels: allowedSourceRefs,
      quality: qualityMeta(report, repaired, retrievalDegraded, modelFallbackUsed),
    } satisfies GeneratedDoc & { quality: QualityMeta });
  } catch (e) {
    console.error("[generate] 실패:", e);
    return Response.json(
      { error: "문서 생성 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}

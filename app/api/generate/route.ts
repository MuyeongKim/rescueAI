import { generateObject } from "ai";
import { getChatModel } from "@/lib/llm";
import { requireApiUser } from "@/lib/auth";
import {
  bindSlideVisualsToSources,
  blockingGenerationQualityIssues,
  buildGenerationRepairPrompt,
  buildGeneratePrompt,
  buildGenerateSystemPrompt,
  generatedDocSchemaFor,
  strictGeneratedSlidesSchemaFor,
  extractSourceLabels,
  generationQualityMessages,
  inspectCurrentGenerationQuality,
  inspectGenerationQuality,
  resolveSlideDeckMode,
  stripDocumentInlineSourceRefs,
  type GenerateRequest,
  type GeneratedDoc,
  type GeneratedSlideDeck,
  type GenerationQualityIssue,
  type GenerationQualityReport,
} from "@/lib/generate";
import { generateRequestSchema } from "@/lib/generation-request";
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
import { generationProDraftCallMaxMs } from "@/lib/generation-budget";

export const maxDuration = 300;

const MAX_GENERATE_REQUEST_BYTES = 8 * 1024;
// Hobby + Fluid Compute의 300초 상한보다 먼저 내부 마감을 걸어 JSON 직렬화와 응답 전송
// 시간을 남긴다. 정밀 초안이 늦어져도 빠른 모델 재시도 시간을 침범하지 않는다.
const GENERATION_REQUEST_BUDGET_MS = 285_000;
const GENERATION_RESPONSE_RESERVE_MS = 15_000;
const GENERATION_FAST_CALL_MAX_MS = 60_000;
const GENERATION_FALLBACK_RESERVE_MS = GENERATION_FAST_CALL_MAX_MS;
const GENERATION_PRO_REPAIR_CALL_MAX_MS = 90_000;
const GENERATION_OTHER_CALL_MAX_MS = 180_000;
const GENERATION_MIN_CALL_MS = 5_000;
const GENERATION_REPAIR_MIN_REMAINING_MS =
  GENERATION_FAST_CALL_MAX_MS + GENERATION_RESPONSE_RESERVE_MS;
const GENERATION_PRO_REPAIR_MIN_REMAINING_MS =
  GENERATION_PRO_REPAIR_CALL_MAX_MS +
  GENERATION_FALLBACK_RESERVE_MS +
  GENERATION_RESPONSE_RESERVE_MS;

const FAST_REPAIR_ADOPTED_WARNING =
  "정밀 모델 초안 — 빠른 모델로 자동 보완됨";
const REPAIR_CANDIDATE_REJECTED_WARNING =
  "자동 보완 결과가 개선되지 않아 기존 초안을 유지함";

class GenerationTimeBudgetError extends Error {
  constructor() {
    super("AI 자료제작 시간 예산이 부족합니다.");
    this.name = "GenerationTimeBudgetError";
  }
}

function remainingGenerationMs(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

function generationAbortSignal(
  requestSignal: AbortSignal,
  deadlineMs: number,
  maxCallMs: number,
  additionalReserveMs = 0
): AbortSignal {
  const availableMs =
    remainingGenerationMs(deadlineMs) - GENERATION_RESPONSE_RESERVE_MS - additionalReserveMs;
  if (availableMs < GENERATION_MIN_CALL_MS) throw new GenerationTimeBudgetError();
  return AbortSignal.any([
    requestSignal,
    AbortSignal.timeout(Math.max(1, Math.min(maxCallMs, availableMs))),
  ]);
}

function isGenerationBudgetError(error: unknown): boolean {
  const errorName =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name ?? "")
      : "";
  return (
    error instanceof GenerationTimeBudgetError ||
    errorName === "AbortError" ||
    errorName === "TimeoutError"
  );
}

function generationQualityScore(
  report: GenerationQualityReport
): readonly [blockingIssues: number, totalIssues: number] {
  return [blockingGenerationQualityIssues(report).length, report.issues.length];
}

function isGenerationQualityImprovement(
  current: GenerationQualityReport,
  candidate: GenerationQualityReport
): boolean {
  const [currentBlocking, currentTotal] = generationQualityScore(current);
  const [candidateBlocking, candidateTotal] = generationQualityScore(candidate);
  return (
    candidateBlocking < currentBlocking ||
    (candidateBlocking === currentBlocking && candidateTotal < currentTotal)
  );
}

function warnRejectedRepairCandidate(
  type: "plan" | "lesson" | "slides",
  current: GenerationQualityReport,
  candidate: GenerationQualityReport
): void {
  const [currentBlocking, currentTotal] = generationQualityScore(current);
  const [candidateBlocking, candidateTotal] = generationQualityScore(candidate);
  console.warn("[generate] 자동 보완 결과 미채택, 기존 초안 유지:", {
    type,
    currentBlocking,
    currentTotal,
    candidateBlocking,
    candidateTotal,
  });
}

type QualityMeta = {
  checked: true;
  repaired: boolean;
  errors: string[];
  warnings: string[];
  issues: GenerationQualityIssue[];
};

function qualityMeta(
  report: GenerationQualityReport,
  repaired: boolean,
  retrievalDegraded = false,
  modelFallbackUsed = false,
  sopEvidence?: SopEvidence,
  generationBudgetLimited = false,
  fastRepairAdopted = false,
  repairCandidateRejected = false
): QualityMeta {
  const messages = generationQualityMessages(
    report,
    [
      ...(sopEvidence?.status === "not_found"
        ? ["관련 SOP 근거 미확인 — 시행 전 최신 SOP 확인 필요"]
        : sopEvidence?.status === "degraded"
          ? ["SOP 자료 검색 상태 확인 불가 — 시행 전 다시 확인 필요"]
          : []),
      ...(modelFallbackUsed ? ["정밀 생성 모델 일시 제한 — 빠른 모델로 생성됨"] : []),
      ...(fastRepairAdopted ? [FAST_REPAIR_ADOPTED_WARNING] : []),
      ...(repairCandidateRejected ? [REPAIR_CANDIDATE_REJECTED_WARNING] : []),
      ...(generationBudgetLimited
        ? ["생성 시간 보호 — 자동 보완을 생략했으므로 표시된 항목만 확인 필요"]
        : []),
      ...(retrievalDegraded ? ["자료 검색 일부 기능 제한 — 회수 근거 확인 필요"] : []),
    ]
  );
  return { checked: true, repaired, ...messages, issues: report.issues };
}

// 인덱싱 자료를 근거로 훈련계획/교안을 생성한다. (NotebookLM 프롬프트는 클라이언트에서 조립)
export async function POST(req: Request) {
  const generationDeadlineMs = Date.now() + GENERATION_REQUEST_BUDGET_MS;
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
          issues: [],
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
        issues: [],
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
    if (type === "slides" && allowedSourceRefs.length === 0) {
      return Response.json(
        { error: "슬라이드에 연결할 검증된 근거 출처가 없습니다." },
        { status: 422 }
      );
    }
    let activeModelKey = genReq.model;
    let modelFallbackUsed = false;
    let generationBudgetLimited = false;
    let fastRepairAdopted = false;
    let repairCandidateRejected = false;
    let lastGenerationModelKey: string | undefined;
    const withGenerationModel = async <T,>(
      run: (model: ReturnType<typeof getChatModel>, abortSignal: AbortSignal) => Promise<T>,
      phase: "draft" | "repair"
    ): Promise<T> => {
      const switchToFlash = (reason: string, error?: unknown) => {
        activeModelKey = "gemini-flash";
        modelFallbackUsed ||= phase === "draft";
        if (error === undefined) {
          console.info(`[generate] ${reason}, 빠른 모델로 전환`);
        } else {
          console.warn(
            `[generate] ${reason}, 빠른 모델로 전환:`,
            error instanceof Error ? error.message : "unknown error"
          );
        }
      };

      // 전체 JSON을 다시 쓰는 Pro 보완은 자체 90초와 Flash 복구 60초를 모두 담을 때만
      // 시도한다. 시간이 부족하면 정밀 초안은 보존한 채 빠른 모델로 보완한다.
      if (
        phase === "repair" &&
        activeModelKey === "gemini-pro" &&
        remainingGenerationMs(generationDeadlineMs) <
          GENERATION_PRO_REPAIR_MIN_REMAINING_MS
      ) {
        switchToFlash("자동 보완 정밀 모델 시간 예산 부족");
      }

      const canFallback = activeModelKey === "gemini-pro";
      if (
        canFallback &&
        remainingGenerationMs(generationDeadlineMs) <
          GENERATION_FALLBACK_RESERVE_MS +
            GENERATION_RESPONSE_RESERVE_MS +
            GENERATION_MIN_CALL_MS
      ) {
        switchToFlash("정밀 모델 실행 시간 예산 부족");
      }

      try {
        const reserveMs =
          activeModelKey === "gemini-pro" ? GENERATION_FALLBACK_RESERVE_MS : 0;
        const maxCallMs =
          activeModelKey === "gemini-pro"
            ? phase === "repair"
              ? GENERATION_PRO_REPAIR_CALL_MAX_MS
              : generationProDraftCallMaxMs(type)
            : activeModelKey === "gemini-flash"
              ? GENERATION_FAST_CALL_MAX_MS
              : GENERATION_OTHER_CALL_MAX_MS;
        lastGenerationModelKey = activeModelKey;
        return await run(
          getChatModel(activeModelKey),
          generationAbortSignal(req.signal, generationDeadlineMs, maxCallMs, reserveMs)
        );
      } catch (error) {
        if (req.signal.aborted) throw error;
        if (activeModelKey !== "gemini-pro") throw error;
        switchToFlash("정밀 모델 호출 실패", error);
        lastGenerationModelKey = activeModelKey;
        return run(
          getChatModel(activeModelKey),
          generationAbortSignal(
            req.signal,
            generationDeadlineMs,
            GENERATION_FAST_CALL_MAX_MS
          )
        );
      }
    };

    if (type === "slides") {
      const strictSlidesSchema = strictGeneratedSlidesSchemaFor(allowedSourceRefs);
      const generateSlides = async (prompt: string) =>
        withGenerationModel(async (model, abortSignal) => {
          const { object } = await generateObject({
            model,
            schema: strictSlidesSchema,
            system,
            prompt,
            temperature: 0.4,
            abortSignal,
          });
          return object;
        }, "draft");
      const repairSlides = async (prompt: string) =>
        withGenerationModel(async (model, abortSignal) => {
          const { object } = await generateObject({
            model,
            schema: strictSlidesSchema,
            system,
            prompt,
            temperature: 0.4,
            abortSignal,
          });
          return object;
        }, "repair");
      let object = await generateSlides(buildGeneratePrompt(genReq, sopEvidence));
      const precisionDraftUsed = lastGenerationModelKey === "gemini-pro";
      let report = inspectGenerationQuality(
        "slides",
        object,
        duration,
        allowedSourceRefs,
        sopEvidence
      );
      let repaired = false;
      if (
        !report.ok &&
        remainingGenerationMs(generationDeadlineMs) >= GENERATION_REPAIR_MIN_REMAINING_MS
      ) {
        try {
          const candidate = await repairSlides(
            buildGenerationRepairPrompt({
              type: "slides",
              request: genReq,
              draft: object,
              report,
              sopEvidence,
            })
          );
          const candidateReport = inspectGenerationQuality(
            "slides",
            candidate,
            duration,
            allowedSourceRefs,
            sopEvidence
          );
          if (isGenerationQualityImprovement(report, candidateReport)) {
            object = candidate;
            report = candidateReport;
            repaired = true;
            fastRepairAdopted ||=
              precisionDraftUsed && lastGenerationModelKey === "gemini-flash";
          } else {
            repairCandidateRejected = true;
            warnRejectedRepairCandidate("slides", report, candidateReport);
          }
        } catch (repairError) {
          generationBudgetLimited ||= isGenerationBudgetError(repairError);
          console.error("[generate] 슬라이드 자동 보완 실패, 1차 초안 반환:", repairError);
        }
      } else if (!report.ok) {
        generationBudgetLimited = true;
        console.warn("[generate] 슬라이드 자동 보완 생략: 응답 시간 예산 보호");
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
          sopEvidence,
          generationBudgetLimited,
          fastRepairAdopted,
          repairCandidateRejected
        ),
      } satisfies GeneratedSlideDeck & { quality: QualityMeta });
    }

    const generateDoc = async (prompt: string) =>
      withGenerationModel(async (model, abortSignal) => {
        const { object } = await generateObject({
          model,
          schema: generatedDocSchemaFor(type),
          system,
          prompt,
          temperature: 0.4,
          abortSignal,
        });
        return object;
      }, "draft");
    const repairDoc = async (prompt: string) =>
      withGenerationModel(async (model, abortSignal) => {
        const { object } = await generateObject({
          model,
          schema: generatedDocSchemaFor(type),
          system,
          prompt,
          temperature: 0.4,
          abortSignal,
        });
        return object;
      }, "repair");
    let object = stripDocumentInlineSourceRefs(
      await generateDoc(buildGeneratePrompt(genReq, sopEvidence)),
      allowedSourceRefs
    );
    const precisionDraftUsed = lastGenerationModelKey === "gemini-pro";
    let report = inspectGenerationQuality(
      type,
      object,
      duration,
      allowedSourceRefs,
      sopEvidence
    );
    let repaired = false;
    if (
      !report.ok &&
      remainingGenerationMs(generationDeadlineMs) >= GENERATION_REPAIR_MIN_REMAINING_MS
    ) {
      try {
        const candidate = stripDocumentInlineSourceRefs(
          await repairDoc(
            buildGenerationRepairPrompt({
              type,
              request: genReq,
              draft: object,
              report,
              sopEvidence,
            })
          ),
          allowedSourceRefs
        );
        const candidateReport = inspectGenerationQuality(
          type,
          candidate,
          duration,
          allowedSourceRefs,
          sopEvidence
        );
        if (isGenerationQualityImprovement(report, candidateReport)) {
          object = candidate;
          report = candidateReport;
          repaired = true;
          fastRepairAdopted ||=
            precisionDraftUsed && lastGenerationModelKey === "gemini-flash";
        } else {
          repairCandidateRejected = true;
          warnRejectedRepairCandidate(type, report, candidateReport);
        }
      } catch (repairError) {
        generationBudgetLimited ||= isGenerationBudgetError(repairError);
        console.error("[generate] 문서 자동 보완 실패, 1차 초안 반환:", repairError);
      }
    } else if (!report.ok) {
      generationBudgetLimited = true;
      console.warn("[generate] 문서 자동 보완 생략: 응답 시간 예산 보호");
    }
    const finalDoc: GeneratedDoc = {
      ...object,
      // 본문에서 분리한 검증 출처를 완성 문서 맨 뒤의 '근거 자료 및 출처'에 쓸 수 있도록
      // 화면 표시 한도와 무관하게 전체 바인딩 출처를 보존한다.
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
        sopEvidence,
        generationBudgetLimited,
        fastRepairAdopted,
        repairCandidateRejected
      ),
    } satisfies GeneratedDoc & { quality: QualityMeta });
  } catch (e) {
    console.error("[generate] 실패:", e);
    if (isGenerationBudgetError(e)) {
      return Response.json(
        { error: "생성 시간이 길어 요청을 안전하게 종료했습니다. 잠시 후 다시 시도해 주세요." },
        { status: 503 }
      );
    }
    return Response.json(
      { error: "문서 생성 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}

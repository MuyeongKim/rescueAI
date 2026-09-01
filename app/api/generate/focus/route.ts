import { generateObject } from "ai";
import { z } from "zod";

import { requireApiUser } from "@/lib/auth";
import { DEMO } from "@/lib/demo";
import {
  MAX_TRAINING_FOCUS_CANDIDATES,
  MAX_TRAINING_FOCUS_OPTIONS,
  buildTrainingFocusSuggestionPrompt,
  extractTrainingFocusEvidenceBySource,
  filterGroundedTrainingFocusOptionsWithDiagnostics,
  isLikelyBroadTrainingTopic,
  trainingFocusSuggestionsSchema,
  type SimilarTrainingMaterial,
  type TrainingFocusOption,
} from "@/lib/generate-focus";
import { extractSourceLabels } from "@/lib/generate";
import { fetchCategoryContext } from "@/lib/generate-context";
import {
  LimitedJsonBodyError,
  readLimitedJsonBody,
} from "@/lib/generated-material-save";
import { getChatModel } from "@/lib/llm";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";
import {
  prioritizeTrainingFocusOptions,
  selectTrainingTopicHistory,
  type StoredTrainingMaterialRow,
} from "@/lib/training-focus-history";

export const maxDuration = 60;

const requestSchema = z
  .object({
    category: z.string().trim().min(1).max(50),
    topic: z.string().trim().min(2).max(100),
    excludeFocuses: z.array(z.string().trim().min(2).max(100)).max(60).default([]),
    model: z.string().trim().max(100).optional(),
  })
  .strip();

function demoOptions(category: string): TrainingFocusOption[] {
  const examples: Record<string, Array<[string, string]>> = {
    산악: [
      ["조난자 수색구역 설정과 위치 확인", "수색 범위를 나누고 위치정보를 공유하는 판단과 보고를 실습합니다."],
      ["급경사 로프 접근과 확보", "급경사 지형에서 접근 전 확보 지점과 대원 역할을 확인합니다."],
      ["추락환자 들것 결착과 이송", "환자 고정부터 들것 결착, 경사면 이송까지 연결해 수행합니다."],
      ["야간 산악수색 안전관리", "시야가 제한된 상황에서 대원 추적과 중단·보고 기준을 점검합니다."],
    ],
  };
  return (examples[category] ?? examples.산악).map(([title, description], index) => ({
    id: `focus-${index + 1}`,
    title,
    description,
    sourceRefs: ["[데모 연결 교범 p.1]"],
  }));
}

export async function POST(request: Request) {
  if (DEMO) {
    let input: unknown;
    try {
      input = await readLimitedJsonBody(request, 8 * 1024);
    } catch (error) {
      if (error instanceof LimitedJsonBodyError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      return Response.json({ error: "요청 내용을 확인해 주세요." }, { status: 400 });
    }
    try {
      const parsed = requestSchema.parse(input);
      if (!isLikelyBroadTrainingTopic(parsed.topic)) {
        return Response.json({
          scope: "specific",
          options: [],
          similarMaterials: [],
          warnings: [],
        });
      }
      return Response.json({
        scope: "broad",
        options: demoOptions(parsed.category),
        similarMaterials: [],
        // 데모 후보는 고정 예시라 입력 주제에 따른 추천 순위를 단정하지 않는다.
        warnings: [],
        historyBasis: "demo",
      });
    } catch {
      return Response.json({ error: "요청 내용을 확인해 주세요." }, { status: 400 });
    }
  }

  // 비용이 드는 추천 API이므로 인증과 레이트리밋을 본문 파싱보다 먼저 확인한다.
  const supabase = await createClient();
  const auth = await requireApiUser(supabase);
  if (!auth.ok) return auth.response;
  const rl = rateLimit(`generate-focus:${auth.user.id}`, 20, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);

  let input: unknown;
  try {
    input = await readLimitedJsonBody(request, 8 * 1024);
  } catch (error) {
    if (error instanceof LimitedJsonBodyError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "요청 내용을 확인해 주세요." }, { status: 400 });
  }
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) {
    return Response.json({ error: "분야와 훈련 주제를 확인해 주세요." }, { status: 400 });
  }
  const { category, topic, excludeFocuses, model } = parsed.data;
  if (!isLikelyBroadTrainingTopic(topic)) {
    return Response.json({
      scope: "specific",
      options: [],
      similarMaterials: [],
      warnings: [],
    });
  }

  try {
    const [context, historyResult] = await Promise.all([
      fetchCategoryContext(category, 40, topic),
      (supabase.from as CallableFunction)("generated_materials")
        // 본문 전체를 내려받지 않고 유사 자료 안내와 중복 비교에 필요한 최소 필드만 투영한다.
        .select("id, kind, category, topic, title, created_at, focus:content->>focus")
        .eq("user_id", auth.user.id)
        .eq("category", category)
        .in("kind", ["plan", "lesson", "slides"])
        .order("created_at", { ascending: false })
        .limit(100),
    ]);
    if (!context.contextText) {
      return Response.json(
        { error: "연결된 자료에서 세부 훈련 방향의 근거를 찾지 못했습니다." },
        { status: 422 }
      );
    }
    if (historyResult.error) {
      console.error("[generate/focus] 최근 개인 자료 조회 실패:", historyResult.error.message);
    }

    const allowedSourceRefs = extractSourceLabels(context.contextText);
    const topicHistory = historyResult.error
      ? { comparisonFocuses: [] as string[], similarMaterials: [] as SimilarTrainingMaterial[] }
      : selectTrainingTopicHistory(
          (historyResult.data ?? []) as StoredTrainingMaterialRow[],
          topic
        );
    // 저장 이력은 새 후보를 삭제하지 않고 뒤로 정렬한다. 현재 추천 세션에서 이미 본 방향만
    // hard exclusion으로 유지해 ‘다른 방향 추천’의 의미를 보장한다.
    const sessionExcluded = Array.from(new Set(excludeFocuses)).slice(0, 60);
    const prompt = buildTrainingFocusSuggestionPrompt({
      category,
      topic,
      contextText: context.contextText,
      allowedSourceRefs,
      excludedFocuses: sessionExcluded,
    });

    let activeModel = model;
    let fallbackUsed = false;
    const run = async () =>
      generateObject({
        model: getChatModel(activeModel),
        schema: trainingFocusSuggestionsSchema,
        prompt,
        temperature: 0.45,
      });
    let generated;
    try {
      generated = await run();
    } catch (error) {
      if (activeModel !== "gemini-pro") throw error;
      activeModel = "gemini-flash";
      fallbackUsed = true;
      generated = await run();
    }

    const filtered = filterGroundedTrainingFocusOptionsWithDiagnostics(
      generated.object.options,
      allowedSourceRefs,
      sessionExcluded,
      {
        evidenceBySource: extractTrainingFocusEvidenceBySource(context.contextText),
        maxOptions: MAX_TRAINING_FOCUS_CANDIDATES,
      }
    );
    const options = prioritizeTrainingFocusOptions(
      filtered.options,
      topicHistory.comparisonFocuses
    )
      .slice(0, MAX_TRAINING_FOCUS_OPTIONS)
      .map((option, index) => ({ ...option, id: `focus-${index + 1}` }));
    if (
      filtered.diagnostics.totalCandidates !== filtered.diagnostics.accepted ||
      options.length < 4
    ) {
      // 사용자 입력·문서 원문은 로그에 넣지 않고 단계별 개수만 남긴다.
      console.info("[generate/focus] 후보 선별 집계:", {
        totalCandidates: filtered.diagnostics.totalCandidates,
        acceptedBeforeRanking: filtered.diagnostics.accepted,
        finalOptions: options.length,
        ...filtered.diagnostics.rejected,
      });
    }
    if (options.length === 0 && topicHistory.similarMaterials.length === 0) {
      return Response.json(
        {
          error:
            "현재 연결 자료에서는 근거가 있는 새 훈련 방향을 찾지 못했습니다.",
        },
        { status: 422 }
      );
    }
    const warnings = [
      ...(options.length < 4
        ? ["연결 자료 범위에서 새로 제안할 방향을 4개보다 적게 찾았습니다."]
        : []),
      ...(context.degraded ? ["자료 검색 일부 기능이 제한되었습니다."] : []),
      ...(historyResult.error ? ["최근 저장 자료와의 중복 비교를 완료하지 못했습니다."] : []),
      ...(fallbackUsed ? ["빠른 모델로 추천했습니다."] : []),
    ];
    return Response.json({
      scope: "broad",
      options,
      similarMaterials: topicHistory.similarMaterials,
      // 프롬프트의 추천 우선순위와 서버의 근거·중복 필터를 모두 통과한 최상위 후보다.
      recommendedId: options[0]?.id,
      warnings,
      historyBasis: historyResult.error ? "request-only" : "saved-materials",
    });
  } catch (error) {
    console.error(
      "[generate/focus] 세부 방향 추천 실패:",
      error instanceof Error ? error.message : error
    );
    return Response.json(
      { error: "세부 훈련 방향을 찾는 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}

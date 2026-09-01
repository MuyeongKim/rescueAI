import { generateObject } from "ai";
import { z } from "zod";

import { requireApiUser } from "@/lib/auth";
import { DEMO } from "@/lib/demo";
import {
  buildTrainingFocusSuggestionPrompt,
  extractTrainingFocusEvidenceBySource,
  filterGroundedTrainingFocusOptions,
  isLikelyBroadTrainingTopic,
  trainingFocusSuggestionsSchema,
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

export const maxDuration = 60;

const requestSchema = z
  .object({
    category: z.string().trim().min(1).max(50),
    topic: z.string().trim().min(2).max(100),
    excludeFocuses: z.array(z.string().trim().min(2).max(100)).max(60).default([]),
    model: z.string().trim().max(100).optional(),
  })
  .strip();

type StoredFocusRow = {
  topic: string | null;
  focus: string | null;
};

function storedFocuses(rows: readonly StoredFocusRow[]): string[] {
  const focuses = new Set<string>();
  for (const row of rows) {
    if (typeof row.focus === "string" && row.focus.trim().length >= 2) {
      focuses.add(row.focus.trim().slice(0, 100));
      continue;
    }
    // 기능 도입 전 저장본은 focus가 없으므로 구체적인 기존 주제를 중복 비교 기준으로 보완한다.
    if (typeof row.topic === "string" && row.topic.trim().length >= 2) {
      focuses.add(row.topic.trim().slice(0, 100));
    }
  }
  return Array.from(focuses);
}

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
        return Response.json({ scope: "specific", options: [], warnings: [] });
      }
      return Response.json({
        scope: "broad",
        options: demoOptions(parsed.category),
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
    return Response.json({ scope: "specific", options: [], warnings: [] });
  }

  try {
    const [context, historyResult] = await Promise.all([
      fetchCategoryContext(category, 40, topic),
      (supabase.from as CallableFunction)("generated_materials")
        // 저장 본문 전체를 내려받지 않고 중복 비교에 필요한 JSON 문자열 하나만 투영한다.
        .select("topic, focus:content->>focus")
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
    const recentFocuses = historyResult.error
      ? []
      : storedFocuses((historyResult.data ?? []) as StoredFocusRow[]);
    const excluded = Array.from(new Set([...recentFocuses, ...excludeFocuses])).slice(0, 120);
    const prompt = buildTrainingFocusSuggestionPrompt({
      category,
      topic,
      contextText: context.contextText,
      allowedSourceRefs,
      excludedFocuses: excluded,
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

    const options = filterGroundedTrainingFocusOptions(
      generated.object.options,
      allowedSourceRefs,
      excluded,
      undefined,
      extractTrainingFocusEvidenceBySource(context.contextText)
    );
    if (options.length === 0) {
      return Response.json(
        {
          error:
            "현재 연결 자료와 최근 생성 이력 안에서는 근거가 있는 새 훈련 방향을 찾지 못했습니다.",
        },
        { status: 422 }
      );
    }
    const warnings = [
      ...(options.length < 4
        ? ["연결 자료 범위에서 서로 다른 방향을 4개보다 적게 찾았습니다."]
        : []),
      ...(context.degraded ? ["자료 검색 일부 기능이 제한되었습니다."] : []),
      ...(historyResult.error ? ["최근 저장 자료와의 중복 비교를 완료하지 못했습니다."] : []),
      ...(fallbackUsed ? ["빠른 모델로 추천했습니다."] : []),
    ];
    return Response.json({
      scope: "broad",
      options,
      // 프롬프트의 추천 우선순위와 서버의 근거·중복 필터를 모두 통과한 최상위 후보다.
      recommendedId: options[0].id,
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

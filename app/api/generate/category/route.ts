import { generateObject } from "ai";
import { z } from "zod";

import { requireApiUser } from "@/lib/auth";
import { DEMO } from "@/lib/demo";
import {
  buildCategoryRecommendationPrompt,
  buildLowConfidenceCategoryFallback,
  categoryRecommendationModelSchema,
  classifyCategoryDeterministically,
  normalizeCategoryRecommendationText,
  sanitizeModelCategoryRecommendation,
  type CategoryRecommendationCandidate,
} from "@/lib/generate-category";
import {
  LimitedJsonBodyError,
  readLimitedJsonBody,
} from "@/lib/generated-material-save";
import { getChatModel } from "@/lib/llm";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const maxDuration = 30;

const MAX_CATEGORY_RECOMMENDATION_REQUEST_BYTES = 120 * 1024;
const MAX_CATEGORY_SOURCE_TITLE_CHARS = 8_000;
const CATEGORY_MODEL_TIMEOUT_MS = 15_000;
const CATEGORY_MODEL_RATE_LIMIT = 10;

const categorySchema = z
  .object({
    name: z.string().trim().min(1).max(50),
    sourceTitles: z.array(z.string().trim().min(1).max(200)).max(5).optional(),
  })
  .strict();

const requestSchema = z
  .object({
    topic: z.string().trim().min(2).max(100),
    categories: z.array(categorySchema).min(1).max(30),
  })
  .strict()
  .superRefine((value, context) => {
    const normalizedNames = value.categories.map((category) =>
      normalizeCategoryRecommendationText(category.name)
    );
    if (
      normalizedNames.some((name) => !name) ||
      new Set(normalizedNames).size !== normalizedNames.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["categories"],
        message: "분야 이름은 비어 있거나 중복될 수 없습니다.",
      });
    }

    const sourceTitleChars = value.categories.reduce(
      (total, category) =>
        total +
        (category.sourceTitles ?? []).reduce(
          (categoryTotal, title) => categoryTotal + Array.from(title).length,
          0
        ),
      0
    );
    if (sourceTitleChars > MAX_CATEGORY_SOURCE_TITLE_CHARS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["categories"],
        message: "자료 제목의 전체 길이가 허용 범위를 넘었습니다.",
      });
    }
  });

function json(payload: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return Response.json(payload, { ...init, headers });
}

async function parseInput(request: Request): Promise<
  | { ok: true; topic: string; categories: CategoryRecommendationCandidate[] }
  | { ok: false; response: Response }
> {
  let input: unknown;
  try {
    input = await readLimitedJsonBody(request, MAX_CATEGORY_RECOMMENDATION_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof LimitedJsonBodyError) {
      return {
        ok: false,
        response: json(
          {
            error:
              error.status === 413 ? "요청 내용이 너무 큽니다." : "요청 내용을 확인해 주세요.",
          },
          { status: error.status }
        ),
      };
    }
    return {
      ok: false,
      response: json({ error: "요청 내용을 확인해 주세요." }, { status: 400 }),
    };
  }

  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      response: json(
        { error: "주제와 사용 가능한 분야 목록을 확인해 주세요." },
        { status: 400 }
      ),
    };
  }
  return { ok: true, ...parsed.data };
}

function demoRecommendation(
  topic: string,
  categories: readonly CategoryRecommendationCandidate[]
): Response {
  const deterministic = classifyCategoryDeterministically(topic, categories);
  if (deterministic) return json(deterministic);
  return json(
    buildLowConfidenceCategoryFallback(
      topic,
      categories,
      "데모에서는 애매한 주제를 정밀 판정하지 않습니다. 추천 분야를 확인해 주세요."
    )
  );
}

export async function POST(request: Request) {
  if (DEMO) {
    const parsed = await parseInput(request);
    if (!parsed.ok) return parsed.response;
    return demoRecommendation(parsed.topic, parsed.categories);
  }

  // 인증·사용자별 호출 제한을 본문 파싱과 모델 호출보다 먼저 적용한다.
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;
  const limited = rateLimit(`generate-category:${auth.user.id}`, 30, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSec);

  const parsed = await parseInput(request);
  if (!parsed.ok) return parsed.response;

  const deterministic = classifyCategoryDeterministically(parsed.topic, parsed.categories);
  if (deterministic) return json(deterministic);

  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim()) {
    return json(
      buildLowConfidenceCategoryFallback(
        parsed.topic,
        parsed.categories,
        "빠른 자동 판정 모델이 연결되지 않았습니다. 임시 추천 분야를 확인해 주세요."
      )
    );
  }

  const modelLimited = rateLimit(
    `generate-category-model:${auth.user.id}`,
    CATEGORY_MODEL_RATE_LIMIT,
    60_000
  );
  if (!modelLimited.ok) {
    return json(
      buildLowConfidenceCategoryFallback(
        parsed.topic,
        parsed.categories,
        "자동 정밀 판정 요청이 잠시 많아 임시 후보를 제안했습니다. 추천 분야를 직접 확인해 주세요."
      )
    );
  }

  const controller = new AbortController();
  const abortFromRequest = () => controller.abort();
  if (request.signal.aborted) abortFromRequest();
  else request.signal.addEventListener("abort", abortFromRequest, { once: true });
  const timeout = setTimeout(() => controller.abort(), CATEGORY_MODEL_TIMEOUT_MS);
  try {
    if (controller.signal.aborted) {
      return json(
        buildLowConfidenceCategoryFallback(
          parsed.topic,
          parsed.categories,
          "자동 분야 판정 요청이 취소되었습니다. 추천 분야를 확인해 주세요."
        )
      );
    }
    const generated = await generateObject({
      model: getChatModel("gemini-flash"),
      schema: categoryRecommendationModelSchema,
      prompt: buildCategoryRecommendationPrompt(parsed.topic, parsed.categories),
      temperature: 0,
      abortSignal: controller.signal,
    });
    const recommendation = sanitizeModelCategoryRecommendation(
      generated.object,
      parsed.categories
    );
    if (recommendation) return json(recommendation);

    return json(
      buildLowConfidenceCategoryFallback(
        parsed.topic,
        parsed.categories,
        "자동 판정 결과가 사용 가능한 분야와 일치하지 않습니다. 추천 분야를 확인해 주세요."
      )
    );
  } catch {
    // 예외 객체에는 제공자 요청 본문이 포함될 수 있어 사용자 주제·자료 제목과 함께 로그하지 않는다.
    return json(
      buildLowConfidenceCategoryFallback(
        parsed.topic,
        parsed.categories,
        request.signal.aborted
          ? "자동 분야 판정 요청이 취소되었습니다. 추천 분야를 확인해 주세요."
          : "자동 분야 판정을 완료하지 못했습니다. 임시 추천 분야를 확인해 주세요."
      )
    );
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", abortFromRequest);
  }
}

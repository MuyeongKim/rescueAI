import { describe, expect, it } from "vitest";

import { generationErrorInfo } from "@/lib/generation-model-error";

describe("정밀 모델 오류 분류", () => {
  it("AI SDK RetryError가 감싼 마지막 503 provider 오류를 복구 후보 전환 대상으로 찾는다", () => {
    const error = {
      name: "AI_RetryError",
      message: "Failed after 3 attempts",
      lastError: {
        name: "AI_APICallError",
        message: "Service unavailable",
        statusCode: 503,
      },
    };

    const info = generationErrorInfo(error);

    expect(info.status).toBe(503);
    expect(info.serverFailure).toBe(true);
  });

  it("cause와 errors 배열 안의 인증·제한·timeout 신호도 놓치지 않는다", () => {
    const error = {
      name: "AI_RetryError",
      cause: { name: "TimeoutError", message: "request timed out" },
      errors: [
        { statusCode: 429, message: "resource exhausted" },
        { statusCode: 403, message: "permission denied" },
      ],
    };

    const info = generationErrorInfo(error);

    expect(info.authentication).toBe(true);
    expect(info.rateLimited).toBe(true);
    expect(info.timedOut).toBe(true);
  });

  it("순환 cause가 있어도 제한된 탐색으로 종료한다", () => {
    const error: { message: string; cause?: unknown } = { message: "network socket reset" };
    error.cause = error;

    expect(generationErrorInfo(error).networkFailure).toBe(true);
  });
});

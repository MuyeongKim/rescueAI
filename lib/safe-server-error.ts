/**
 * SDK/DB 오류에는 질문, 생성 본문, 인증 헤더와 중첩 cause가 들어갈 수 있다.
 * 로그에는 고정 분류와 HTTP 상태만 허용한다. message/name/code 자체도 신뢰하지 않는다.
 * 이 함수의 반환값만 기록하고 원래 오류는 사용자 안내 분기에만 사용한다.
 */
type SafeErrorDetails = {
  code: string;
  status?: number;
  reason?: "schema_validation_failed" | "json_parse_failed";
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
};

export function safeServerError(error: unknown): SafeErrorDetails {
  let name: unknown;
  let status: unknown;
  try {
    if (error !== null && typeof error === "object") {
      const value = error as { name?: unknown; statusCode?: unknown; status?: unknown };
      name = value.name;
      status = value.statusCode ?? value.status;
    }
  } catch {
    // 오류 객체의 getter/proxy도 로그 처리 실패나 원문 유출을 유발하지 않게 한다.
  }
  const code = name === "AbortError" ? "request_aborted"
    : name === "TimeoutError" ? "request_timeout"
    : name === "AI_NoObjectGeneratedError" ? "ai_invalid_output"
    : name === "AI_APICallError" ? "ai_upstream_failure"
    : name === "AI_RetryError" ? "ai_retry_exhausted"
    : name === "ZodError" ? "validation_failed"
    : "operation_failed";
  const details: SafeErrorDetails = typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? { code, status }
    : { code };
  // 생성 실패의 원인을 구별하되, 실제 응답·schema issue·cause 객체는 기록하지 않는다.
  // 값이 있는 객체를 통째로 복사하지 않고 알려진 종료 사유와 정수 계수만 허용한다.
  if (name === "AI_NoObjectGeneratedError") {
    try {
      const value = error as { cause?: { name?: unknown }; finishReason?: unknown; usage?: { inputTokens?: unknown; outputTokens?: unknown } };
      const causeName = value.cause?.name;
      if (causeName === "AI_TypeValidationError" || causeName === "ZodError") details.reason = "schema_validation_failed";
      if (causeName === "AI_JSONParseError" || causeName === "SyntaxError") details.reason = "json_parse_failed";
      const finish = value.finishReason;
      if (typeof finish === "string" && ["stop", "length", "content-filter", "tool-calls", "error", "other", "unknown"].includes(finish)) {
        details.finishReason = finish;
      }
      const usage = value.usage;
      for (const key of ["inputTokens", "outputTokens"] as const) {
        const tokens = usage?.[key];
        if (typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0) details[key] = tokens;
      }
    } catch { /* 관찰용 속성의 getter도 실패를 전파하거나 본문을 노출하지 않는다. */ }
  }
  return details;
}

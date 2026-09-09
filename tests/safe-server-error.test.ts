import { describe, expect, it } from "vitest";
import { safeServerError } from "@/lib/safe-server-error";

describe("서버 오류 로그의 안전한 진단 정보", () => {
  it("생성 실패의 고정 분류와 정상 정수 계수만 남긴다", () => {
    const result = safeServerError({
      name: "AI_NoObjectGeneratedError", message: "synthetic-private-text", text: "synthetic-private-response",
      cause: { name: "AI_TypeValidationError", value: "synthetic-private-object", message: "synthetic-private-schema-error" },
      finishReason: "stop", usage: { inputTokens: 1200, outputTokens: 80, raw: "synthetic-private-usage" },
    });
    expect(result).toEqual({ code: "ai_invalid_output", reason: "schema_validation_failed", finishReason: "stop", inputTokens: 1200, outputTokens: 80 });
    expect(JSON.stringify(result)).not.toContain("synthetic-private");
  });
  it("JSON 해석 실패와 잘림을 구분한다", () => {
    expect(safeServerError({ name: "AI_NoObjectGeneratedError", cause: { name: "AI_JSONParseError" }, finishReason: "length" })).toEqual({ code: "ai_invalid_output", reason: "json_parse_failed", finishReason: "length" });
  });
  it("모델이 종료 사유·숫자·cause 이름에 넣은 문자열을 출력하지 않는다", () => {
    expect(safeServerError({ name: "AI_NoObjectGeneratedError", cause: { name: "synthetic-private" }, finishReason: "synthetic-private", usage: { inputTokens: "synthetic-private", outputTokens: Infinity } })).toEqual({ code: "ai_invalid_output" });
  });
  it("진단 속성의 getter가 실패해도 오류 내용을 출력하지 않는다", () => {
    expect(safeServerError({ name: "AI_NoObjectGeneratedError", get cause() { throw new Error("synthetic-private"); } })).toEqual({ code: "ai_invalid_output" });
    expect(safeServerError(new Proxy({}, { get() { throw new Error("synthetic-private"); } }))).toEqual({ code: "operation_failed" });
  });
});

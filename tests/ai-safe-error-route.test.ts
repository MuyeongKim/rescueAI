import { afterEach, describe, expect, it, vi } from "vitest";
import { format } from "node:util";
import { generateObject } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import { z } from "zod";
import { safeServerError } from "@/lib/safe-server-error";

const mocks = vi.hoisted(() => ({ getChatModel: vi.fn() }));
vi.mock("@/lib/demo", () => ({ DEMO: false }));
vi.mock("@/lib/auth", () => ({ requireApiUser: async () => ({ ok: true, user: { id: "synthetic-user" } }) }));
vi.mock("@/lib/ai-usage", () => ({ guardAiUsage: async () => null }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => ({ ok: true }), tooManyRequests: vi.fn() }));
vi.mock("@/lib/llm", () => ({ getChatModel: mocks.getChatModel }));
vi.mock("@/lib/generate-context", () => ({ fetchCategoryContext: async () => ({
  contextText: "[합성 교육자료 p.1]\n합성 점검 원문", sources: [{ document_id: 1, doc: "합성 교육자료", page: 1 }],
  bindingSources: [{ document_id: 1, doc: "합성 교육자료", page: 1 }], degraded: false,
  sopEvidence: { status: "not_found", sourceLabels: [] },
}) }));
import { POST } from "@/app/api/generate/route";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("AI 오류 원문 로그 차단", () => {
  it("실제 SDK의 스키마 오류에 포함된 본문이 생성 API 로그나 사용자 오류 응답으로 나오지 않는다", async () => {
    const marker = "SYNTHETIC_PRIVATE_DOCUMENT_4829";
    const network = vi.fn(() => { throw new Error("No network allowed"); });
    vi.stubGlobal("fetch", network);
    const model = new MockLanguageModelV2({ doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify({ leakedBody: marker }) }], finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [],
    }) });
    let sdkError: unknown;
    try { await generateObject({ model, schema: z.object({ title: z.string() }), prompt: "합성 질문", maxRetries: 0 }); }
    catch (error) { sdkError = error; }
    expect(format(sdkError)).toContain(marker); // 기존 원시 로그의 노출을 먼저 재현한다.
    expect(safeServerError(sdkError)).toEqual({
      code: "ai_invalid_output", reason: "schema_validation_failed", finishReason: "stop", inputTokens: 1, outputTokens: 1,
    });
    mocks.getChatModel.mockReturnValue(model);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await POST(new Request("http://localhost/api/generate", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        type: "plan", category: "화재", audience: "일반 대원", duration: "1시간", topic: "장비 점검", model: "gemini-flash",
      }),
    }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "문서 생성 중 오류가 발생했습니다." });
    expect(errorLog).toHaveBeenCalledWith("[generate] 실패:", {
      code: "ai_invalid_output", reason: "schema_validation_failed", finishReason: "stop", inputTokens: 1, outputTokens: 1,
    });
    expect(format(errorLog.mock.calls, warnLog.mock.calls)).not.toContain(marker);
    expect(network).not.toHaveBeenCalled();
  });

  it("name, code, message, cause와 임의 속성은 로그 필드로 복사하지 않는다", () => {
    const marker = "SYNTHETIC_SECRET_TOKEN";
    expect(safeServerError({ name: marker, code: marker, message: marker, statusCode: 429,
      responseBody: marker, requestBodyValues: { token: marker }, cause: new Error(marker),
    })).toEqual({ code: "operation_failed", status: 429 });
    expect(safeServerError(new Proxy({}, { get() { throw new Error(marker); } }))).toEqual({ code: "operation_failed" });
    expect(safeServerError({ status: marker })).toEqual({ code: "operation_failed" });
  });
});

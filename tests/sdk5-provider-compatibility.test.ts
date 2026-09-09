import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { getChatModel } from "@/lib/llm";
import { getQueryEmbedding } from "@/lib/embeddings";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "synthetic-google-key");
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-anthropic-key");
  vi.stubEnv("LLM_API_URL", "https://synthetic-glm.invalid/v1");
  vi.stubEnv("LLM_API_KEY", "synthetic-glm-key");
});

describe("SDK 5 실제 provider의 기존 요청 계약 (HTTP 응답만 합성)", () => {
  it("GLM 모델은 기존 Chat Completions 주소와 thinking 보정을 유지한다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: "synthetic", object: "chat.completion", created: 1, model: "glm-5.3",
      choices: [{ index: 0, message: { role: "assistant", content: "합성 답변" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateText({ model: getChatModel("glm"), prompt: "합성 질문", maxOutputTokens: 20, maxRetries: 0 });
    expect(result.text).toBe("합성 답변");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://synthetic-glm.invalid/v1/chat/completions");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ model: "glm-5.3", max_tokens: 20, thinking: { type: "enabled" }, reasoning_effort: "low" });
  });

  it("Gemini 구조 생성은 기존 모델명·JSON 응답과 출력 상한을 유지한다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ candidates: [{ content: { role: "model", parts: [{ text: '{"title":"합성 문서"}' }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateObject({ model: getChatModel("gemini-flash"), prompt: "합성 문서", schema: z.object({ title: z.string() }), maxOutputTokens: 20, maxRetries: 0 });
    expect(result.object).toEqual({ title: "합성 문서" });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/models/gemini-flash-latest:generateContent");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).generationConfig).toMatchObject({ maxOutputTokens: 20, responseMimeType: "application/json" });
  });

  it("Anthropic은 기존 Messages 주소·모델과 출력 상한을 유지한다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: "synthetic", type: "message", role: "assistant", model: "claude-sonnet-4-5",
      content: [{ type: "text", text: "합성 답변" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
    }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await generateText({ model: getChatModel("claude-sonnet-4-5"), prompt: "합성 질문", maxOutputTokens: 20, maxRetries: 0 })).text).toBe("합성 답변");
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.anthropic.com/v1/messages");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ model: "claude-sonnet-4-5", max_tokens: 20 });
  });

  it("Gemini 임베딩의 1024차원·RETRIEVAL_QUERY 계약을 HTTP 본문까지 유지한다", async () => {
    vi.stubEnv("EMBEDDING_PROVIDER", "google");
    const vector = Array(1024).fill(0.01);
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ embedding: { values: vector } }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getQueryEmbedding("합성 검색 질문")).toEqual(vector);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/models/gemini-embedding-001:embedContent");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ outputDimensionality: 1024, taskType: "RETRIEVAL_QUERY" });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "@ai-sdk/react";
import { MockLanguageModelV2 } from "ai/test";
import { createTutorChatTransport } from "@/lib/chat-transport";
import { fromTutorUIMessage, toTutorUIMessage, type TutorUIMessage } from "@/lib/chat-message";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), getChatModel: vi.fn(), review: vi.fn() }));
vi.mock("@/lib/demo", () => ({ DEMO: false }));
vi.mock("@/lib/auth", () => ({ requireApiUser: async () => ({ ok: true, user: { id: "synthetic-user" } }) }));
vi.mock("@/lib/ai-usage", () => ({ guardAiUsage: async () => null }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => ({ ok: true }), tooManyRequests: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/llm", () => ({ getChatModel: mocks.getChatModel }));
vi.mock("@/lib/chat-query-expansion", () => ({ expandChatQuery: async () => ({ retrievalQuestion: "합성 점검 질문", expansion: { embedText: "합성", keywords: [] }, method: "disabled" }) }));
vi.mock("@/lib/chat-learning-review", () => ({ reviewChatLearningAnswer: mocks.review }));
vi.mock("@/lib/rag", () => ({ searchContext: async () => ({ contextText: "합성 원문", matched: 1,
  sources: [{ document_id: 1, doc: "합성 교육자료", page: 2 }], degraded: true,
}), buildSystemPrompt: () => "합성 시스템 지침", NOT_FOUND_MESSAGE: "확인되지 않습니다" }));
import { POST } from "@/app/api/chat/route";

const requestId = "10000000-0000-4000-8000-000000000001";
const question = "화학보호복 착용 절차를 알려줘";
type Row = Record<string, unknown>;
let rows: Record<string, Row[]>;
let failAssistant: boolean;
let requests: Row[];

function database() {
  return { from(table: string) {
    let insert: Row | undefined;
    const filters: Array<[string, unknown]> = [];
    const execute = () => {
      const target = rows[table];
      if (insert) {
        if (table === "messages" && insert.role === "assistant" && failAssistant) return { data: null, error: { message: "synthetic storage error" } };
        const row = { id: target.length + 1, ...insert }; target.push(row);
        return { data: row, error: null };
      }
      return { data: target.find((row) => filters.every(([key, value]) => row[key] === value)) ?? null, error: null };
    };
    const query = { select: () => query, eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
      insert: (row: Row) => { insert = row; return query; }, single: async () => execute(), maybeSingle: async () => execute(),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(execute()).then(resolve),
    };
    return query;
  } };
}

function modelStream(opts: { gate?: Promise<void>; error?: Error } = {}) {
  return new MockLanguageModelV2({ doStream: async () => ({ stream: new ReadableStream({
    async start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "text-start", id: "synthetic-text" });
      controller.enqueue({ type: "text-delta", id: "synthetic-text", delta: "합성 답변 앞부분. " });
      if (opts.gate) await opts.gate;
      if (opts.error) controller.enqueue({ type: "error", error: opts.error });
      else {
        controller.enqueue({ type: "text-delta", id: "synthetic-text", delta: "뒷부분." });
        controller.enqueue({ type: "text-end", id: "synthetic-text" });
        controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
      }
      controller.close();
    },
  }) }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  rows = { conversations: [], messages: [] }; failAssistant = false; requests = [];
  mocks.createClient.mockResolvedValue(database());
  mocks.getChatModel.mockReturnValue(modelStream());
  mocks.review.mockResolvedValue({ status: "unverified", text: "", checks: 1 });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("/api/chat"); // 외부 모델/서버 요청이면 즉시 실패한다.
    requests.push(JSON.parse(String(init?.body)));
    const response = await POST(new Request("http://localhost/api/chat", init));
    // 실제 브라우저 fetch처럼 AbortSignal이 수신 스트림을 취소하도록 연결한다.
    return new Response(response.body?.pipeThrough(new TransformStream(), { signal: init?.signal ?? undefined }), response);
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("실제 SDK 5 Chat·SSE·API 계약 (모델과 DB는 합성)", () => {
  it("본문·출처·저장 식별자·검색 장애 표시와 복구 주소를 전달하고 같은 질문 재시도는 질문을 중복 저장하지 않는다", async () => {
    const onData = vi.fn();
    const chat = new Chat<TutorUIMessage>({ transport: createTutorChatTransport(), onData });
    await chat.sendMessage({ text: question }, { body: { clientRequestId: requestId, model: "gemini-flash" } });
    expect(chat.status).toBe("ready");
    const answer = fromTutorUIMessage(chat.messages.at(-1)!);
    expect(answer.content).toBe("합성 답변 앞부분. 뒷부분.");
    expect(answer.annotations?.[0]).toMatchObject({ messageId: 2, conversationId: requestId, degraded: true, saveFailed: false,
      sources: [{ document_id: 1, doc: "합성 교육자료", page: 2 }],
    });
    expect(onData).toHaveBeenCalledWith(expect.objectContaining({ type: "data-conversationId", data: { value: requestId }, transient: true }));
    expect(requests[0]).toMatchObject({ clientRequestId: requestId, model: "gemini-flash", messages: [{ role: "user", content: question }] });
    await chat.regenerate({ body: { clientRequestId: requestId, conversationId: requestId } });
    expect(chat.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(rows.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(rows.messages.filter((message) => message.role === "assistant")).toHaveLength(2);
  });

  it("브라우저 중지 이후에도 서버는 남은 답변을 저장한다", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mocks.getChatModel.mockReturnValue(modelStream({ gate }));
    const chat = new Chat<TutorUIMessage>({ transport: createTutorChatTransport() });
    const sending = chat.sendMessage({ text: question }, { body: { clientRequestId: requestId } });
    await vi.waitFor(() => expect(chat.messages.at(-1)?.parts).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: "합성 답변 앞부분. " })])));
    await chat.stop(); release(); await sending;
    await vi.waitFor(() => expect(rows.messages.find((message) => message.role === "assistant")?.content).toBe("합성 답변 앞부분. 뒷부분."));
    expect(rows.messages.filter((message) => message.role === "user")).toHaveLength(1);
  });

  it("중간 SDK 오류는 부분 답변을 완성본으로 저장하지 않고 비밀값 없는 오류 상태로 끝낸다", async () => {
    const marker = "SYNTHETIC_PROVIDER_SECRET";
    mocks.getChatModel.mockReturnValue(modelStream({ error: new Error(marker) }));
    const onError = vi.fn();
    const chat = new Chat<TutorUIMessage>({ transport: createTutorChatTransport(), onError });
    await chat.sendMessage({ text: question }, { body: { clientRequestId: requestId } });
    expect(chat.status).toBe("error");
    expect(onError).toHaveBeenCalledOnce();
    expect(chat.error?.message).not.toContain(marker);
    expect(JSON.stringify(chat.messages)).not.toContain(marker);
    expect(rows.messages.filter((message) => message.role === "assistant")).toHaveLength(0);
    expect(rows.messages.filter((message) => message.role === "user")).toHaveLength(1);
  });

  it("저장 실패는 본문을 유지하면서 saveFailed 메타데이터로 전달한다", async () => {
    failAssistant = true;
    const chat = new Chat<TutorUIMessage>({ transport: createTutorChatTransport() });
    await chat.sendMessage({ text: question }, { body: { clientRequestId: requestId } });
    expect(chat.status).toBe("ready");
    expect(fromTutorUIMessage(chat.messages.at(-1)!).annotations?.[0]).toMatchObject({ saveFailed: true, messageId: null });
  });

  it("학습 답변은 검토 실패한 초안을 SSE로 노출하지 않는다", async () => {
    const marker = "SYNTHETIC_UNREVIEWED_DRAFT";
    mocks.getChatModel.mockReturnValue(new MockLanguageModelV2({ doGenerate: async () => ({
      content: [{ type: "text", text: marker }], finishReason: "stop", warnings: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }) }));
    const chat = new Chat<TutorUIMessage>({ transport: createTutorChatTransport() });
    await chat.sendMessage({ text: "인명구조사 2급을 준비하려고 하는데 무엇부터 시작해야하지?" }, { body: { clientRequestId: requestId } });
    expect(mocks.review).toHaveBeenCalledOnce();
    expect(JSON.stringify(chat.messages)).not.toContain(marker);
    expect(JSON.stringify(rows.messages)).not.toContain(marker);
  });

  it("기존 DB 메시지의 날짜·출처·평가와 요청 ID는 UIMessage 변환을 왕복해 유지된다", () => {
    const saved = { id: "1", role: "assistant" as const, content: "저장된 답변", createdAt: new Date("2026-09-09T00:00:00Z"),
      annotations: [{ messageId: 1, feedback: -1, degraded: true, clientRequestId: requestId }],
    };
    expect(fromTutorUIMessage(toTutorUIMessage(saved))).toMatchObject(saved);
  });
});

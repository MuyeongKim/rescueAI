import { beforeEach, describe, expect, it, vi } from "vitest";
import { guardAiUsage } from "@/lib/ai-usage";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(), requireApiUser: vi.fn(), rateLimit: vi.fn(), searchContext: vi.fn(),
  buildSystemPrompt: vi.fn(() => "test-system"),
  generateText: vi.fn(), reviewChatLearningAnswer: vi.fn(),
  streamText: vi.fn(), finishes: [] as Promise<unknown>[],
}));
vi.mock("@/lib/ai-usage", () => ({ guardAiUsage: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/auth", () => ({ requireApiUser: mocks.requireApiUser }));
vi.mock("@/lib/demo", () => ({ DEMO: false }));
vi.mock("@/lib/llm", () => ({ getChatModel: () => "test-model" }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
  tooManyRequests: () => new Response("too many requests", { status: 429 }),
}));
vi.mock("@/lib/rag", () => ({
  searchContext: mocks.searchContext,
  buildSystemPrompt: mocks.buildSystemPrompt,
  NOT_FOUND_MESSAGE: "확인되지 않습니다",
}));
vi.mock("@/lib/chat-query-expansion", () => ({
  expandChatQuery: async (messages: { role: string; content: string }[]) => {
    const query = buildRetrievalQuestion(messages);
    return { retrievalQuestion: query, expansion: { embedText: query, keywords: [] }, method: "disabled" };
  },
}));
vi.mock("@/lib/chat-learning-review", () => ({ reviewChatLearningAnswer: mocks.reviewChatLearningAnswer }));
vi.mock("ai", () => ({
  generateText: mocks.generateText,
  convertToCoreMessages: (messages: unknown) => messages,
  streamText: mocks.streamText,
  formatDataStreamPart: (_type: string, value: unknown) => value,
  createDataStreamResponse: async ({ execute, onError }: {
    execute: (writer: unknown) => Promise<void>;
    onError: (error: unknown) => string;
  }) => {
    const data: unknown[] = [];
    const annotations: unknown[] = [];
    const text: unknown[] = [];
    try {
      await execute({
        write: (value: unknown) => text.push(value),
        writeData: (value: unknown) => data.push(value),
        writeMessageAnnotation: (value: unknown) => annotations.push(value),
      });
      await Promise.all(mocks.finishes);
      return Response.json({ data, annotations, text });
    } catch (error) {
      return Response.json({ error: onError(error) });
    }
  },
}));

import { POST } from "@/app/api/chat/route";
import { NOT_FOUND_MESSAGE } from "@/lib/rag";
import { buildChatEvidenceFallback } from "@/lib/chat-evidence-fallback";
import { buildRetrievalQuestion } from "@/lib/chat-retrieval-query";

const requestId = "10000000-0000-4000-8000-000000000001";
const otherId = "20000000-0000-4000-8000-000000000002";
const question = "화학보호복 착용 절차를 알려줘";
type Row = Record<string, unknown>;
let conversations: Row[];
let messages: Row[];
let failLookup: boolean;
let raceUserInsert: boolean;
let failAssistantInsert: boolean;
let answerText: string;

function database() {
  return { from(table: string) {
    const filters: [string, unknown][] = [];
    let insert: Row | undefined;
    const execute = () => {
      const rows = table === "conversations" ? conversations : messages;
      if (insert) {
        if (table === "messages" && insert.role === "assistant" && failAssistantInsert) {
          return { data: null, error: { code: "XX000", message: "storage unavailable" } };
        }
        if (table === "messages" && insert.role === "user" && raceUserInsert) {
          raceUserInsert = false;
          messages.push({ ...insert, id: 101 });
          return { data: null, error: { code: "23505", message: "conflict" } };
        }
        const collision = rows.some(row => table === "conversations"
          ? row.id === insert?.id
          : insert?.client_request_id && row.client_request_id === insert.client_request_id);
        if (collision) return { data: null, error: { code: "23505", message: "conflict" } };
        const row = { id: rows.length + 1, ...insert };
        rows.push(row);
        return { data: row, error: null };
      }
      if (table === "messages" && failLookup) {
        return { data: null, error: { message: "column client_request_id does not exist" } };
      }
      const data = rows.find(row => {
        const own = table === "conversations" ? row.user_id === "user-1"
          : conversations.some(conv => conv.id === row.conversation_id && conv.user_id === "user-1");
        return own && filters.every(([key, value]) => row[key] === value);
      });
      return { data: data ?? null, error: null };
    };
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
      insert: (value: Row) => { insert = value; return query; },
      maybeSingle: async () => execute(),
      single: async () => execute(),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(execute()).then(resolve),
    };
    return query;
  } };
}

function request(body: Row = {}) {
  return new Request("http://localhost/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: question }], clientRequestId: requestId, ...body }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  conversations = []; messages = []; failLookup = false; raceUserInsert = false; failAssistantInsert = false;
  answerText = "**점검** 후 착용합니다.";
  mocks.finishes.length = 0;
  mocks.generateText.mockImplementation(async () => ({ text: answerText }));
  mocks.reviewChatLearningAnswer.mockImplementation(async (text) => ({ text, status: "verified", checks: 1 }));
  mocks.createClient.mockResolvedValue(database());
  mocks.requireApiUser.mockResolvedValue({ ok: true, user: { id: "user-1" } });
  mocks.rateLimit.mockReturnValue({ ok: true });
  mocks.searchContext.mockResolvedValue({ contextText: "근거", sources: [], degraded: true });
  mocks.streamText.mockImplementation(({ onFinish }) => ({
    consumeStream: () => {
      const finish = onFinish({ text: answerText });
      mocks.finishes.push(finish);
      return finish;
    },
    mergeIntoDataStream: () => undefined,
  }));
});

describe("튜터 오류 복구와 저장 경계", () => {
  it("분산 예산 거절 시 저장·검색·모델 호출을 시작하지 않는다", async () => {
    vi.mocked(guardAiUsage).mockResolvedValueOnce(new Response(null, { status: 429 }));
    expect((await POST(request())).status).toBe(429);
    expect(messages).toHaveLength(0); expect(mocks.searchContext).not.toHaveBeenCalled();
    expect(mocks.streamText).not.toHaveBeenCalled();
  });
  it("출력 상한과 마감 시간을 지정하면서 한국어 장문 답변의 백그라운드 저장을 유지한다", async () => {
    answerText = "대원은 장비를 확인하고 동료와 점검 결과를 공유합니다.\n".repeat(70);
    await POST(request());
    await Promise.all(mocks.finishes);
    expect(mocks.streamText).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 4_000, maxRetries: 0, abortSignal: expect.any(AbortSignal) }));
    expect(messages.find(row => row.role === "assistant")?.content).toBe(answerText);
  });
  it("인증 실패에는 저장·검색·모델 호출이 없다", async () => {
    mocks.requireApiUser.mockResolvedValue({ ok: false, response: new Response("login", { status: 401 }) });
    expect((await POST(request())).status).toBe(401);
    expect(messages).toHaveLength(0);
    expect(mocks.searchContext).not.toHaveBeenCalled();
  });

  it("첫 요청을 재시도해도 대화와 질문이 하나만 남고 degraded가 저장된다", async () => {
    const first = await POST(request());
    expect(first.status).toBe(200);
    expect((await first.json()).annotations[0]).toMatchObject({ degraded: true, saveFailed: false });
    await POST(request());
    expect(conversations).toHaveLength(1);
    expect(messages.filter(row => row.role === "user")).toHaveLength(1);
    expect(messages.find(row => row.role === "assistant")).toMatchObject({ retrieval_degraded: true });
  });

  it("질문 저장의 동시 충돌에서는 본인 기존 행만 재사용한다", async () => {
    raceUserInsert = true;
    expect((await POST(request())).status).toBe(200);
    expect(messages.filter(row => row.role === "user")).toHaveLength(1);
  });

  it("동일 키로 질문이나 대화 ID를 바꿀 수 없다", async () => {
    await POST(request());
    mocks.searchContext.mockClear();
    expect((await POST(request({ messages: [{ role: "user", content: "바꾼 질문" }] }))).status).toBe(409);
    expect((await POST(request({ conversationId: otherId }))).status).toBe(409);
    expect(mocks.searchContext).not.toHaveBeenCalled();
  });

  it("타인 요청 키 충돌은 대화 ID·질문을 노출하지 않고 검색 전에 종료한다", async () => {
    conversations.push({ id: requestId, user_id: "other-user", title: "비공개" });
    messages.push({ conversation_id: requestId, role: "user", content: "비공개 질문", client_request_id: requestId });
    const response = await POST(request());
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(text).not.toContain(requestId);
    expect(text).not.toContain("비공개");
    expect(mocks.searchContext).not.toHaveBeenCalled();
  });

  it("타인의 대화 ID를 지정하면 쓰기·검색 전에 거부한다", async () => {
    conversations.push({ id: otherId, user_id: "other-user" });
    expect((await POST(request({ conversationId: otherId }))).status).toBe(404);
    expect(messages).toHaveLength(0);
    expect(mocks.searchContext).not.toHaveBeenCalled();
  });

  it("복구용 컬럼이 없는 배포에서도 저장됐다고 알리지 않는다", async () => {
    failLookup = true;
    expect((await POST(request())).status).toBe(503);
    expect(mocks.streamText).not.toHaveBeenCalled();
  });

  it("답변 저장 실패는 화면에 전달하고 피드백용 ID를 만들지 않는다", async () => {
    failAssistantInsert = true;
    const payload = await (await POST(request())).json();
    expect(payload.annotations[0]).toMatchObject({ messageId: null, saveFailed: true });
    expect(messages.filter(row => row.role === "assistant")).toHaveLength(0);
  });

  it("검색 본문이 비어 있으면 다음 질문을 안내하고 복구 주소를 유지한다", async () => {
    mocks.searchContext.mockResolvedValue({ contextText: " \n\t", sources: [], matched: 0, degraded: false });

    const payload = await (await POST(request())).json();

    expect(mocks.streamText).not.toHaveBeenCalled();
    expect(mocks.buildSystemPrompt).not.toHaveBeenCalled();
    expect(payload.text).toEqual([buildChatEvidenceFallback("empty")]);
    expect(payload.data).toEqual([{ type: "conversationId", value: requestId }]);
    expect(payload.annotations).toEqual([{
      messageId: expect.any(Number), conversationId: requestId, sources: [], degraded: false, saveFailed: false,
    }]);
    expect(messages.filter(row => row.role === "assistant")).toEqual([expect.objectContaining({
      conversation_id: requestId, content: buildChatEvidenceFallback("empty"), sources: null, retrieval_degraded: false,
    })]);
    expect(messages.filter(row => row.role === "user")).toHaveLength(1);
  });

  it("빈 검색과 답변 저장 장애가 겹쳐도 모델 호출 없이 두 장애 상태를 각각 전달한다", async () => {
    failAssistantInsert = true;
    mocks.searchContext.mockResolvedValue({
      contextText: "", matched: 0, degraded: true,
      sources: [{ document_id: 1, doc: "본문 없는 후보", page: 3, content: "" }],
    });

    const payload = await (await POST(request())).json();

    expect(mocks.streamText).not.toHaveBeenCalled();
    expect(payload.text).toEqual([buildChatEvidenceFallback("degraded")]);
    expect(payload.data).toEqual([{ type: "conversationId", value: requestId }]);
    expect(payload.annotations).toEqual([{
      messageId: null, conversationId: requestId, sources: [], degraded: true, saveFailed: true,
    }]);
    expect(messages.filter(row => row.role === "assistant")).toHaveLength(0);
    expect(messages.filter(row => row.role === "user")).toHaveLength(1);
  });

  it("검색 예외는 정상적인 자료 없음으로 저장하지 않고 degraded 응답을 보존한다", async () => {
    mocks.searchContext.mockRejectedValue(new Error("retrieval unavailable"));

    const payload = await (await POST(request())).json();

    expect(mocks.streamText).not.toHaveBeenCalled();
    expect(payload.text).toEqual([buildChatEvidenceFallback("degraded")]);
    expect(payload.annotations[0]).toMatchObject({ degraded: true, saveFailed: false, sources: [] });
    expect(messages.find(row => row.role === "assistant")).toMatchObject({
      content: buildChatEvidenceFallback("degraded"), retrieval_degraded: true,
    });
  });

  it("전체가 근거 없음 답변이면 검색됐던 무관한 자료를 저장·표시하지 않는다", async () => {
    answerText = `\n ${NOT_FOUND_MESSAGE.replace(/ /g, "\n")} \n`;
    mocks.searchContext.mockResolvedValue({
      contextText: "질문과 무관한 자료", degraded: false,
      sources: [{ document_id: 1, doc: "무관한 자료", page: 3, content: "다른 상황" }],
    });

    const payload = await (await POST(request())).json();

    expect(payload.annotations[0].sources).toEqual([]);
    expect(messages.find(row => row.role === "assistant")?.sources).toBeNull();
  });

  it("부분 근거를 설명하고 미확인 범위를 밝힌 답변의 자료는 저장·표시한다", async () => {
    answerText = `**확인된 범위**\n개별 조건의 자료는 있습니다.\n\n전체 조건의 전용 절차는 ${NOT_FOUND_MESSAGE}`;
    const source = { document_id: 54, doc: "개별 조건 자료", page: 269, content: "적용 조건과 예외" };
    mocks.searchContext.mockResolvedValue({ contextText: "개별 조건의 근거", sources: [source, source], degraded: false });

    const payload = await (await POST(request())).json();

    expect(mocks.streamText).toHaveBeenCalledOnce();
    expect(payload.text).toEqual([]); // 일부 근거가 있는 응답은 표준 거절문으로 교체하지 않는다.
    expect(payload.annotations[0].sources).toEqual([source]);
    expect(messages.find(row => row.role === "assistant")).toMatchObject({
      content: expect.stringContaining("전체 조건의 전용 절차"), sources: [source],
    });
  });

  it("검색에서 검출한 복합 조건을 답변 프롬프트 구성에 전달한다", async () => {
    const topics = ["관통상 관련 개별 근거", "매달린 요구조자 관련 개별 근거"];
    const coverage = { requested: topics, missing: [topics[1]], supplementalQueries: 1 };
    mocks.searchContext.mockResolvedValue({
      contextText: "개별 조건 자료", sources: [], independentEvidenceTopics: topics, retrievalCoverage: coverage,
    });

    await POST(request());

    expect(mocks.buildSystemPrompt).toHaveBeenCalledWith("개별 조건 자료", expect.any(String), topics, coverage, { learningAdvice: false, retrievalQuestion: question });
  });
});


describe("튜터 질문 유형과 실제 대화 흐름", () => {
  it.each([
    "너는 생각이 없니?",
    "너는 딱 RAG된 자료에서만 답변을 하는구나?",
    "파생되는 질문에 대한 답변을 못하는군",
  ])("기능·불만 발언에는 검색/모델 없이 답하고 대화에 저장한다: %s", async (content) => {
    const payload = await (await POST(request({ messages: [
      { role: "user", content: "인명구조사 2급을 준비하려고 하는데 무엇부터 시작해야하지?" },
      { role: "assistant", content: "평가 항목을 안내했습니다." },
      { role: "user", content },
    ] }))).json();
    expect(mocks.searchContext).not.toHaveBeenCalled();
    expect(mocks.streamText).not.toHaveBeenCalled();
    expect(payload.text.join("")).not.toContain(NOT_FOUND_MESSAGE);
    expect(payload.text.join("").length).toBeGreaterThan(40);
    expect(payload.annotations[0]).toMatchObject({ sources: [], degraded: false, saveFailed: false });
    expect(messages.find(row => row.role === "assistant")?.content).toBe(payload.text.join(""));
  });

  it("준비 우선순위를 이전 평가 주제로 검색하고 학습 조언 프롬프트를 사용한다", async () => {
    const current = "너라면 구조기술평가 중에 어느것 부터 준비할래?";
    await POST(request({ messages: [
      { role: "user", content: "인명구조사 2급을 준비하려고 하는데 무엇부터 시작해야하지?" },
      { role: "assistant", content: "평가 항목" },
      { role: "user", content: current },
    ] }));
    expect(mocks.searchContext.mock.calls[0][0]).toContain("인명구조사 2급");
    expect(mocks.buildSystemPrompt.mock.calls[0][4]).toMatchObject({ learningAdvice: true });
    expect(mocks.generateText).toHaveBeenCalledOnce();
    expect(mocks.reviewChatLearningAnswer).toHaveBeenCalledOnce();
    expect(mocks.streamText).not.toHaveBeenCalled();
  });

  it("메타 발언에 섞인 기술 질문은 검색과 근거 제한을 우회하지 않는다", async () => {
    await POST(request({ messages: [{ role: "user", content: "너는 RAG 자료에서만 답하니? 로프 허용하중을 자료 없이 알려줘" }] }));
    expect(mocks.searchContext).toHaveBeenCalledOnce();
    expect(mocks.buildSystemPrompt.mock.calls[0][4]).toMatchObject({ learningAdvice: false });
  });

  it("새 로프 학습 주제는 이전 자격 등급을 섞지 않는다", async () => {
    await POST(request({ messages: [
      { role: "user", content: "인명구조사 2급 평가 항목은?" },
      { role: "user", content: "너는 생각이 없니?" },
      { role: "user", content: "로프기술중에 가장 알아야할 부분이 어떤게 있어?" },
    ] }));
    expect(mocks.searchContext.mock.calls[0][0]).not.toContain("2급");
    expect(mocks.searchContext.mock.calls[0][0]).toContain("로프");
    expect(mocks.buildSystemPrompt.mock.calls[0][4]).toMatchObject({ learningAdvice: true });
  });

  it("모델 전체 거절에는 재질문 안내를 덧붙이고 화면과 같은 본문을 저장한다", async () => {
    answerText = NOT_FOUND_MESSAGE;
    const payload = await (await POST(request())).json();
    const tail = `\n\n${buildChatEvidenceFallback("degraded")}`;
    expect(payload.text).toEqual([tail]);
    expect(messages.find(row => row.role === "assistant")?.content).toBe(NOT_FOUND_MESSAGE + tail);
    expect(payload.annotations[0].sources).toEqual([]);
  });
});


describe("학습 답변 공개 전 원문 검토", () => {
  const learningRequest = () => request({ messages: [{ role: "user", content: "로프기술중에 가장 알아야할 부분이 어떤게 있어?" }] });
  it("교정본만 화면과 대화에 같은 내용으로 남긴다", async () => {
    answerText = "초안의 잘못된 장비명";
    mocks.reviewChatLearningAnswer.mockResolvedValue({ text: "원문에서 확인한 항목과 학습 순서", status: "corrected", checks: 2 });
    const payload = await (await POST(learningRequest())).json();
    expect(payload.text).toEqual(["원문에서 확인한 항목과 학습 순서"]);
    expect(messages.find(row => row.role === "assistant")?.content).toBe(payload.text[0]);
    expect(payload.text.join("")).not.toContain("잘못된 장비명");
  });
  it("검토 실패에는 초안을 노출하거나 근거 확인 성공으로 저장하지 않는다", async () => {
    answerText = "아직 검토되지 않은 초안";
    mocks.reviewChatLearningAnswer.mockResolvedValue({ text: "", status: "unverified", checks: 1 });
    const payload = await (await POST(learningRequest())).json();
    expect(payload.text).toEqual([buildChatEvidenceFallback("review_failed")]);
    expect(payload.annotations[0].sources).toEqual([]);
    expect(messages.find(row => row.role === "assistant")?.content).toBe(payload.text[0]);
  });
});

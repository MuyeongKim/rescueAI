import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(), requireApiUser: vi.fn(), rateLimit: vi.fn(), searchContext: vi.fn(),
  streamText: vi.fn(), finishes: [] as Promise<unknown>[],
}));
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
  buildSystemPrompt: () => "test-system",
  NOT_FOUND_MESSAGE: "확인되지 않습니다",
}));
vi.mock("ai", () => ({
  convertToCoreMessages: (messages: unknown) => messages,
  streamText: mocks.streamText,
  formatDataStreamPart: (_type: string, value: unknown) => value,
  createDataStreamResponse: async ({ execute, onError }: {
    execute: (writer: unknown) => Promise<void>;
    onError: (error: unknown) => string;
  }) => {
    const data: unknown[] = [];
    const annotations: unknown[] = [];
    try {
      await execute({
        writeData: (value: unknown) => data.push(value),
        writeMessageAnnotation: (value: unknown) => annotations.push(value),
      });
      await Promise.all(mocks.finishes);
      return Response.json({ data, annotations });
    } catch (error) {
      return Response.json({ error: onError(error) });
    }
  },
}));

import { POST } from "@/app/api/chat/route";

const requestId = "10000000-0000-4000-8000-000000000001";
const otherId = "20000000-0000-4000-8000-000000000002";
const question = "화학보호복 착용 절차를 알려줘";
type Row = Record<string, unknown>;
let conversations: Row[];
let messages: Row[];
let failLookup: boolean;
let raceUserInsert: boolean;
let failAssistantInsert: boolean;

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
  mocks.finishes.length = 0;
  mocks.createClient.mockResolvedValue(database());
  mocks.requireApiUser.mockResolvedValue({ ok: true, user: { id: "user-1" } });
  mocks.rateLimit.mockReturnValue({ ok: true });
  mocks.searchContext.mockResolvedValue({ contextText: "근거", sources: [], degraded: true });
  mocks.streamText.mockImplementation(({ onFinish }) => ({
    consumeStream: () => {
      const finish = onFinish({ text: "**점검** 후 착용합니다." });
      mocks.finishes.push(finish);
      return finish;
    },
    mergeIntoDataStream: () => undefined,
  }));
});

describe("튜터 오류 복구와 저장 경계", () => {
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
});

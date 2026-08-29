import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  requireApiUser: vi.fn(),
  rateLimit: vi.fn(),
  tooManyRequests: vi.fn(),
  fetchCategoryContext: vi.fn(),
  generateObject: vi.fn(),
  getChatModel: vi.fn(),
}));

vi.mock("@/lib/demo", () => ({ DEMO: false }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/auth", () => ({ requireApiUser: mocks.requireApiUser }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
  tooManyRequests: mocks.tooManyRequests,
}));
vi.mock("@/lib/generate-context", () => ({
  fetchCategoryContext: mocks.fetchCategoryContext,
}));
vi.mock("ai", () => ({ generateObject: mocks.generateObject }));
vi.mock("@/lib/llm", () => ({ getChatModel: mocks.getChatModel }));

import { POST } from "@/app/api/generate/focus/route";

function requestWith(body: unknown): Request {
  return new Request("http://localhost/api/generate/focus", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function makeClient(rows: unknown[] = []) {
  const eqs: Array<[string, unknown]> = [];
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((column: string, value: unknown) => {
      eqs.push([column, value]);
      return builder;
    }),
    in: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn().mockResolvedValue({ data: rows, error: null }),
  };
  return { from: vi.fn(() => builder), eqs };
}

const context = {
  contextText:
    "[산악구조 교범 p.12]\n수색 구역을 나누고 조난자 위치를 확인한다.\n\n---\n\n" +
    "[로프구조 교범 p.8]\n급경사 접근 전 확보 지점을 확인한다.",
  sources: [],
  bindingSources: [],
  degraded: false,
  sopEvidence: { status: "not_found", sourceLabels: [] },
};

describe("POST /api/generate/focus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({ ok: true, user: { id: "user-1" } });
    mocks.rateLimit.mockReturnValue({ ok: true, retryAfterSec: 0 });
    mocks.tooManyRequests.mockReturnValue(new Response("Too Many Requests", { status: 429 }));
    mocks.createClient.mockResolvedValue(makeClient());
    mocks.fetchCategoryContext.mockResolvedValue(context);
    mocks.getChatModel.mockReturnValue("model");
    mocks.generateObject.mockResolvedValue({
      object: {
        options: [
          {
            title: "조난자 수색구역 설정과 위치 확인",
            description: "수색 구역을 나누고 위치정보 공유와 보고를 반복 실습합니다.",
            sourceRefs: ["[산악구조 교범 p.12]"],
          },
          {
            title: "급경사 로프 접근과 확보",
            description: "급경사 접근 전 확보 지점과 대원 역할을 확인합니다.",
            sourceRefs: ["[로프구조 교범 p.8]"],
          },
        ],
      },
    });
  });

  it("인증 실패는 잘못된 JSON을 파싱하기 전에 반환한다", async () => {
    mocks.requireApiUser.mockResolvedValue({
      ok: false,
      response: new Response("Unauthorized", { status: 401 }),
    });

    const response = await POST(requestWith("{"));

    expect(response.status).toBe(401);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it("레이트리밋은 본문 파싱 전에 적용한다", async () => {
    mocks.rateLimit.mockReturnValue({ ok: false, retryAfterSec: 7 });

    const response = await POST(requestWith("{"));

    expect(response.status).toBe(429);
    expect(mocks.rateLimit).toHaveBeenCalledWith("generate-focus:user-1", 20, 60_000);
    expect(mocks.tooManyRequests).toHaveBeenCalledWith(7);
  });

  it("구체적인 주제는 추가 LLM 호출 없이 specific으로 통과시킨다", async () => {
    const response = await POST(
      requestWith({ category: "화재", topic: "공기호흡기 착용 방법" })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ scope: "specific", options: [] });
    expect(mocks.fetchCategoryContext).not.toHaveBeenCalled();
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });

  it("넓은 주제는 현재 사용자 저장 이력만 조회하고 근거 있는 방향을 반환한다", async () => {
    const client = makeClient([
      {
        topic: "산악사고대비 훈련",
        focus: "조난자 수색구역 설정과 위치 확인",
      },
    ]);
    mocks.createClient.mockResolvedValue(client);

    const response = await POST(
      requestWith({ category: "산악", topic: "산악사고대비 훈련" })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(client.eqs).toContainEqual(["user_id", "user-1"]);
    expect(client.eqs).toContainEqual(["category", "산악"]);
    const builder = client.from.mock.results[0]?.value;
    expect(builder.select).toHaveBeenCalledWith("topic, focus:content->>focus");
    expect(payload.scope).toBe("broad");
    expect(payload.options.map((option: { title: string }) => option.title)).toEqual([
      "급경사 로프 접근과 확보",
    ]);
    expect(payload.warnings).toContain("연결 자료 범위에서 서로 다른 방향을 4개보다 적게 찾았습니다.");
  });

  it("허용 목록에 없는 출처만 만든 경우 억지로 옵션을 반환하지 않는다", async () => {
    mocks.generateObject.mockResolvedValue({
      object: {
        options: [
          {
            title: "근거 없는 방향",
            description: "연결 자료에 없는 방향을 임의로 설명합니다.",
            sourceRefs: ["[조작한 SOP p.99]"],
          },
        ],
      },
    });

    const response = await POST(
      requestWith({ category: "산악", topic: "산악사고대비 훈련" })
    );

    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain("새 훈련 방향");
  });

  it("연결 근거가 없으면 LLM을 호출하지 않고 422를 반환한다", async () => {
    mocks.fetchCategoryContext.mockResolvedValue({ ...context, contextText: "" });

    const response = await POST(
      requestWith({ category: "산악", topic: "산악사고대비 훈련" })
    );

    expect(response.status).toBe(422);
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });
});

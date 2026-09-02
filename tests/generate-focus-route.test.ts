import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { maxDuration, POST } from "@/app/api/generate/focus/route";

function requestWith(body: unknown, signal?: AbortSignal): Request {
  return new Request("http://localhost/api/generate/focus", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal,
  });
}

function makeClient(rows: unknown[] = [], error: { message: string } | null = null) {
  const eqs: Array<[string, unknown]> = [];
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((column: string, value: unknown) => {
      eqs.push([column, value]);
      return builder;
    }),
    in: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn().mockResolvedValue({ data: rows, error }),
  };
  return { from: vi.fn(() => builder), eqs };
}

const context = {
  contextText:
    "[산악구조 교범 p.12]\n수색 구역을 설정하고 나누어 조난자 위치를 확인한다.\n\n---\n\n" +
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("정밀 모델 시간초과 시 결합된 호출 신호로 빠른 모델을 한 번 재시도한다", async () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    mocks.getChatModel.mockImplementation((key?: string) => key ?? "default");
    mocks.generateObject
      .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"))
      .mockResolvedValueOnce({
        object: {
          options: [
            {
              title: "급경사 로프 접근과 확보",
              description: "급경사 접근 전 확보 지점과 대원 역할을 확인합니다.",
              sourceRefs: ["[로프구조 교범 p.8]"],
            },
          ],
        },
      });

    const response = await POST(
      requestWith({
        category: "산악",
        topic: "산악사고대비 훈련",
        model: "gemini-pro",
      })
    );

    expect(maxDuration).toBe(90);
    expect(response.status).toBe(200);
    expect(mocks.getChatModel.mock.calls.map(([key]) => key)).toEqual([
      "gemini-pro",
      "gemini-flash",
    ]);
    expect(mocks.generateObject).toHaveBeenCalledTimes(2);
    expect(timeoutSpy.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      45_000,
      25_000,
    ]);
    expect(mocks.generateObject.mock.calls[0][0].abortSignal).toBeInstanceOf(AbortSignal);
    expect(mocks.generateObject.mock.calls[1][0].abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("브라우저 요청이 취소되면 정밀 모델 실패 뒤 빠른 모델을 호출하지 않는다", async () => {
    const controller = new AbortController();
    const request = requestWith(
      {
        category: "산악",
        topic: "산악사고대비 훈련",
        model: "gemini-pro",
      },
      controller.signal
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getChatModel.mockImplementation((key?: string) => key ?? "default");
    mocks.generateObject.mockImplementationOnce(({ abortSignal }: { abortSignal: AbortSignal }) => {
      expect(abortSignal.aborted).toBe(false);
      controller.abort();
      expect(abortSignal.aborted).toBe(true);
      return Promise.reject(new DOMException("aborted", "AbortError"));
    });

    const response = await POST(request);

    expect(response.status).toBe(503);
    expect(mocks.generateObject).toHaveBeenCalledOnce();
    expect(mocks.getChatModel).toHaveBeenCalledOnce();
    expect(mocks.getChatModel).toHaveBeenCalledWith("gemini-pro");
  });

  it("빠른 모델도 시간초과하면 플랫폼 종료 전에 구조화된 503을 반환한다", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.generateObject.mockRejectedValueOnce(
      new DOMException("timed out", "TimeoutError")
    );

    const response = await POST(
      requestWith({
        category: "산악",
        topic: "산악사고대비 훈련",
        model: "gemini-flash",
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.error).toContain("시간이 길어");
    expect(mocks.generateObject).toHaveBeenCalledOnce();
    expect(mocks.generateObject.mock.calls[0][0].abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("검색 뒤 남은 내부 예산이 부족하면 모델을 호출하지 않고 503을 반환한다", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.fetchCategoryContext.mockImplementationOnce(async () => {
      now = 71_000;
      return context;
    });

    const response = await POST(
      requestWith({
        category: "산악",
        topic: "산악사고대비 훈련",
        model: "gemini-flash",
      })
    );

    expect(response.status).toBe(503);
    expect(mocks.generateObject).not.toHaveBeenCalled();
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
        id: 91,
        kind: "plan",
        category: "산악",
        topic: "산악사고대비 훈련",
        title: "산악사고 대비 훈련계획",
        focus: "조난자 수색구역 설정과 위치 확인",
        created_at: "2026-08-31T03:00:00.000Z",
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
    expect(builder.select).toHaveBeenCalledWith(
      "id, kind, category, topic, title, created_at, focus:content->>focus"
    );
    expect(builder.in).toHaveBeenCalledWith("kind", ["plan", "lesson", "slides"]);
    expect(payload.scope).toBe("broad");
    expect(payload.options.map((option: { title: string }) => option.title)).toEqual([
      "급경사 로프 접근과 확보",
      "조난자 수색구역 설정과 위치 확인",
    ]);
    expect(
      payload.options.map((option: { historyOverlap: string }) => option.historyOverlap)
    ).toEqual(["low", "similar"]);
    expect(payload.recommendedId).toBe("focus-1");
    expect(payload.similarMaterials).toEqual([
      {
        id: 91,
        kind: "plan",
        title: "산악사고 대비 훈련계획",
        topic: "산악사고대비 훈련",
        focus: "조난자 수색구역 설정과 위치 확인",
        createdAt: "2026-08-31T03:00:00.000Z",
      },
    ]);
    expect(Object.keys(payload.similarMaterials[0]).sort()).toEqual(
      ["createdAt", "focus", "id", "kind", "title", "topic"].sort()
    );
    expect(payload.warnings).toContain(
      "연결 자료 범위에서 새로 제안할 방향을 4개보다 적게 찾았습니다."
    );
  });

  it("현재 추천 세션에서 이미 본 방향만 hard exclusion으로 제거한다", async () => {
    const response = await POST(
      requestWith({
        category: "산악",
        topic: "산악사고대비 훈련",
        excludeFocuses: ["조난자 수색구역 설정과 위치 확인"],
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.options.map((option: { title: string }) => option.title)).toEqual([
      "급경사 로프 접근과 확보",
    ]);
  });

  it("같은 분야라도 다른 상위 주제의 저장 자료는 추천 순위와 하단 목록에 섞지 않는다", async () => {
    mocks.createClient.mockResolvedValue(
      makeClient([
        {
          id: 92,
          kind: "lesson",
          category: "산악",
          topic: "산악 로프구조 훈련",
          title: "로프구조 교안",
          focus: "조난자 수색구역 설정과 위치 확인",
          created_at: "2026-08-30T03:00:00.000Z",
        },
      ])
    );

    const response = await POST(
      requestWith({ category: "산악", topic: "산악사고대비 훈련" })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.options[0].title).toBe("조난자 수색구역 설정과 위치 확인");
    expect(payload.similarMaterials).toEqual([]);
  });

  it("새 추천이 없어도 같은 주제의 저장 자료가 있으면 정상 응답으로 재사용 경로를 제공한다", async () => {
    mocks.createClient.mockResolvedValue(
      makeClient([
        {
          id: 93,
          kind: "slides",
          category: "산악",
          topic: "산악사고 대비 훈련",
          title: "산악사고 대응 슬라이드",
          focus: "급경사 로프 접근과 확보",
          created_at: "2026-08-29T03:00:00.000Z",
        },
      ])
    );
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
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.options).toEqual([]);
    expect(payload.recommendedId).toBeUndefined();
    expect(payload.similarMaterials).toHaveLength(1);
  });

  it("저장 이력 조회가 실패해도 추천을 반환하고 유사 자료 비교 경고를 표시한다", async () => {
    mocks.createClient.mockResolvedValue(makeClient([], { message: "temporary failure" }));

    const response = await POST(
      requestWith({ category: "산악", topic: "산악사고대비 훈련" })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.options).toHaveLength(2);
    expect(payload.similarMaterials).toEqual([]);
    expect(payload.historyBasis).toBe("request-only");
    expect(payload.warnings).toContain("최근 저장 자료와의 중복 비교를 완료하지 못했습니다.");
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

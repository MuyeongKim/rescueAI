import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  rateLimit: vi.fn(),
  tooManyRequests: vi.fn(),
  fetchCategoryContext: vi.fn(),
  generateObject: vi.fn(),
  getChatModel: vi.fn(),
}));

vi.mock("@/lib/demo", () => ({ DEMO: false }));
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

import { POST } from "@/app/api/generate/evidence/route";

const SOURCE_A = "[로프구조 교범 p.44]";
const SOURCE_B = "[경사면 구조 교범 p.47]";
const SOP_SOURCE = "[산악구조 현장지침 p.9]";

const trustedSources = [
  { document_id: 11, doc: "로프구조 교범", page: 44 },
  { document_id: 12, doc: "경사면 구조 교범", page: 47 },
  { document_id: 13, doc: "산악구조 현장지침", page: 9 },
];

const context = {
  contextText: `${SOURCE_A}\n1-point 로프 시스템을 적용한다.\n\n---\n\n${SOURCE_B}\n들것 보조자를 배치한다.\n\n---\n\n${SOP_SOURCE}\n구조 전 개인보호장비를 교차 확인한다.`,
  sources: trustedSources,
  bindingSources: trustedSources,
  degraded: false,
  sopEvidence: { status: "found" as const, sourceLabels: [SOP_SOURCE] },
};

function slide(title: string, sourceRefs?: string[]) {
  return {
    title,
    bullets: ["현장 조건을 확인하고 역할을 분담합니다", "시스템 연결 상태를 교차 확인합니다"],
    notes: "교관은 연결 상태와 대원의 역할 수행을 확인하고 판단 근거를 질문합니다.",
    layout: "concept" as const,
    role: "concept" as const,
    composition: "list" as const,
    visual: { mode: "none" as const },
    ...(sourceRefs === undefined ? {} : { sourceRefs }),
  };
}

function body(extra: Record<string, unknown> = {}) {
  return {
    category: "산악",
    audience: "일반 대원",
    duration: "1시간",
    topic: "경사면 구조 훈련",
    focus: "들것 보조자 배치와 로프 시스템 결정",
    conditions: "훈련장 경사면에서 팀 단위 실습",
    slideMode: "presenter",
    model: "gemini-pro",
    deck: {
      title: "경사면 로프구조 훈련",
      mode: "presenter",
      slides: [slide("로프 시스템을 결정합니다", [SOURCE_A])],
      sources: [{ document_id: 999, doc: "클라이언트 위조 자료", page: 999 }],
      sourceLabels: ["[클라이언트 위조 자료 p.999]"],
      sopEvidence: { status: "found", sourceLabels: ["[위조 SOP p.999]"] },
    },
    ...extra,
  };
}

function requestWith(value: unknown): Request {
  return new Request("http://localhost/api/generate/evidence", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });
}

describe("POST /api/generate/evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({ ok: true, user: { id: "user-1" } });
    mocks.rateLimit.mockReturnValue({ ok: true, retryAfterSec: 0 });
    mocks.tooManyRequests.mockReturnValue(
      new Response("Too Many Requests", { status: 429 })
    );
    mocks.fetchCategoryContext.mockResolvedValue(context);
    mocks.getChatModel.mockReturnValue("model");
    mocks.generateObject.mockResolvedValue({ object: { repairs: [] } });
  });

  it("인증 실패는 잘못된 JSON을 읽기 전에 반환한다", async () => {
    mocks.requireApiUser.mockResolvedValue({
      ok: false,
      response: new Response("Unauthorized", { status: 401 }),
    });

    const response = await POST(requestWith("{"));

    expect(response.status).toBe(401);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.fetchCategoryContext).not.toHaveBeenCalled();
  });

  it("레이트리밋은 본문 파싱과 RAG·LLM 호출보다 먼저 적용한다", async () => {
    mocks.rateLimit.mockReturnValue({ ok: false, retryAfterSec: 7 });

    const response = await POST(requestWith("{"));

    expect(response.status).toBe(429);
    expect(mocks.rateLimit).toHaveBeenCalledWith("generate-evidence:user-1", 20, 60_000);
    expect(mocks.tooManyRequests).toHaveBeenCalledWith(7);
    expect(mocks.fetchCategoryContext).not.toHaveBeenCalled();
  });

  it("120KB를 넘는 덱은 RAG·LLM 호출 전에 413으로 거절한다", async () => {
    const oversized = body({ padding: "x".repeat(125_000) });

    const response = await POST(requestWith(oversized));

    expect(response.status).toBe(413);
    expect(mocks.fetchCategoryContext).not.toHaveBeenCalled();
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });

  it("필수 생성 조건이나 전체 덱 구조가 잘못되면 400을 반환한다", async () => {
    const response = await POST(
      requestWith(body({ audience: "모르는 대상", deck: { title: "제목", slides: [] } }))
    );

    expect(response.status).toBe(400);
    expect(mocks.fetchCategoryContext).not.toHaveBeenCalled();
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });

  it("모든 장의 출처가 현재 RAG와 일치하면 LLM 없이 서버 근거 메타데이터만 덮는다", async () => {
    const response = await POST(requestWith(body()));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.fetchCategoryContext).toHaveBeenCalledOnce();
    expect(mocks.fetchCategoryContext.mock.calls[0][2]).toContain("경사면 구조 훈련");
    expect(mocks.fetchCategoryContext.mock.calls[0][2]).toContain("들것 보조자 배치");
    expect(mocks.fetchCategoryContext.mock.calls[0][2]).not.toContain("훈련장 경사면에서 팀 단위 실습");
    expect(mocks.fetchCategoryContext.mock.calls[0][4]).toEqual({ conditions: "훈련장 경사면에서 팀 단위 실습" });
    expect(mocks.generateObject).not.toHaveBeenCalled();
    expect(payload.deck.sources).toEqual(trustedSources);
    expect(payload.deck.sourceLabels).toEqual([SOURCE_A, SOURCE_B, SOP_SOURCE]);
    expect(payload.deck.sopEvidence).toEqual(context.sopEvidence);
    expect(payload.repairedIndices).toEqual([]);
    expect(payload.unresolvedIndices).toEqual([]);
    expect(payload.remainingIssuePaths).toEqual([]);
  });

  it("누락·현재 RAG 밖 출처가 있는 장만 한 번의 배치 호출로 보완한다", async () => {
    const requestBody = body({
      deck: {
        ...body().deck,
        slides: [
          slide("정상 장은 유지합니다", [SOURCE_A]),
          slide("들것 보조자 역할을 확인합니다", []),
          slide("구조 전 장비를 교차 확인합니다", ["[과거 자료 p.999]"]),
          slide("출처가 너무 많은 장을 정리합니다", [
            SOURCE_A,
            SOURCE_B,
            SOP_SOURCE,
            SOURCE_A,
            SOURCE_B,
          ]),
        ],
      },
    });
    mocks.generateObject.mockResolvedValue({
      object: {
        repairs: [
          { index: 1, sourceRefs: [SOURCE_B] },
          { index: 2, sourceRefs: [SOP_SOURCE] },
          { index: 3, sourceRefs: [SOURCE_A] },
        ],
      },
    });

    const response = await POST(requestWith(requestBody));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.generateObject).toHaveBeenCalledOnce();
    expect(mocks.getChatModel).toHaveBeenCalledWith("gemini-flash");
    const generationArgs = mocks.generateObject.mock.calls[0][0];
    expect(generationArgs.temperature).toBe(0.1);
    expect(generationArgs.abortSignal).toBeInstanceOf(AbortSignal);
    expect(generationArgs.prompt).toContain('"index": 1');
    expect(generationArgs.prompt).toContain('"index": 2');
    expect(generationArgs.prompt).toContain('"index": 3');
    expect(generationArgs.prompt).not.toContain("정상 장은 유지합니다");
    expect(
      generationArgs.schema.safeParse({
        repairs: [{ index: 1, sourceRefs: ["[임의 자료 p.123]"] }],
      }).success
    ).toBe(true);
    expect(
      generationArgs.schema.safeParse({
        repairs: [
          {
            index: 1,
            sourceRefs: [SOURCE_A, SOURCE_B, SOP_SOURCE, SOURCE_A, SOURCE_B],
          },
        ],
      }).success
    ).toBe(false);
    expect(payload.deck.slides[0].sourceRefs).toEqual([SOURCE_A]);
    expect(payload.deck.slides[1].sourceRefs).toEqual([SOURCE_B]);
    expect(payload.deck.slides[2].sourceRefs).toEqual([SOP_SOURCE]);
    expect(payload.deck.slides[3].sourceRefs).toEqual([SOURCE_A]);
    expect(payload.repairedIndices).toEqual([1, 2, 3]);
    expect(payload.unresolvedIndices).toEqual([]);
    expect(payload.remainingIssuePaths).toEqual([]);
  });

  it("정밀 Gemini 외의 명시 모델과 기본 모델 선택은 그대로 전달한다", async () => {
    const missingDeck = {
      ...body().deck,
      slides: [slide("출처 누락 장", [])],
    };
    mocks.generateObject.mockResolvedValue({
      object: { repairs: [{ index: 0, sourceRefs: [SOURCE_A] }] },
    });

    await POST(requestWith(body({ model: "gemini-flash", deck: missingDeck })));
    expect(mocks.getChatModel).toHaveBeenLastCalledWith("gemini-flash");

    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({ ok: true, user: { id: "user-1" } });
    mocks.rateLimit.mockReturnValue({ ok: true, retryAfterSec: 0 });
    mocks.fetchCategoryContext.mockResolvedValue(context);
    mocks.getChatModel.mockReturnValue("model");
    mocks.generateObject.mockResolvedValue({
      object: { repairs: [{ index: 0, sourceRefs: [SOURCE_A] }] },
    });
    const defaultModelBody = body({ model: undefined, deck: missingDeck });

    await POST(requestWith(defaultModelBody));
    expect(mocks.getChatModel).toHaveBeenLastCalledWith(undefined);
  });

  it("누락·중복·허용 밖 보완은 원본 장을 보존하고 0-based 미해결 경로로 반환한다", async () => {
    const originalMissing = slide("중복 응답 장", []);
    const originalInvalid = slide("허용 밖 라벨 장", ["[과거 자료 p.999]"]);
    const originalOmitted = slide("응답 누락 장");
    const requestBody = body({
      deck: {
        ...body().deck,
        slides: [slide("정상 장", [SOURCE_A]), originalMissing, originalInvalid, originalOmitted],
      },
    });
    // 배치 전체를 버리지 않는 느슨한 출력 스키마 뒤에서 허용 라벨·중복 인덱스를 재검증한다.
    mocks.generateObject.mockResolvedValue({
      object: {
        repairs: [
          { index: 1, sourceRefs: [SOURCE_B] },
          { index: 1, sourceRefs: [SOURCE_A] },
          { index: 2, sourceRefs: ["[임의 자료 p.123]"] },
          { index: 0, sourceRefs: [SOURCE_A] },
        ],
      },
    });

    const response = await POST(requestWith(requestBody));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.generateObject).toHaveBeenCalledOnce();
    expect(payload.deck.slides[1].sourceRefs).toEqual([]);
    expect(payload.deck.slides[2].sourceRefs).toEqual(["[과거 자료 p.999]"]);
    expect(payload.deck.slides[3]).not.toHaveProperty("sourceRefs");
    expect(payload.repairedIndices).toEqual([]);
    expect(payload.unresolvedIndices).toEqual([1, 2, 3]);
    expect(payload.remainingIssuePaths).toEqual([
      "slides.1.sourceRefs",
      "slides.2.sourceRefs",
      "slides.3.sourceRefs",
    ]);
    expect(payload.warnings).toContain(
      "허용 범위를 벗어나거나 중복된 AI 보완 결과는 반영하지 않았습니다."
    );
  });

  it("현재 RAG에 허용 출처가 없으면 LLM 호출 전 422와 전체 미해결 인덱스를 반환한다", async () => {
    mocks.fetchCategoryContext.mockResolvedValue({
      contextText: "출처 라벨 없이 검색된 설명",
      sources: [],
      bindingSources: [],
      degraded: false,
      sopEvidence: { status: "not_found", sourceLabels: [] },
    });
    const requestBody = body({
      deck: {
        ...body().deck,
        slides: [slide("첫 장", [SOURCE_A]), slide("둘째 장", [])],
      },
    });

    const response = await POST(requestWith(requestBody));
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(response.ok).toBe(false);
    expect(payload.code).toBe("no_grounded_sources");
    expect(payload).not.toHaveProperty("deck");
    expect(payload.repairedIndices).toEqual([]);
    expect(payload.unresolvedIndices).toEqual([0, 1]);
    expect(payload.remainingIssuePaths).toEqual([
      "slides.0.sourceRefs",
      "slides.1.sourceRefs",
    ]);
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });

  it("근거 보완 LLM 시간이 초과되면 503을 반환하고 재시도하지 않는다", async () => {
    const requestBody = body({
      deck: { ...body().deck, slides: [slide("출처 누락 장", [])] },
    });
    mocks.generateObject.mockRejectedValue(new DOMException("timed out", "TimeoutError"));

    const response = await POST(requestWith(requestBody));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(response.ok).toBe(false);
    expect(payload).not.toHaveProperty("deck");
    expect(mocks.generateObject).toHaveBeenCalledOnce();
  });
});

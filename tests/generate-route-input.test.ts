import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  rateLimit: vi.fn(),
  tooManyRequests: vi.fn(),
  fetchCategoryContext: vi.fn(),
  generateObject: vi.fn(),
  getChatModel: vi.fn(),
}));

vi.mock("@/lib/demo", () => ({
  DEMO: false,
  demoGeneratedDoc: { title: "demo", sections: [] },
  demoGeneratedSlides: { title: "demo", slides: [] },
}));
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

import { POST } from "@/app/api/generate/route";
import { SOP_NOT_FOUND_DISCLOSURE } from "@/lib/sop-evidence";

function requestWith(body: unknown): Request {
  return new Request("http://localhost/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function validBody(extra: Record<string, unknown> = {}) {
  return {
    type: "plan",
    category: "화재",
    audience: "일반 대원",
    duration: "1시간",
    topic: "공기호흡기 착용 방법",
    ...extra,
  };
}

function expanded(text: string, minimum: number): string {
  let value = text;
  const detail =
    "교관은 단계별 판단 근거를 질문하고 대원은 역할과 확인 결과를 상호 점검한 뒤 누락된 동작을 다시 수행한다.";
  while (value.replace(/\s+/g, " ").trim().length < minimum) value += ` ${detail}`;
  return value;
}

function validGeneratedPlan(sourceRef: string) {
  return {
    title: "공기호흡기 착용 훈련계획",
    sections: [
      {
        heading: "훈련목표",
        content: expanded(
          "대원은 공기호흡기 상태와 역할을 확인하고 착용 절차와 비상 대응을 안전하게 수행할 수 있다.",
          70
        ),
      },
      {
        heading: "훈련내용",
        content: expanded(
          `[도입 · 10분] 역할을 확인한다. [이론 · 10분] 장비 원리를 설명한다. [시범 · 10분] 착용 절차를 관찰한다. [실습 · 20분] 조별로 반복한다. [평가 · 10분] 수행 결과를 확인한다. ${SOP_NOT_FOUND_DISCLOSURE} ${sourceRef}`,
          240
        ),
      },
      {
        heading: "필요장비",
        content: expanded(
          `공기호흡기와 개인보호장비, 통신장비를 인원별로 준비하고 사용 전 손상 여부와 잔압을 확인한다. ${sourceRef}`,
          70
        ),
      },
      {
        heading: "안전관리",
        content: expanded(
          `교관은 보호구와 안전구역을 점검하고 장비 이상이나 통신 두절이 발생하면 훈련을 즉시 중단하고 현장지휘자에게 보고한 뒤 안전한 위치로 철수시킨다. ${sourceRef}`,
          120
        ),
      },
      {
        heading: "훈련평가",
        content: expanded(
          "평가 체크리스트로 장비 점검과 착용 순서, 상황보고를 관찰한다. 필수 항목을 누락 없이 정확히 수행하면 통과하고 미달 항목은 교정 후 다시 평가한다.",
          100
        ),
      },
    ],
  };
}

describe("POST /api/generate 입력 경계", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({ ok: true, user: { id: "user-1" } });
    mocks.rateLimit.mockReturnValue({ ok: true, retryAfterSec: 0 });
    mocks.tooManyRequests.mockReturnValue(new Response("Too Many Requests", { status: 429 }));
    mocks.fetchCategoryContext.mockResolvedValue({
      contextText: "",
      sources: [],
      bindingSources: [],
      degraded: false,
      sopEvidence: { status: "not_found", sourceLabels: [] },
    });
  });

  it("인증 실패는 잘못된 JSON을 읽기 전에 반환한다", async () => {
    mocks.requireApiUser.mockResolvedValue({
      ok: false,
      response: new Response("Unauthorized", { status: 401 }),
    });

    const response = await POST(requestWith("{"));

    expect(response.status).toBe(401);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it("레이트리밋은 잘못된 JSON을 읽기 전에 적용한다", async () => {
    mocks.rateLimit.mockReturnValue({ ok: false, retryAfterSec: 9 });

    const response = await POST(requestWith("{"));

    expect(response.status).toBe(429);
    expect(mocks.rateLimit).toHaveBeenCalledWith("generate:user-1", 20, 60_000);
    expect(mocks.tooManyRequests).toHaveBeenCalledWith(9);
  });

  it("8KB를 넘는 생성 요청은 검색이나 LLM 호출 전에 413으로 거절한다", async () => {
    const response = await POST(requestWith(validBody({ conditions: "x".repeat(9_000) })));

    expect(response.status).toBe(413);
    expect(mocks.fetchCategoryContext).not.toHaveBeenCalled();
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });

  it("문자열이어야 하는 주제와 분야에 배열·객체가 오면 400을 반환한다", async () => {
    const response = await POST(
      requestWith(validBody({ topic: ["공기호흡기"], category: { name: "화재" } }))
    );

    expect(response.status).toBe(400);
    expect(mocks.fetchCategoryContext).not.toHaveBeenCalled();
  });

  it("필드별 상한을 넘긴 주제는 잘라서 보내지 않고 400으로 거절한다", async () => {
    const response = await POST(requestWith(validBody({ topic: "가".repeat(101) })));

    expect(response.status).toBe(400);
    expect(mocks.fetchCategoryContext).not.toHaveBeenCalled();
  });

  it("문서 생성 응답은 화면 표시 한도를 넘어선 전체 바인딩 출처를 보존한다", async () => {
    const bindingSources = Array.from({ length: 7 }, (_, index) => ({
      document_id: index + 1,
      doc: `공기호흡기 교육자료 ${index + 1}`,
      page: index + 1,
    }));
    const contextText = bindingSources
      .map(
        (source) =>
          `[${source.doc} p.${source.page}]\n공기호흡기 점검과 착용 절차 근거 ${source.page}`
      )
      .join("\n\n---\n\n");
    mocks.fetchCategoryContext.mockResolvedValue({
      contextText,
      sources: bindingSources.slice(0, 5),
      bindingSources,
      degraded: false,
      sopEvidence: { status: "not_found", sourceLabels: [] },
    });
    mocks.getChatModel.mockReturnValue("model");
    mocks.generateObject.mockResolvedValue({
      object: validGeneratedPlan("[공기호흡기 교육자료 1 p.1]"),
    });

    const response = await POST(requestWith(validBody()));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.generateObject).toHaveBeenCalledOnce();
    expect(payload.sources).toEqual(bindingSources);
    expect(payload.sourceLabels).toHaveLength(7);
    expect(payload.quality.errors).toEqual([]);
  });
});

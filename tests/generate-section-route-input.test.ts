import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { maxDuration, POST } from "@/app/api/generate/section/route";
import { SOP_NOT_FOUND_DISCLOSURE } from "@/lib/sop-evidence";

function requestWith(body: unknown, signal?: AbortSignal): Request {
  return new Request("http://localhost/api/generate/section", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal,
  });
}

function validSectionBody(extra: Record<string, unknown> = {}) {
  return {
    kind: "section",
    category: "화재",
    audience: "일반 대원",
    duration: "1시간",
    topic: "공기호흡기 착용 방법",
    outline: ["훈련목표", "훈련내용"],
    index: 1,
    current: { heading: "훈련내용", content: "현재 내용" },
    ...extra,
  };
}

function validSlideBody(extra: Record<string, unknown> = {}) {
  return {
    kind: "slide",
    category: "화재",
    audience: "일반 대원",
    duration: "1시간",
    topic: "공기호흡기 착용 방법",
    outline: ["착용 전 점검", "착용 절차"],
    index: 1,
    current: {
      title: "착용 절차를 확인합니다",
      bullets: ["보호장비 상태를 먼저 확인합니다"],
      notes: "교관 설명",
    },
    ...extra,
  };
}

function regeneratedSlide(notes: string) {
  return {
    title: "착용 절차를 확인합니다",
    bullets: ["보호장비 상태를 먼저 확인합니다"],
    notes,
    layout: "summary",
    role: "summary",
    composition: "statement",
    visual: { mode: "none" },
    sourceRefs: ["[공기호흡기 교범 p.3]"],
  };
}

describe("POST /api/generate/section 입력 경계", () => {
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("정밀 모델 시간초과 시 결합된 호출 신호로 빠른 모델을 한 번 재시도한다", async () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    mocks.fetchCategoryContext.mockResolvedValue({
      contextText: "[공기호흡기 교범 p.3]\n보호장비 상태를 확인합니다.",
      sources: [],
      bindingSources: [],
      degraded: false,
      sopEvidence: { status: "not_found", sourceLabels: [] },
    });
    mocks.getChatModel.mockImplementation((key?: string) => key ?? "default");
    mocks.generateObject
      .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"))
      .mockResolvedValueOnce({
        object: { heading: "필요장비", content: "공기호흡기 상태를 확인합니다." },
      });

    const response = await POST(
      requestWith(
        validSectionBody({
          model: "gemini-pro",
          current: { heading: "필요장비", content: "현재 장비 목록" },
        })
      )
    );

    expect(maxDuration).toBe(120);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Model-Fallback")).toBe("1");
    expect(mocks.getChatModel.mock.calls.map(([key]) => key)).toEqual([
      "gemini-pro",
      "gemini-flash",
    ]);
    expect(mocks.generateObject).toHaveBeenCalledTimes(2);
    expect(timeoutSpy.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      60_000,
      30_000,
    ]);
    expect(mocks.generateObject.mock.calls[0][0].abortSignal).toBeInstanceOf(AbortSignal);
    expect(mocks.generateObject.mock.calls[1][0].abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("브라우저 요청이 취소되면 정밀 모델 실패 뒤 빠른 모델을 호출하지 않는다", async () => {
    const controller = new AbortController();
    const request = requestWith(
      validSectionBody({
        model: "gemini-pro",
        current: { heading: "필요장비", content: "현재 장비 목록" },
      }),
      controller.signal
    );
    mocks.fetchCategoryContext.mockResolvedValue({
      contextText: "[공기호흡기 교범 p.3]\n보호장비 상태를 확인합니다.",
      sources: [],
      bindingSources: [],
      degraded: false,
      sopEvidence: { status: "not_found", sourceLabels: [] },
    });
    mocks.getChatModel.mockImplementation((key?: string) => key ?? "default");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
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
    mocks.fetchCategoryContext.mockResolvedValue({
      contextText: "[공기호흡기 교범 p.3]\n보호장비 상태를 확인합니다.",
      sources: [],
      bindingSources: [],
      degraded: false,
      sopEvidence: { status: "not_found", sourceLabels: [] },
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.generateObject.mockRejectedValueOnce(
      new DOMException("timed out", "TimeoutError")
    );

    const response = await POST(
      requestWith(
        validSectionBody({
          model: "gemini-flash",
          current: { heading: "필요장비", content: "현재 장비 목록" },
        })
      )
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
      now = 101_000;
      return {
        contextText: "[공기호흡기 교범 p.3]\n보호장비 상태를 확인합니다.",
        sources: [],
        bindingSources: [],
        degraded: false,
        sopEvidence: { status: "not_found", sourceLabels: [] },
      };
    });

    const response = await POST(
      requestWith(
        validSectionBody({
          model: "gemini-flash",
          current: { heading: "필요장비", content: "현재 장비 목록" },
        })
      )
    );

    expect(response.status).toBe(503);
    expect(mocks.generateObject).not.toHaveBeenCalled();
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
    mocks.rateLimit.mockReturnValue({ ok: false, retryAfterSec: 11 });

    const response = await POST(requestWith("{"));

    expect(response.status).toBe(429);
    expect(mocks.rateLimit).toHaveBeenCalledWith("generate-section:user-1", 30, 60_000);
    expect(mocks.tooManyRequests).toHaveBeenCalledWith(11);
  });

  it("120KB를 넘는 현재 내용은 검색이나 LLM 호출 전에 413으로 거절한다", async () => {
    const response = await POST(
      requestWith(validSectionBody({ current: { heading: "훈련내용", content: "x".repeat(125_000) } }))
    );

    expect(response.status).toBe(413);
    expect(mocks.fetchCategoryContext).not.toHaveBeenCalled();
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });

  it("현재 슬라이드의 bullets가 배열이 아니면 400을 반환한다", async () => {
    const response = await POST(
      requestWith({
        ...validSectionBody(),
        kind: "slide",
        current: { title: "착용 절차", bullets: "배열 아님", notes: "설명" },
      })
    );

    expect(response.status).toBe(400);
    expect(mocks.fetchCategoryContext).not.toHaveBeenCalled();
  });

  it("부분 재생성할 슬라이드의 검증 출처 라벨이 없으면 LLM 호출 전 422를 반환한다", async () => {
    mocks.fetchCategoryContext.mockResolvedValue({
      contextText: "출처 라벨 없는 근거 본문",
      sources: [],
      bindingSources: [],
      degraded: false,
      sopEvidence: { status: "not_found", sourceLabels: [] },
    });

    const response = await POST(requestWith(validSlideBody()));
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(payload.error).toContain("검증된 근거 출처");
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });

  it("20,000자를 넘는 섹션과 30개를 넘는 목차를 400으로 거절한다", async () => {
    const tooLongContent = await POST(
      requestWith(
        validSectionBody({
          current: { heading: "훈련내용", content: "가".repeat(20_001) },
        })
      )
    );
    const tooManyOutlineItems = await POST(
      requestWith(validSectionBody({ outline: Array.from({ length: 31 }, (_, i) => `목차 ${i}`) }))
    );

    expect(tooLongContent.status).toBe(400);
    expect(tooManyOutlineItems.status).toBe(400);
    expect(mocks.fetchCategoryContext).not.toHaveBeenCalled();
  });

  it("레거시 복구 대상으로 고른 슬라이드는 기존 표식이 없어도 SOP 계약을 강제한다", async () => {
    mocks.fetchCategoryContext.mockResolvedValue({
      contextText: "[공기호흡기 교범 p.3]\n보호장비 상태를 확인합니다.",
      sources: [],
      bindingSources: [],
      degraded: false,
      sopEvidence: { status: "not_found", sourceLabels: [] },
    });
    mocks.getChatModel.mockReturnValue("model");
    mocks.generateObject
      .mockResolvedValueOnce({ object: regeneratedSlide("교관 설명") })
      .mockResolvedValueOnce({
        object: regeneratedSlide(`${SOP_NOT_FOUND_DISCLOSURE}\n교관 설명`),
      });

    const response = await POST(
      requestWith(validSlideBody({ model: "gemini-pro", sopTarget: true }))
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.generateObject).toHaveBeenCalledTimes(2);
    expect(mocks.getChatModel.mock.calls.map(([key]) => key)).toEqual([
      "gemini-pro",
      "gemini-flash",
    ]);
    expect(mocks.generateObject.mock.calls[0][0].abortSignal).toBeInstanceOf(AbortSignal);
    expect(mocks.generateObject.mock.calls[1][0].abortSignal).toBeInstanceOf(AbortSignal);
    const strictSchema = mocks.generateObject.mock.calls[0][0].schema;
    expect(
      strictSchema.safeParse({ ...regeneratedSlide("교관 설명"), sourceRefs: undefined })
        .success
    ).toBe(false);
    expect(
      strictSchema.safeParse({
        ...regeneratedSlide("교관 설명"),
        sourceRefs: ["[만들어낸 교범 p.99]"],
      }).success
    ).toBe(false);
    expect(mocks.generateObject.mock.calls[0][0].prompt).toContain(
      "이 장은 SOP 적용 근거 장입니다."
    );
    expect(mocks.generateObject.mock.calls[1][0].prompt).toContain("SOP 계약 오류");
    expect(payload.notes).toContain(SOP_NOT_FOUND_DISCLOSURE);
    expect(payload.sopEvidence).toEqual({ status: "not_found", sourceLabels: [] });
  });

  it("최신 덱의 일반 슬라이드는 기존 SOP 표식이 없으면 강제 대상이 아니다", async () => {
    mocks.fetchCategoryContext.mockResolvedValue({
      contextText: "[공기호흡기 교범 p.3]\n보호장비 상태를 확인합니다.",
      sources: [],
      bindingSources: [],
      degraded: false,
      sopEvidence: { status: "not_found", sourceLabels: [] },
    });
    mocks.getChatModel.mockReturnValue("model");
    mocks.generateObject.mockResolvedValueOnce({ object: regeneratedSlide("교관 설명") });

    const response = await POST(requestWith(validSlideBody()));

    expect(response.status).toBe(200);
    expect(mocks.generateObject).toHaveBeenCalledOnce();
    expect(mocks.generateObject.mock.calls[0][0].prompt).not.toContain(
      "이 장은 SOP 적용 근거 장입니다."
    );
  });

  it("강제 SOP 복구가 두 번의 생성 뒤에도 계약을 만족하지 못하면 evidence를 붙이지 않는다", async () => {
    mocks.fetchCategoryContext.mockResolvedValue({
      contextText: "[공기호흡기 교범 p.3]\n보호장비 상태를 확인합니다.",
      sources: [],
      bindingSources: [],
      degraded: false,
      sopEvidence: { status: "not_found", sourceLabels: [] },
    });
    mocks.getChatModel.mockReturnValue("model");
    mocks.generateObject.mockResolvedValue({ object: regeneratedSlide("교관 설명") });

    const response = await POST(requestWith(validSlideBody({ sopTarget: true })));
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(payload.code).toBe("sop_contract_invalid");
    expect(payload).not.toHaveProperty("sopEvidence");
  });

  it("문서 지정 섹션도 두 번의 생성 뒤 SOP 계약이 누락되면 evidence를 붙이지 않는다", async () => {
    mocks.fetchCategoryContext.mockResolvedValue({
      contextText: "[공기호흡기 교범 p.3]\n보호장비 상태를 확인합니다.",
      sources: [],
      bindingSources: [],
      degraded: false,
      sopEvidence: { status: "not_found", sourceLabels: [] },
    });
    mocks.getChatModel.mockReturnValue("model");
    mocks.generateObject.mockResolvedValue({
      object: { heading: "훈련내용", content: "보호장비 상태를 확인합니다." },
    });

    const response = await POST(requestWith(validSectionBody()));
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(mocks.generateObject).toHaveBeenCalledTimes(2);
    expect(payload.code).toBe("sop_contract_invalid");
    expect(payload).not.toHaveProperty("sopEvidence");
  });

  it("문서 섹션 재생성도 새 인용 검증을 위해 전체 바인딩 출처를 반환한다", async () => {
    const bindingSources = Array.from({ length: 7 }, (_, index) => ({
      document_id: index + 1,
      doc: `공기호흡기 교육자료 ${index + 1}`,
      page: index + 1,
    }));
    mocks.fetchCategoryContext.mockResolvedValue({
      contextText: bindingSources
        .map(
          (source) =>
            `[${source.doc} p.${source.page}]\n공기호흡기 점검과 착용 절차 근거 ${source.page}`
        )
        .join("\n\n---\n\n"),
      sources: bindingSources.slice(0, 5),
      bindingSources,
      degraded: false,
      sopEvidence: { status: "not_found", sourceLabels: [] },
    });
    mocks.getChatModel.mockReturnValue("model");
    mocks.generateObject.mockResolvedValue({
      object: {
        heading: "필요장비",
        content:
          "공기호흡기와 개인보호장비를 인원별로 준비하고 점검합니다. [공기호흡기 교육자료 1 p.1]",
      },
    });

    const response = await POST(
      requestWith(
        validSectionBody({
          outline: ["훈련목표", "훈련내용", "필요장비", "안전관리", "훈련평가"],
          index: 2,
          current: { heading: "필요장비", content: "현재 장비 목록" },
        })
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.generateObject).toHaveBeenCalledOnce();
    expect(payload.sources).toEqual(bindingSources);
    expect(payload.sourceLabels).toHaveLength(7);
    expect(payload.content).toBe(
      "공기호흡기와 개인보호장비를 인원별로 준비하고 점검합니다."
    );
    expect(mocks.generateObject.mock.calls[0][0].prompt).toContain(
      "문서 맨 뒤의 '근거 자료 및 출처'"
    );
  });
});

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

import { maxDuration, POST } from "@/app/api/generate/route";
import { generationProDraftCallMaxMs } from "@/lib/generation-budget";
import { SOP_NOT_FOUND_DISCLOSURE } from "@/lib/sop-evidence";

function requestWith(body: unknown, signal?: AbortSignal): Request {
  return new Request("http://localhost/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
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
    "교관은 단계별 판단 근거를 질문하고 대원은 역할과 확인 결과를 상호 점검한다. 교관은 즉시 피드백하고 누락된 동작을 교정하여 다시 수행하게 한다.";
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
          `[도입 · 10분] 역할을 확인한다. [이론 · 10분] 장비 원리를 설명한다. [시범 · 10분] 착용 절차를 관찰한다. [실습 · 20분] 대원 행동절차:\n1) 장비 외관을 점검하고 손상 여부를 확인한다.\n2) 결합부를 손으로 당겨 고정 상태를 확인한다.\n3) 작동 상태를 확인한 뒤 교관에게 결과를 보고한다.\n이상 시: 수행을 중단하고 교관에게 보고한 뒤 누락 동작을 교정하여 다시 점검한다. [평가 · 10분] 수행 결과를 확인한다. ${SOP_NOT_FOUND_DISCLOSURE} ${sourceRef}`,
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

  it("정밀 초안에 유형별 시간을 주고 서버 종료 전 빠른 모델 복구 여유를 둔다", () => {
    expect(maxDuration).toBe(300);
    expect(generationProDraftCallMaxMs("plan")).toBe(120_000);
    expect(generationProDraftCallMaxMs("lesson")).toBe(150_000);
    expect(generationProDraftCallMaxMs("slides")).toBe(180_000);
  });

  it("동기 생성도 Workflow·저장 검증과 같이 현장 조건과 세부 방향으로 검색한다", async () => {
    const response = await POST(requestWith(validBody({ conditions: "야간 동료 확인", focus: "착용 전 점검" })));
    expect(response.status).toBe(422);
    expect(mocks.fetchCategoryContext).toHaveBeenCalledWith("화재", 40, "야간 동료 확인 착용 전 점검 / 상위 주제: 공기호흡기 착용 방법");
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

  it("슬라이드용 검증 출처 라벨이 없으면 LLM 호출 전 422를 반환한다", async () => {
    mocks.fetchCategoryContext.mockResolvedValue({
      contextText: "출처 라벨 없이 전달된 근거 본문",
      sources: [],
      bindingSources: [],
      degraded: false,
      sopEvidence: { status: "not_found", sourceLabels: [] },
    });

    const response = await POST(requestWith(validBody({ type: "slides" })));
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(payload.error).toContain("검증된 근거 출처");
    expect(mocks.generateObject).not.toHaveBeenCalled();
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
    expect(mocks.generateObject.mock.calls[0]?.[0]?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(payload.sources).toEqual(bindingSources);
    expect(payload.sourceLabels).toHaveLength(7);
    expect(
      payload.sections.every((section: { content: string }) =>
        !section.content.includes("[공기호흡기 교육자료 1 p.1]")
      )
    ).toBe(true);
    expect(payload.quality.errors).toEqual([]);
  });

  it("정밀 모델 호출이 시간 초과되면 시간 예산 안에서 빠른 모델로 재시도한다", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const source = { document_id: 1, doc: "공기호흡기 교육자료", page: 1 };
    const sourceRef = "[공기호흡기 교육자료 p.1]";
    mocks.fetchCategoryContext.mockResolvedValue({
      contextText: `${sourceRef}\n공기호흡기 점검과 착용 절차 근거`,
      sources: [source],
      bindingSources: [source],
      degraded: false,
      sopEvidence: { status: "not_found", sourceLabels: [] },
    });
    mocks.getChatModel.mockImplementation((key) => key);
    mocks.generateObject
      .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"))
      .mockResolvedValueOnce({ object: validGeneratedPlan(sourceRef) });

    try {
      const response = await POST(requestWith(validBody({ model: "gemini-pro" })));
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(mocks.getChatModel).toHaveBeenNthCalledWith(1, "gemini-pro");
      expect(mocks.getChatModel).toHaveBeenNthCalledWith(2, "gemini-flash");
      expect(mocks.generateObject).toHaveBeenCalledTimes(2);
      expect(mocks.generateObject.mock.calls[1]?.[0]?.abortSignal).toBeInstanceOf(AbortSignal);
      expect(timeoutSpy.mock.calls.map(([timeoutMs]) => timeoutMs)).toEqual([
        120_000,
        60_000,
      ]);
      expect(payload.quality.warnings).toContain(
        "정밀 생성 모델 일시 제한 — 빠른 모델로 생성됨"
      );
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("요청이 중단되면 정밀 모델 호출을 끝내고 빠른 모델을 추가 호출하지 않는다", async () => {
    const source = { document_id: 1, doc: "공기호흡기 교육자료", page: 1 };
    const sourceRef = "[공기호흡기 교육자료 p.1]";
    const controller = new AbortController();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.fetchCategoryContext.mockResolvedValue({
      contextText: `${sourceRef}\n공기호흡기 점검과 착용 절차 근거`,
      sources: [source],
      bindingSources: [source],
      degraded: false,
      sopEvidence: { status: "not_found", sourceLabels: [] },
    });
    mocks.getChatModel.mockImplementation((key) => key);
    mocks.generateObject.mockImplementationOnce(
      ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise((_, reject) => {
          abortSignal.addEventListener(
            "abort",
            () => reject(abortSignal.reason),
            { once: true }
          );
          controller.abort(new DOMException("client closed", "AbortError"));
        })
    );

    try {
      const response = await POST(
        requestWith(validBody({ model: "gemini-pro" }), controller.signal)
      );

      expect(response.status).toBe(503);
      expect(mocks.getChatModel).toHaveBeenCalledOnce();
      expect(mocks.getChatModel).toHaveBeenCalledWith("gemini-pro");
      expect(mocks.generateObject).toHaveBeenCalledOnce();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("시간이 충분한 자동 보완은 정밀 모델을 유지하고 개선된 후보를 채택한다", async () => {
    const source = { document_id: 1, doc: "공기호흡기 교육자료", page: 1 };
    const sourceRef = "[공기호흡기 교육자료 p.1]";
    mocks.fetchCategoryContext.mockResolvedValue({
      contextText: `${sourceRef}\n공기호흡기 점검과 착용 절차 근거`,
      sources: [source],
      bindingSources: [source],
      degraded: false,
      sopEvidence: { status: "not_found", sourceLabels: [] },
    });
    mocks.getChatModel.mockImplementation((key) => key);
    const invalidDraft = validGeneratedPlan(sourceRef);
    invalidDraft.sections[0].content = "짧은 목표";
    mocks.generateObject
      .mockResolvedValueOnce({ object: invalidDraft })
      .mockResolvedValueOnce({ object: validGeneratedPlan(sourceRef) });

    const response = await POST(requestWith(validBody({ model: "gemini-pro" })));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.getChatModel).toHaveBeenNthCalledWith(1, "gemini-pro");
    expect(mocks.getChatModel).toHaveBeenNthCalledWith(2, "gemini-pro");
    expect(payload.quality.repaired).toBe(true);
    expect(payload.quality.warnings).not.toContain(
      "정밀 모델 초안 — 빠른 모델로 자동 보완됨"
    );
  });

  it("정밀 자동 보완이 실패하면 예약한 빠른 모델로 복구하고 채택 사실을 알린다", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const source = { document_id: 1, doc: "공기호흡기 교육자료", page: 1 };
    const sourceRef = "[공기호흡기 교육자료 p.1]";
    mocks.fetchCategoryContext.mockResolvedValue({
      contextText: `${sourceRef}\n공기호흡기 점검과 착용 절차 근거`,
      sources: [source],
      bindingSources: [source],
      degraded: false,
      sopEvidence: { status: "not_found", sourceLabels: [] },
    });
    mocks.getChatModel.mockImplementation((key) => key);
    const invalidDraft = validGeneratedPlan(sourceRef);
    invalidDraft.sections[0].content = "짧은 목표";
    mocks.generateObject
      .mockResolvedValueOnce({ object: invalidDraft })
      .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"))
      .mockResolvedValueOnce({ object: validGeneratedPlan(sourceRef) });

    try {
      const response = await POST(requestWith(validBody({ model: "gemini-pro" })));
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(mocks.getChatModel).toHaveBeenNthCalledWith(1, "gemini-pro");
      expect(mocks.getChatModel).toHaveBeenNthCalledWith(2, "gemini-pro");
      expect(mocks.getChatModel).toHaveBeenNthCalledWith(3, "gemini-flash");
      expect(timeoutSpy.mock.calls.map(([timeoutMs]) => timeoutMs)).toEqual([
        120_000,
        90_000,
        60_000,
      ]);
      expect(payload.quality.repaired).toBe(true);
      expect(payload.quality.warnings).toContain(
        "정밀 모델 초안 — 빠른 모델로 자동 보완됨"
      );
      expect(payload.quality.warnings).not.toContain(
        "정밀 생성 모델 일시 제한 — 빠른 모델로 생성됨"
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("정밀 모델 호출 실패"),
        "timed out"
      );
    } finally {
      warnSpy.mockRestore();
      timeoutSpy.mockRestore();
    }
  });

  it("정밀 보완 시간을 담을 수 없으면 빠른 모델 후보를 채택했다고 구분해 알린다", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const source = { document_id: 1, doc: "공기호흡기 교육자료", page: 1 };
    const sourceRef = "[공기호흡기 교육자료 p.1]";
    mocks.fetchCategoryContext.mockResolvedValue({
      contextText: `${sourceRef}\n공기호흡기 점검과 착용 절차 근거`,
      sources: [source],
      bindingSources: [source],
      degraded: false,
      sopEvidence: { status: "not_found", sourceLabels: [] },
    });
    mocks.getChatModel.mockImplementation((key) => key);
    const invalidDraft = validGeneratedPlan(sourceRef);
    invalidDraft.sections[0].content = "짧은 목표";
    mocks.generateObject
      .mockImplementationOnce(async () => {
        now += 120_001;
        return { object: invalidDraft };
      })
      .mockResolvedValueOnce({ object: validGeneratedPlan(sourceRef) });

    try {
      const response = await POST(requestWith(validBody({ model: "gemini-pro" })));
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(mocks.getChatModel).toHaveBeenNthCalledWith(1, "gemini-pro");
      expect(mocks.getChatModel).toHaveBeenNthCalledWith(2, "gemini-flash");
      expect(payload.quality.repaired).toBe(true);
      expect(payload.quality.warnings).toContain(
        "정밀 모델 초안 — 빠른 모델로 자동 보완됨"
      );
      expect(payload.quality.warnings).not.toContain(
        "정밀 생성 모델 일시 제한 — 빠른 모델로 생성됨"
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("자동 보완 정밀 모델 시간 예산 부족")
      );
    } finally {
      infoSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });

  it("자동 보완 후보가 실제로 개선되지 않으면 정밀 원본을 유지한다", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const source = { document_id: 1, doc: "공기호흡기 교육자료", page: 1 };
    const sourceRef = "[공기호흡기 교육자료 p.1]";
    mocks.fetchCategoryContext.mockResolvedValue({
      contextText: `${sourceRef}\n공기호흡기 점검과 착용 절차 근거`,
      sources: [source],
      bindingSources: [source],
      degraded: false,
      sopEvidence: { status: "not_found", sourceLabels: [] },
    });
    mocks.getChatModel.mockImplementation((key) => key);
    const originalDraft = validGeneratedPlan(sourceRef);
    originalDraft.title = "정밀 모델 원본";
    originalDraft.sections[0].content = "짧은 목표";
    const rejectedCandidate = validGeneratedPlan(sourceRef);
    rejectedCandidate.title = "개선되지 않은 보완 후보";
    rejectedCandidate.sections[0].content = "여전히 짧음";
    mocks.generateObject
      .mockResolvedValueOnce({ object: originalDraft })
      .mockResolvedValueOnce({ object: rejectedCandidate });

    try {
      const response = await POST(requestWith(validBody({ model: "gemini-pro" })));
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.title).toBe("정밀 모델 원본");
      expect(payload.quality.repaired).toBe(false);
      expect(payload.quality.warnings).toContain(
        "자동 보완 결과가 개선되지 않아 기존 초안을 유지함"
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("자동 보완 결과 미채택"),
        expect.objectContaining({
          type: "plan",
          currentBlocking: 1,
          candidateBlocking: 1,
        })
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

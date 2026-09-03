import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  rateLimit: vi.fn(),
  tooManyRequests: vi.fn(),
  normalizeTrainingPlanHwpx: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/demo", () => ({ DEMO: false }));
vi.mock("@/lib/auth", () => ({ requireApiUser: mocks.requireApiUser }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
  tooManyRequests: mocks.tooManyRequests,
}));
vi.mock("@/lib/hwpx-template", () => ({
  normalizeTrainingPlanHwpx: mocks.normalizeTrainingPlanHwpx,
}));

import { POST } from "@/app/api/hwp/route";

function requestWith(body: unknown): Request {
  return new Request("http://localhost/api/hwp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/hwp 출처 배치", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.HWP_WRITER_API_URL = "https://hwp-writer.example";
    process.env.HWP_WRITER_API_KEY = "test-key";
    mocks.requireApiUser.mockResolvedValue({ ok: true, user: { id: "user-1" } });
    mocks.rateLimit.mockReturnValue({ ok: true, retryAfterSec: 0 });
    mocks.tooManyRequests.mockReturnValue(new Response("Too Many Requests", { status: 429 }));
    mocks.normalizeTrainingPlanHwpx.mockImplementation(async (input: Uint8Array) => input);
    mocks.fetch
      .mockResolvedValueOnce(
        Response.json({ ok: true, download_path: "/files/training-plan.hwpx" })
      )
      .mockResolvedValueOnce(new Response(new Blob(["hwpx"])));
    vi.stubGlobal("fetch", mocks.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.HWP_WRITER_API_URL;
    delete process.env.HWP_WRITER_API_KEY;
  });

  it("표준 훈련계획 양식은 문장별 출처를 숨기고 마지막 평가 셀 끝에만 모은다", async () => {
    const inlineRef = "[로프구조 — 경사면 구조 p.44]";
    const response = await POST(
      requestWith({
        title: "경사면 구조 훈련계획",
        template: "training_plan",
        sections: [
          { heading: "훈련목표", content: `구조시스템을 결정한다 ${inlineRef}.` },
          { heading: "훈련내용", content: `반복 실습을 수행한다 ${inlineRef}.` },
          { heading: "필요장비", content: "로프 장비를 점검한다." },
          { heading: "안전관리", content: "이상 시 즉시 중단하고 보고한다." },
          { heading: "훈련평가", content: "체크리스트로 평가한다." },
        ],
        sources: [
          {
            document_id: 1,
            doc: "로프구조 — 경사면 구조",
            page: 44,
          },
        ],
      })
    );

    expect(response.status).toBe(200);
    const request = mocks.fetch.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload.values.goal).toBe("구조시스템을 결정한다.");
    expect(payload.values.content).toBe("반복 실습을 수행한다.");
    expect(payload.values.evaluation).toBe(
      "체크리스트로 평가한다.\n\n근거 자료 및 출처\n- 로프구조 — 경사면 구조 p.44"
    );
    expect(JSON.stringify(payload.values).match(/근거 자료 및 출처/g)).toHaveLength(1);
  });

  it("한 줄로 붙은 단계·목록 표지를 표준 양식에 실제 줄바꿈으로 전달한다", async () => {
    const response = await POST(
      requestWith({
        title: "공기호흡기 훈련계획",
        template: "training_plan",
        sections: [
          { heading: "훈련목표", content: "1. 장비 상태 확인 2. 이상 상태 보고" },
          {
            heading: "훈련내용",
            content:
              "[이론교육 · 20분] 구성 설명 [교관시범 · 20분] 착용 절차 시범",
          },
          { heading: "필요장비", content: "· 공기호흡기 · 개인보호장비" },
          { heading: "안전관리", content: "- 압력 확인 - 이상 시 즉시 중단" },
          { heading: "훈련평가", content: "1. 점검 순서 2. 보고 정확성" },
        ],
        sources: [{ document_id: 7, doc: "공기호흡기 교육자료", page: 3 }],
      })
    );

    expect(response.status).toBe(200);
    const request = mocks.fetch.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload.values.goal).toBe("1. 장비 상태 확인\n2. 이상 상태 보고");
    expect(payload.values.content).toBe(
      "[이론교육 · 20분] 구성 설명\n[교관시범 · 20분] 착용 절차 시범"
    );
    expect(payload.values.equipment).toBe("· 공기호흡기\n· 개인보호장비");
    expect(payload.values.safety).toBe("- 압력 확인\n- 이상 시 즉시 중단");
    expect(payload.values.evaluation).toContain("1. 점검 순서\n2. 보고 정확성");
    expect(payload.values.evaluation).toContain(
      "근거 자료 및 출처\n- 공기호흡기 교육자료 p.3"
    );
  });

  it("일반 HWPX는 모든 섹션 뒤 문서 맨 끝에 근거 자료 및 출처를 붙인다", async () => {
    const response = await POST(
      requestWith({
        title: "공기호흡기 착용 교안",
        sections: [
          { heading: "학습목표", content: "장비 상태를 확인한다." },
          { heading: "정리·평가", content: "체크리스트로 수행을 평가한다." },
        ],
        sources: [
          { document_id: 7, doc: "공기호흡기 교육자료", page: 3 },
          { document_id: 8, doc: "현장 안전지침", page: null },
        ],
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.fetch.mock.calls[0][0]).toBe(
      "https://hwp-writer.example/generate/plain"
    );
    const request = mocks.fetch.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload.body).toBe(
      "학습목표\n장비 상태를 확인한다.\n\n" +
        "정리·평가\n체크리스트로 수행을 평가한다.\n\n" +
        "근거 자료 및 출처\n" +
        "- 공기호흡기 교육자료 p.3\n" +
        "- 현장 안전지침"
    );
    expect(payload.body.endsWith("- 현장 안전지침")).toBe(true);
  });

  it.each([
    ["빈 출처", []],
    ["추적 불가 번호", [{ document_id: 0, doc: "출처 미상", page: null }]],
    ["잘못된 페이지", [{ document_id: 7, doc: "공기호흡기 교육자료", page: 0 }]],
    [
      "허용 개수 초과",
      Array.from({ length: 81 }, (_, index) => ({
        document_id: index + 1,
        doc: `교육자료 ${index + 1}`,
        page: 1,
      })),
    ],
  ])("%s 요청은 불완전한 근거 목록을 조용히 버리지 않고 422로 차단한다", async (_label, sources) => {
    const response = await POST(
      requestWith({
        title: "공기호흡기 착용 교안",
        sections: [{ heading: "학습목표", content: "장비 상태를 확인한다." }],
        sources,
      })
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "source_provenance_invalid",
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

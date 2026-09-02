import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  requireApiUser: vi.fn(),
  rateLimit: vi.fn(),
  tooManyRequests: vi.fn(),
  availableModels: vi.fn(),
  createGenerationWorkerClient: vi.fn(),
  dispatchGenerationJob: vi.fn(),
  markGenerationDispatchFailed: vi.fn(),
  recoverStalledGenerationDispatch: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/demo-flag", () => ({ DEMO: false }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/auth", () => ({ requireApiUser: mocks.requireApiUser }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
  tooManyRequests: mocks.tooManyRequests,
}));
vi.mock("@/lib/llm", () => ({ availableModels: mocks.availableModels }));
vi.mock("@/lib/supabase/generation-worker", () => ({
  createGenerationWorkerClient: mocks.createGenerationWorkerClient,
}));
vi.mock("@/lib/generation-job-dispatch", () => ({
  GENERATION_DISPATCH_LEASE_MS: 60_000,
  dispatchGenerationJob: mocks.dispatchGenerationJob,
  markGenerationDispatchFailed: mocks.markGenerationDispatchFailed,
  recoverStalledGenerationDispatch: mocks.recoverStalledGenerationDispatch,
}));

import { POST, maxDuration } from "@/app/api/generate/jobs/route";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_REQUEST_ID = "22222222-2222-4222-8222-222222222222";

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    type: "slides",
    category: "화재",
    audience: "일반 대원",
    duration: "2시간",
    topic: "고층건물 화재 대응",
    jobId: JOB_ID,
    clientRequestId: CLIENT_REQUEST_ID,
    ...overrides,
  };
}

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    status: "queued",
    stage: "정밀 생성 작업을 준비하는 중",
    progress: 0,
    attempt: 0,
    estimated_seconds: 960,
    quality_passed: false,
    request: {
      type: "slides",
      category: "화재",
      audience: "일반 대원",
      duration: "2시간",
      topic: "고층건물 화재 대응",
      model: "gemini-pro",
    },
    result: null,
    error_message: null,
    workflow_run_id: null,
    revision: 1,
    created_at: "2026-09-02T01:00:00.000Z",
    started_at: null,
    updated_at: "2026-09-02T01:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

function findClient(data: ReturnType<typeof jobRow> | null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data, error: null });
  const eqs: Array<[string, unknown]> = [];
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((column: string, value: unknown) => {
      eqs.push([column, value]);
      return builder;
    }),
    in: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    maybeSingle,
  };
  return { from: vi.fn(() => builder), eqs };
}

function insertClient(data: ReturnType<typeof jobRow>) {
  const single = vi.fn().mockResolvedValue({ data, error: null });
  const select = vi.fn(() => ({ single }));
  const insert = vi.fn(() => ({ select }));
  return { from: vi.fn(() => ({ insert })), insert };
}

function insertErrorClient(error: { code: string; message: string }) {
  const single = vi.fn().mockResolvedValue({ data: null, error });
  const select = vi.fn(() => ({ single }));
  const insert = vi.fn(() => ({ select }));
  return { from: vi.fn(() => ({ insert })), insert };
}

function requestWith(body: unknown): Request {
  return new Request("http://localhost/api/generate/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/generate/jobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockResolvedValue({ name: "user-client" });
    mocks.requireApiUser.mockResolvedValue({ ok: true, user: { id: "user-1" } });
    mocks.rateLimit.mockReturnValue({ ok: true, retryAfterSec: 0 });
    mocks.tooManyRequests.mockReturnValue(
      new Response("Too Many Requests", { status: 429 })
    );
    mocks.availableModels.mockReturnValue([
      { key: "gemini-flash", label: "빠른 모델" },
      { key: "gemini-pro", label: "정밀 모델" },
    ]);
  });

  it("접수·Workflow 연결·실패 기록의 합산 deadline보다 긴 route 예산을 둔다", () => {
    expect(maxDuration).toBe(100);
  });

  it("인증 실패 시 요청 본문이나 worker를 건드리지 않는다", async () => {
    mocks.requireApiUser.mockResolvedValue({
      ok: false,
      response: new Response("Unauthorized", { status: 401 }),
    });

    const response = await POST(requestWith("{"));

    expect(response.status).toBe(401);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.createGenerationWorkerClient).not.toHaveBeenCalled();
    expect(mocks.dispatchGenerationJob).not.toHaveBeenCalled();
  });

  it("유효하지 않은 입력은 작업을 저장하거나 실행하지 않고 400으로 거절한다", async () => {
    const response = await POST(
      requestWith(validBody({ topic: ["고층건물", "화재"] }))
    );

    expect(response.status).toBe(400);
    expect(mocks.createGenerationWorkerClient).not.toHaveBeenCalled();
    expect(mocks.dispatchGenerationJob).not.toHaveBeenCalled();
  });

  it("유효하지 않은 클라이언트 작업 ID는 접수 전에 400으로 거절한다", async () => {
    const response = await POST(requestWith(validBody({ jobId: "not-a-uuid" })));

    expect(response.status).toBe(400);
    expect(mocks.createGenerationWorkerClient).not.toHaveBeenCalled();
    expect(mocks.dispatchGenerationJob).not.toHaveBeenCalled();
  });

  it("클라이언트가 빠른 모델을 보내도 설정된 정밀 모델을 우선해 원장에 저장한다", async () => {
    const find = findClient(null);
    const inserted = jobRow();
    const insert = insertClient(inserted);
    mocks.createGenerationWorkerClient
      .mockReturnValueOnce(find)
      .mockReturnValueOnce(insert);
    mocks.dispatchGenerationJob.mockResolvedValue({
      ...inserted,
      workflow_run_id: "workflow-run-1",
    });

    const response = await POST(
      requestWith(validBody({ model: "gemini-flash" }))
    );
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(insert.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: JOB_ID,
        user_id: "user-1",
        client_request_id: CLIENT_REQUEST_ID,
        request: expect.objectContaining({ model: "gemini-pro" }),
        checkpoint: {
          version: 1,
          modelCandidates: ["gemini-pro"],
          activeModelIndex: 0,
        },
      })
    );
    const runToken = insert.insert.mock.calls[0]?.[0]?.run_token;
    expect(runToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(mocks.dispatchGenerationJob).toHaveBeenCalledWith(JOB_ID, runToken);
    expect(payload.job.request.model).toBe("gemini-pro");
    expect(payload.job.workflowRunId).toBe("workflow-run-1");
    expect(payload.job).not.toHaveProperty("runToken");
    expect(payload.job).not.toHaveProperty("checkpoint");
  });

  it("두 정밀 제공자가 설정되면 Gemini Pro 다음 Claude 순서로 복구 후보를 저장한다", async () => {
    mocks.availableModels.mockReturnValue([
      { key: "gemini-flash", label: "빠른 모델" },
      { key: "claude-sonnet-4-5", label: "심층 모델" },
      { key: "gemini-pro", label: "정밀 모델" },
    ]);
    const inserted = jobRow();
    const insert = insertClient(inserted);
    mocks.createGenerationWorkerClient
      .mockReturnValueOnce(findClient(null))
      .mockReturnValueOnce(insert);
    mocks.dispatchGenerationJob.mockResolvedValue(inserted);

    const response = await POST(requestWith(validBody({ model: "gemini-flash" })));

    expect(response.status).toBe(202);
    expect(insert.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ model: "gemini-pro" }),
        checkpoint: {
          version: 1,
          modelCandidates: ["gemini-pro", "claude-sonnet-4-5"],
          activeModelIndex: 0,
        },
      })
    );
  });

  it("빠른 모델만 설정된 경우 품질 우선 작업을 Flash로 낮추지 않고 503으로 거절한다", async () => {
    mocks.availableModels.mockReturnValue([
      { key: "gemini-flash", label: "빠른 모델" },
    ]);
    mocks.createGenerationWorkerClient.mockReturnValueOnce(findClient(null));

    const response = await POST(requestWith(validBody({ model: "gemini-flash" })));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.error).toContain("정밀 생성 모델");
    expect(mocks.createGenerationWorkerClient).toHaveBeenCalledOnce();
    expect(mocks.dispatchGenerationJob).not.toHaveBeenCalled();
  });

  it("Workflow는 시작됐지만 추적 ID 저장이 지연되면 queued 응답을 유지한다", async () => {
    const inserted = jobRow();
    mocks.createGenerationWorkerClient
      .mockReturnValueOnce(findClient(null))
      .mockReturnValueOnce(insertClient(inserted));
    mocks.dispatchGenerationJob.mockResolvedValue(null);

    const response = await POST(requestWith(validBody()));
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload.job.status).toBe("queued");
    expect(payload.job.workflowRunId).toBeNull();
    expect(mocks.markGenerationDispatchFailed).not.toHaveBeenCalled();
  });

  it("같은 clientRequestId 재요청은 기존 작업을 반환하고 중복 저장·실행하지 않는다", async () => {
    const inserted = jobRow();
    const firstFind = findClient(null);
    const insert = insertClient(inserted);
    const duplicateFind = findClient({
      ...inserted,
      workflow_run_id: "workflow-run-1",
    });
    mocks.createGenerationWorkerClient
      .mockReturnValueOnce(firstFind)
      .mockReturnValueOnce(insert)
      .mockReturnValueOnce(duplicateFind);
    mocks.dispatchGenerationJob.mockResolvedValue({
      ...inserted,
      workflow_run_id: "workflow-run-1",
    });

    const first = await POST(requestWith(validBody()));
    const second = await POST(requestWith(validBody()));
    const firstPayload = await first.json();
    const secondPayload = await second.json();

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(firstPayload.job.id).toBe(JOB_ID);
    expect(secondPayload.job.id).toBe(JOB_ID);
    expect(insert.insert).toHaveBeenCalledOnce();
    expect(mocks.dispatchGenerationJob).toHaveBeenCalledOnce();
    expect(mocks.rateLimit).toHaveBeenCalledOnce();
    expect(duplicateFind.eqs).toEqual([
      ["user_id", "user-1"],
      ["client_request_id", CLIENT_REQUEST_ID],
    ]);
  });

  it("같은 사용자의 다른 active 작업과 충돌하면 기존 작업을 409로 반환한다", async () => {
    const active = jobRow({
      id: "33333333-3333-4333-8333-333333333333",
      status: "reviewing",
      stage: "근거와 현장 절차를 검토하는 중",
      progress: 76,
      client_request_id: "44444444-4444-4444-8444-444444444444",
    });
    mocks.createGenerationWorkerClient
      .mockReturnValueOnce(findClient(null))
      .mockReturnValueOnce(
        insertErrorClient({
          code: "23505",
          message: "duplicate key value violates unique constraint",
        })
      )
      .mockReturnValueOnce(findClient(null))
      .mockReturnValueOnce(findClient(active));

    const response = await POST(
      requestWith(
        validBody({
          jobId: "55555555-5555-4555-8555-555555555555",
          clientRequestId: "66666666-6666-4666-8666-666666666666",
        })
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error).toContain("이미 진행 중인");
    expect(payload.job.id).toBe(active.id);
    expect(payload.job.status).toBe("reviewing");
    expect(mocks.dispatchGenerationJob).not.toHaveBeenCalled();
  });

  it("같은 clientRequestId의 1분 넘게 멈춘 queued 작업은 재요청에서도 자동 복구한다", async () => {
    const stalled = jobRow({
      updated_at: "2000-01-01T00:00:00.000Z",
      workflow_run_id: null,
    });
    const recovered = jobRow({
      ...stalled,
      revision: 2,
      workflow_run_id: "workflow-run-recovered",
    });
    mocks.createGenerationWorkerClient.mockReturnValueOnce(findClient(stalled));
    mocks.recoverStalledGenerationDispatch.mockResolvedValue(recovered);

    const response = await POST(requestWith(validBody()));
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(mocks.recoverStalledGenerationDispatch).toHaveBeenCalledWith(
      JOB_ID,
      "user-1",
      1,
      0,
      expect.any(String)
    );
    expect(payload.job.workflowRunId).toBe("workflow-run-recovered");
    expect(mocks.dispatchGenerationJob).not.toHaveBeenCalled();
  });

  it("Workflow 시작 실패를 저장된 failed 작업으로 반환해 재시도 경로를 남긴다", async () => {
    const inserted = jobRow();
    const failed = jobRow({
      status: "failed",
      stage: "정밀 생성 작업을 시작하지 못함",
      progress: 100,
      error_message:
        "작업 실행 연결이 일시적으로 지연되었습니다. 저장된 요청으로 다시 시도해 주세요.",
      completed_at: "2026-09-02T01:00:05.000Z",
    });
    mocks.createGenerationWorkerClient
      .mockReturnValueOnce(findClient(null))
      .mockReturnValueOnce(insertClient(inserted));
    mocks.dispatchGenerationJob.mockRejectedValue(new Error("workflow unavailable"));
    mocks.markGenerationDispatchFailed.mockResolvedValue(failed);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await POST(requestWith(validBody()));
      const payload = await response.json();
      const [, runToken] = mocks.dispatchGenerationJob.mock.calls[0] ?? [];

      expect(response.status).toBe(202);
      expect(mocks.markGenerationDispatchFailed).toHaveBeenCalledWith(JOB_ID, runToken);
      expect(payload.job.status).toBe("failed");
      expect(payload.job.progress).toBe(100);
      expect(payload.job.errorMessage).toContain("다시 시도");
      expect(payload.job.result).toBeNull();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

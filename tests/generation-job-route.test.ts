import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  requireApiUser: vi.fn(),
  rateLimit: vi.fn(),
  tooManyRequests: vi.fn(),
  createGenerationWorkerClient: vi.fn(),
  dispatchGenerationJob: vi.fn(),
  markGenerationDispatchFailed: vi.fn(),
  recoverStalledGenerationDispatch: vi.fn(),
  reconcileStalledActiveGenerationJob: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/auth", () => ({ requireApiUser: mocks.requireApiUser }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
  tooManyRequests: mocks.tooManyRequests,
}));
vi.mock("@/lib/supabase/generation-worker", () => ({
  createGenerationWorkerClient: mocks.createGenerationWorkerClient,
}));
vi.mock("@/lib/generation-job-dispatch", () => ({
  GENERATION_DISPATCH_LEASE_MS: 60_000,
  dispatchGenerationJob: mocks.dispatchGenerationJob,
  markGenerationDispatchFailed: mocks.markGenerationDispatchFailed,
  recoverStalledGenerationDispatch: mocks.recoverStalledGenerationDispatch,
}));
vi.mock("@/lib/generation-job-reconciliation", () => ({
  reconcileStalledActiveGenerationJob: mocks.reconcileStalledActiveGenerationJob,
}));

import {
  GET,
  maxDuration as statusMaxDuration,
} from "@/app/api/generate/jobs/[id]/route";
import {
  POST as RETRY,
  maxDuration as retryMaxDuration,
} from "@/app/api/generate/jobs/[id]/retry/route";
import { GENERATION_JOB_PUBLIC_COLUMNS } from "@/lib/generation-job-store";

const JOB_ID = "11111111-1111-4111-8111-111111111111";

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    status: "failed",
    stage: "정밀 생성 작업을 시작하지 못함",
    progress: 100,
    attempt: 1,
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
    result: { privateDraft: true },
    error_message: "저장된 단계에서 다시 시도해 주세요.",
    workflow_run_id: "workflow-run-old",
    revision: 7,
    created_at: "2026-09-02T01:00:00.000Z",
    started_at: "2026-09-02T01:00:01.000Z",
    updated_at: "2026-09-02T01:05:00.000Z",
    completed_at: "2026-09-02T01:05:00.000Z",
    checkpoint: { privateMarker: "worker-only" },
    run_token: "22222222-2222-4222-8222-222222222222",
    ...overrides,
  };
}

function ownerClient(data: ReturnType<typeof jobRow> | null, error: unknown = null) {
  const eqs: Array<[string, unknown]> = [];
  const maybeSingle = vi.fn().mockResolvedValue({ data, error });
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((column: string, value: unknown) => {
      eqs.push([column, value]);
      return builder;
    }),
    maybeSingle,
  };
  return { from: vi.fn(() => builder), builder, eqs };
}

function retryWorker(data: ReturnType<typeof jobRow> | null, error: unknown = null) {
  const eqs: Array<[string, unknown]> = [];
  const statuses: unknown[][] = [];
  const maybeSingle = vi.fn().mockResolvedValue({ data, error });
  const builder = {
    update: vi.fn(() => builder),
    eq: vi.fn((column: string, value: unknown) => {
      eqs.push([column, value]);
      return builder;
    }),
    in: vi.fn((_column: string, values: unknown[]) => {
      statuses.push(values);
      return builder;
    }),
    select: vi.fn(() => builder),
    maybeSingle,
  };
  return { from: vi.fn(() => builder), builder, eqs, statuses };
}

function routeContext(id = JOB_ID) {
  return { params: { id } };
}

describe("GET /api/generate/jobs/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({ ok: true, user: { id: "user-1" } });
    mocks.reconcileStalledActiveGenerationJob.mockResolvedValue(null);
  });

  it("stalled dispatch 자동 복구가 끝날 route 예산을 둔다", () => {
    expect(statusMaxDuration).toBe(100);
  });

  it("소유자 id 조건과 공개 projection으로만 작업을 조회한다", async () => {
    const completed = jobRow({
      status: "completed",
      stage: "품질 검토 완료",
      quality_passed: true,
      result: { title: "검증 완료 자료", slides: [] },
      error_message: null,
    });
    const client = ownerClient(completed);
    mocks.createClient.mockResolvedValue(client);

    const response = await GET(new Request(`http://localhost/jobs/${JOB_ID}`), routeContext());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(client.builder.select).toHaveBeenCalledWith(GENERATION_JOB_PUBLIC_COLUMNS);
    expect(client.eqs).toEqual([
      ["id", JOB_ID],
      ["user_id", "user-1"],
    ]);
    expect(payload.job.result).toEqual({ title: "검증 완료 자료", slides: [] });
    expect(payload.job).not.toHaveProperty("checkpoint");
    expect(payload.job).not.toHaveProperty("run_token");
    expect(JSON.stringify(payload)).not.toContain("worker-only");
  });

  it("소유자 조회 결과가 없으면 존재 여부를 노출하지 않고 404를 반환한다", async () => {
    const client = ownerClient(null);
    mocks.createClient.mockResolvedValue(client);

    const response = await GET(new Request(`http://localhost/jobs/${JOB_ID}`), routeContext());

    expect(response.status).toBe(404);
    expect(client.eqs).toContainEqual(["user_id", "user-1"]);
  });

  it("1분 넘게 시작 신호가 없는 queued 작업은 한 번만 자동 복구한다", async () => {
    const stalled = jobRow({
      status: "queued",
      stage: "정밀 생성 작업을 준비하는 중",
      progress: 0,
      workflow_run_id: null,
      updated_at: "2000-01-01T00:00:00.000Z",
      completed_at: null,
      error_message: null,
    });
    const recovered = jobRow({
      ...stalled,
      stage: "중단된 작업 시작 연결을 자동 복구하는 중",
      workflow_run_id: "workflow-run-recovered",
      revision: 8,
    });
    const client = ownerClient(stalled);
    mocks.createClient.mockResolvedValue(client);
    mocks.recoverStalledGenerationDispatch.mockResolvedValue(recovered);

    const response = await GET(new Request(`http://localhost/jobs/${JOB_ID}`), routeContext());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.recoverStalledGenerationDispatch).toHaveBeenCalledWith(
      JOB_ID,
      "user-1",
      7,
      1,
      expect.any(String)
    );
    expect(payload.job.workflowRunId).toBe("workflow-run-recovered");
  });

  it("최근 생성된 queued 작업은 정상 대기 상태로 두고 중복 실행하지 않는다", async () => {
    const queued = jobRow({
      status: "queued",
      progress: 0,
      workflow_run_id: null,
      updated_at: new Date().toISOString(),
      completed_at: null,
      error_message: null,
    });
    mocks.createClient.mockResolvedValue(ownerClient(queued));

    const response = await GET(new Request(`http://localhost/jobs/${JOB_ID}`), routeContext());

    expect(response.status).toBe(200);
    expect(mocks.recoverStalledGenerationDispatch).not.toHaveBeenCalled();
  });

  it("오래 멈춘 active 작업은 Workflow 실제 상태와 조정한 결과를 반환한다", async () => {
    const drafting = jobRow({
      status: "drafting",
      stage: "슬라이드 정밀 작성 중",
      progress: 45,
      updated_at: "2000-01-01T00:00:00.000Z",
      completed_at: null,
      error_message: null,
    });
    const reconciled = {
      ...drafting,
      status: "failed",
      stage: "서버 생성 실행이 종료되어 복구 대기 중",
      progress: 100,
      result: null,
      quality_passed: false,
      error_message: "보존된 단계부터 다시 시도해 주세요.",
      revision: 9,
    };
    mocks.createClient.mockResolvedValue(ownerClient(drafting));
    mocks.reconcileStalledActiveGenerationJob.mockResolvedValue(
      // route는 module이 반환하는 공개 camelCase 형식을 그대로 사용한다.
      {
        id: JOB_ID,
        status: "failed",
        stage: reconciled.stage,
        progress: 100,
        attempt: 1,
        estimatedSeconds: 960,
        qualityPassed: false,
        request: drafting.request,
        result: null,
        errorMessage: reconciled.error_message,
        workflowRunId: drafting.workflow_run_id,
        revision: 9,
        createdAt: drafting.created_at,
        startedAt: drafting.started_at,
        updatedAt: drafting.updated_at,
        completedAt: drafting.updated_at,
      }
    );

    const response = await GET(new Request(`http://localhost/jobs/${JOB_ID}`), routeContext());
    const payload = await response.json();

    expect(mocks.reconcileStalledActiveGenerationJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: JOB_ID, status: "drafting" }),
      "user-1"
    );
    expect(payload.job.status).toBe("failed");
    expect(payload.job.errorMessage).toContain("다시 시도");
  });
});

describe("POST /api/generate/jobs/:id/retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({ ok: true, user: { id: "user-1" } });
    mocks.rateLimit.mockReturnValue({ ok: true, retryAfterSec: 0 });
    mocks.tooManyRequests.mockReturnValue(
      new Response("Too Many Requests", { status: 429 })
    );
  });

  it("재시도 저장·Workflow 연결·실패 기록의 합산 deadline보다 긴 route 예산을 둔다", () => {
    expect(retryMaxDuration).toBe(100);
  });

  it("진행 중인 작업은 재시도하지 않는다", async () => {
    const client = ownerClient(jobRow({ status: "drafting", progress: 45 }));
    mocks.createClient.mockResolvedValue(client);

    const response = await RETRY(
      new Request(`http://localhost/jobs/${JOB_ID}/retry`, { method: "POST" }),
      routeContext()
    );

    expect(response.status).toBe(409);
    expect(mocks.createGenerationWorkerClient).not.toHaveBeenCalled();
    expect(mocks.dispatchGenerationJob).not.toHaveBeenCalled();
  });

  it.each(["failed", "needs_attention", "cancelled"] as const)(
    "%s 작업은 revision CAS로 queued 전환한 뒤 저장된 작업을 실행한다",
    async (status) => {
      const current = jobRow({ status, attempt: 2, revision: 7 });
      const queued = jobRow({
        status: "queued",
        stage: "저장된 단계부터 다시 준비하는 중",
        progress: 0,
        attempt: 3,
        revision: 8,
        result: null,
        error_message: null,
        workflow_run_id: null,
        completed_at: null,
      });
      const client = ownerClient(current);
      const worker = retryWorker(queued);
      mocks.createClient.mockResolvedValue(client);
      mocks.createGenerationWorkerClient.mockReturnValue(worker);
      mocks.dispatchGenerationJob.mockResolvedValue({
        ...queued,
        workflow_run_id: "workflow-run-new",
      });

      const response = await RETRY(
        new Request(`http://localhost/jobs/${JOB_ID}/retry`, { method: "POST" }),
        routeContext()
      );
      const payload = await response.json();

      expect(response.status).toBe(202);
      expect(worker.builder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "queued",
          attempt: 3,
          quality_passed: false,
          result: null,
          workflow_run_id: null,
          error_message: null,
        })
      );
      expect(worker.eqs).toEqual([
        ["id", JOB_ID],
        ["user_id", "user-1"],
        ["revision", 7],
      ]);
      expect(worker.statuses).toEqual([["failed", "needs_attention", "cancelled"]]);
      const runToken = worker.builder.update.mock.calls[0]?.[0]?.run_token;
      expect(mocks.dispatchGenerationJob).toHaveBeenCalledWith(JOB_ID, runToken);
      expect(payload.job.status).toBe("queued");
      expect(payload.job.attempt).toBe(3);
      expect(payload.job.workflowRunId).toBe("workflow-run-new");
    }
  );

  it("revision CAS가 지면 중복 Workflow를 실행하지 않고 충돌을 알린다", async () => {
    const client = ownerClient(jobRow({ status: "failed", revision: 7 }));
    const worker = retryWorker(null);
    mocks.createClient.mockResolvedValue(client);
    mocks.createGenerationWorkerClient.mockReturnValue(worker);

    const response = await RETRY(
      new Request(`http://localhost/jobs/${JOB_ID}/retry`, { method: "POST" }),
      routeContext()
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error).toContain("상태가 변경");
    expect(worker.eqs).toContainEqual(["revision", 7]);
    expect(mocks.dispatchGenerationJob).not.toHaveBeenCalled();
  });

  it("다른 active 작업 때문에 재시도 전환이 충돌하면 409로 안내한다", async () => {
    const client = ownerClient(jobRow({ status: "failed", revision: 7 }));
    const worker = retryWorker(null, {
      code: "23505",
      message: "duplicate key value violates unique constraint",
    });
    mocks.createClient.mockResolvedValue(client);
    mocks.createGenerationWorkerClient.mockReturnValue(worker);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await RETRY(
        new Request(`http://localhost/jobs/${JOB_ID}/retry`, { method: "POST" }),
        routeContext()
      );
      const payload = await response.json();

      expect(response.status).toBe(409);
      expect(payload.error).toContain("다른 품질 우선 생성 작업");
      expect(mocks.dispatchGenerationJob).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

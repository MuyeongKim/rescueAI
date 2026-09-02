import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowRunNotFoundError } from "workflow/internal/errors";

const mocks = vi.hoisted(() => ({
  createGenerationWorkerClient: vi.fn(),
  getRun: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("workflow/api", () => ({ getRun: mocks.getRun }));
vi.mock("@/lib/supabase/generation-worker", () => ({
  createGenerationWorkerClient: mocks.createGenerationWorkerClient,
}));

import { reconcileStalledActiveGenerationJob } from "@/lib/generation-job-reconciliation";
import type { PublicGenerationJob } from "@/lib/generation-job";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const RUN_TOKEN = "22222222-2222-4222-8222-222222222222";

function publicJob(overrides: Partial<PublicGenerationJob> = {}): PublicGenerationJob {
  return {
    id: JOB_ID,
    status: "drafting",
    stage: "슬라이드 정밀 작성 중",
    progress: 45,
    attempt: 0,
    estimatedSeconds: 960,
    qualityPassed: false,
    request: {
      type: "slides",
      category: "화재",
      audience: "일반 대원",
      duration: "2시간",
      topic: "고층건물 화재 대응",
      model: "gemini-pro",
    },
    result: null,
    errorMessage: null,
    workflowRunId: "workflow-run-1",
    revision: 4,
    createdAt: "2000-01-01T00:00:00.000Z",
    startedAt: "2000-01-01T00:00:01.000Z",
    updatedAt: "2000-01-01T00:10:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

function healthRow(overrides: Record<string, unknown> = {}) {
  const job = publicJob();
  return {
    id: job.id,
    user_id: "user-1",
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    attempt: job.attempt,
    estimated_seconds: job.estimatedSeconds,
    quality_passed: job.qualityPassed,
    request: job.request,
    result: null,
    error_message: null,
    workflow_run_id: job.workflowRunId,
    revision: job.revision,
    created_at: job.createdAt,
    started_at: job.startedAt,
    updated_at: job.updatedAt,
    completed_at: null,
    run_token: RUN_TOKEN,
    last_progress_at: "2000-01-01T00:10:00.000Z",
    workflow_checked_at: null,
    workflow_missing_count: 0,
    workflow_missing_since: null,
    ...overrides,
  };
}

function scriptedWorker(
  responses: Array<{ data: ReturnType<typeof healthRow> | null; error: unknown }>
) {
  const updates: Record<string, unknown>[] = [];
  const eqs: Array<[string, unknown]> = [];
  const maybeSingle = vi.fn(async () => responses.shift() ?? { data: null, error: null });
  const builder = {
    select: vi.fn(() => builder),
    update: vi.fn((values: Record<string, unknown>) => {
      updates.push(values);
      return builder;
    }),
    eq: vi.fn((column: string, value: unknown) => {
      eqs.push([column, value]);
      return builder;
    }),
    in: vi.fn(() => builder),
    lte: vi.fn(() => builder),
    is: vi.fn(() => builder),
    maybeSingle,
  };
  return { client: { from: vi.fn(() => builder) }, updates, eqs, maybeSingle };
}

describe("stalled generation Workflow 조정", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("최근 진행된 작업은 Workflow API를 조회하지 않는다", async () => {
    const result = await reconcileStalledActiveGenerationJob(
      publicJob({ updatedAt: new Date().toISOString() }),
      "user-1"
    );

    expect(result).toBeNull();
    expect(mocks.createGenerationWorkerClient).not.toHaveBeenCalled();
    expect(mocks.getRun).not.toHaveBeenCalled();
  });

  it("정상적인 장시간 모델 호출 중에는 2.5초 폴링마다 worker 조회를 만들지 않는다", async () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const result = await reconcileStalledActiveGenerationJob(
      publicJob({ updatedAt: fiveMinutesAgo }),
      "user-1"
    );

    expect(result).toBeNull();
    expect(mocks.createGenerationWorkerClient).not.toHaveBeenCalled();
    expect(mocks.getRun).not.toHaveBeenCalled();
  });

  it("오래 멈췄어도 Workflow가 running이면 active 상태를 유지한다", async () => {
    const candidate = healthRow();
    const claimed = healthRow({ revision: 5, workflow_checked_at: new Date().toISOString() });
    const worker = scriptedWorker([
      { data: candidate, error: null },
      { data: claimed, error: null },
    ]);
    mocks.createGenerationWorkerClient.mockReturnValue(worker.client);
    mocks.getRun.mockReturnValue({ status: Promise.resolve("running") });

    const result = await reconcileStalledActiveGenerationJob(publicJob(), "user-1");

    expect(result?.status).toBe("drafting");
    expect(mocks.getRun).toHaveBeenCalledWith("workflow-run-1");
    expect(worker.updates).toHaveLength(1);
    expect(worker.updates[0]).toEqual(
      expect.objectContaining({ workflow_checked_at: expect.any(String) })
    );
  });

  it("Workflow가 failed면 checkpoint 재시도가 가능한 failed 상태로 CAS 전환한다", async () => {
    const candidate = healthRow();
    const claimed = healthRow({ revision: 5, workflow_checked_at: new Date().toISOString() });
    const failed = healthRow({
      status: "failed",
      stage: "서버 생성 실행이 종료되어 복구 대기 중",
      progress: 100,
      revision: 6,
      error_message: "서버 생성 실행이 중단되었습니다. 보존된 단계부터 다시 시도해 주세요.",
      completed_at: new Date().toISOString(),
      run_token: "33333333-3333-4333-8333-333333333333",
    });
    const worker = scriptedWorker([
      { data: candidate, error: null },
      { data: claimed, error: null },
      { data: failed, error: null },
    ]);
    mocks.createGenerationWorkerClient.mockReturnValue(worker.client);
    mocks.getRun.mockReturnValue({ status: Promise.resolve("failed") });

    const result = await reconcileStalledActiveGenerationJob(publicJob(), "user-1");

    expect(result?.status).toBe("failed");
    expect(result?.errorMessage).toContain("다시 시도");
    expect(worker.updates).toHaveLength(2);
    expect(worker.updates[1]).toEqual(
      expect.objectContaining({
        status: "failed",
        progress: 100,
        result: null,
        quality_passed: false,
        run_token: expect.not.stringMatching(RUN_TOKEN),
      })
    );
    expect(worker.eqs).toContainEqual(["user_id", "user-1"]);
    expect(worker.eqs).toContainEqual(["revision", 5]);
  });

  it("Workflow 상태 조회 실패는 active 작업을 실패로 오판하지 않는다", async () => {
    const candidate = healthRow();
    const claimed = healthRow({ revision: 5, workflow_checked_at: new Date().toISOString() });
    const worker = scriptedWorker([
      { data: candidate, error: null },
      { data: claimed, error: null },
    ]);
    mocks.createGenerationWorkerClient.mockReturnValue(worker.client);
    mocks.getRun.mockReturnValue({ status: Promise.reject(new Error("404")) });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const result = await reconcileStalledActiveGenerationJob(publicJob(), "user-1");

      expect(result?.status).toBe("drafting");
      expect(worker.updates).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("Workflow 404는 한 번에 실패시키지 않고 연속 확인 횟수를 저장한다", async () => {
    const candidate = healthRow();
    const claimed = healthRow({ revision: 5, workflow_checked_at: new Date().toISOString() });
    const missingOnce = healthRow({
      revision: 6,
      workflow_checked_at: claimed.workflow_checked_at,
      workflow_missing_count: 1,
      workflow_missing_since: new Date().toISOString(),
    });
    const worker = scriptedWorker([
      { data: candidate, error: null },
      { data: claimed, error: null },
      { data: missingOnce, error: null },
    ]);
    mocks.createGenerationWorkerClient.mockReturnValue(worker.client);
    mocks.getRun.mockReturnValue({
      status: Promise.reject(new WorkflowRunNotFoundError("workflow-run-1")),
    });

    const result = await reconcileStalledActiveGenerationJob(publicJob(), "user-1");

    expect(result?.status).toBe("drafting");
    expect(worker.updates[1]).toEqual(
      expect.objectContaining({
        workflow_missing_count: 1,
        workflow_missing_since: expect.any(String),
      })
    );
    expect(worker.updates[1]).not.toHaveProperty("status");
  });

  it("충분한 간격의 세 번째 Workflow 404에서만 재시도 가능한 failed로 전환한다", async () => {
    const missingSince = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const candidate = healthRow({
      workflow_missing_count: 2,
      workflow_missing_since: missingSince,
    });
    const claimed = healthRow({
      ...candidate,
      revision: 5,
      workflow_checked_at: new Date().toISOString(),
    });
    const failed = healthRow({
      ...claimed,
      status: "failed",
      stage: "서버 생성 실행 연결을 복구해야 함",
      progress: 100,
      revision: 6,
      workflow_missing_count: 3,
      error_message:
        "서버 생성 실행을 반복 확인했지만 찾지 못했습니다. 보존된 단계부터 다시 시도해 주세요.",
      completed_at: new Date().toISOString(),
      run_token: "33333333-3333-4333-8333-333333333333",
    });
    const worker = scriptedWorker([
      { data: candidate, error: null },
      { data: claimed, error: null },
      { data: failed, error: null },
    ]);
    mocks.createGenerationWorkerClient.mockReturnValue(worker.client);
    mocks.getRun.mockReturnValue({
      status: Promise.reject(new WorkflowRunNotFoundError("workflow-run-1")),
    });

    const result = await reconcileStalledActiveGenerationJob(publicJob(), "user-1");

    expect(result?.status).toBe("failed");
    expect(result?.errorMessage).toContain("반복 확인");
    expect(worker.updates[1]).toEqual(
      expect.objectContaining({
        status: "failed",
        progress: 100,
        workflow_missing_count: 3,
        run_token: expect.not.stringMatching(RUN_TOKEN),
      })
    );
  });
});

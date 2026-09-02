import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  createGenerationWorkerClient: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("@/workflows/generate-material", () => ({
  generateMaterialWorkflow: vi.fn(),
}));
vi.mock("@/lib/supabase/generation-worker", () => ({
  createGenerationWorkerClient: mocks.createGenerationWorkerClient,
}));

import {
  dispatchGenerationJob,
  markGenerationDispatchFailed,
  recoverStalledGenerationDispatch,
} from "@/lib/generation-job-dispatch";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const RUN_TOKEN = "22222222-2222-4222-8222-222222222222";

function updateBuilder(result: { data: unknown; error: unknown }) {
  const eqs: Array<[string, unknown]> = [];
  const isChecks: Array<[string, unknown]> = [];
  const lteChecks: Array<[string, unknown]> = [];
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const builder = {
    update: vi.fn(() => builder),
    eq: vi.fn((column: string, value: unknown) => {
      eqs.push([column, value]);
      return builder;
    }),
    is: vi.fn((column: string, value: unknown) => {
      isChecks.push([column, value]);
      return builder;
    }),
    lte: vi.fn((column: string, value: unknown) => {
      lteChecks.push([column, value]);
      return builder;
    }),
    select: vi.fn(() => builder),
    maybeSingle,
  };
  return { builder, eqs, isChecks, lteChecks };
}

function readBuilder(result: { data: unknown; error: unknown }) {
  const eqs: Array<[string, unknown]> = [];
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((column: string, value: unknown) => {
      eqs.push([column, value]);
      return builder;
    }),
    maybeSingle,
  };
  return { builder, eqs };
}

describe("generation job dispatch durability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.start.mockResolvedValue({ runId: "wrun_123" });
  });

  it("Workflow 시작 후 추적 ID 저장만 실패하면 실행 실패로 오인하지 않는다", async () => {
    const update = updateBuilder({
      data: null,
      error: { message: "temporary database error" },
    });
    mocks.createGenerationWorkerClient.mockReturnValue({
      from: vi.fn(() => update.builder),
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(dispatchGenerationJob(JOB_ID, RUN_TOKEN)).resolves.toBeNull();
      expect(mocks.start).toHaveBeenCalledOnce();
      expect(update.builder.update).toHaveBeenCalledWith({ workflow_run_id: "wrun_123" });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("Workflow 시작 연결이 응답하지 않으면 route 하드킬 전에 실패 처리 경로로 넘긴다", async () => {
    vi.useFakeTimers();
    mocks.start.mockReturnValue(new Promise(() => undefined));

    try {
      const dispatch = dispatchGenerationJob(JOB_ID, RUN_TOKEN);
      const rejection = expect(dispatch).rejects.toThrow("Workflow 시작 연결 시간 초과");
      await vi.advanceTimersByTimeAsync(30_000);

      await rejection;
      expect(mocks.createGenerationWorkerClient).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("이미 실행 중인 작업은 dispatch 실패 처리로 덮어쓰지 않는다", async () => {
    const current = {
      id: JOB_ID,
      status: "retrieving",
      workflow_run_id: "wrun_123",
    };
    const update = updateBuilder({ data: null, error: null });
    const read = readBuilder({ data: current, error: null });
    const from = vi
      .fn()
      .mockReturnValueOnce(update.builder)
      .mockReturnValueOnce(read.builder);
    mocks.createGenerationWorkerClient.mockReturnValue({ from });

    await expect(markGenerationDispatchFailed(JOB_ID, RUN_TOKEN)).resolves.toBe(current);

    expect(update.eqs).toEqual([
      ["id", JOB_ID],
      ["run_token", RUN_TOKEN],
      ["status", "queued"],
    ]);
    expect(update.isChecks).toEqual([["workflow_run_id", null]]);
    expect(read.eqs).toEqual([
      ["id", JOB_ID],
      ["run_token", RUN_TOKEN],
    ]);
  });

  it("만료된 queued 작업은 CAS로 claim한 뒤 새 실행 토큰으로 한 번만 재발행한다", async () => {
    const claimed = {
      id: JOB_ID,
      status: "queued",
      workflow_run_id: null,
    };
    const dispatched = {
      ...claimed,
      workflow_run_id: "wrun_123",
    };
    const claim = updateBuilder({ data: claimed, error: null });
    const persist = updateBuilder({ data: dispatched, error: null });
    mocks.createGenerationWorkerClient
      .mockReturnValueOnce({ from: vi.fn(() => claim.builder) })
      .mockReturnValueOnce({ from: vi.fn(() => persist.builder) });

    await expect(
      recoverStalledGenerationDispatch(
        JOB_ID,
        "user-1",
        7,
        2,
        "2026-09-02T01:00:00.000Z"
      )
    ).resolves.toBe(dispatched);

    const claimedToken = claim.builder.update.mock.calls[0]?.[0]?.run_token;
    expect(claim.builder.update).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 3 })
    );
    expect(claimedToken).toMatch(/^[0-9a-f-]{36}$/i);
    expect(claim.eqs).toEqual([
      ["id", JOB_ID],
      ["user_id", "user-1"],
      ["revision", 7],
      ["status", "queued"],
    ]);
    expect(claim.isChecks).toEqual([["workflow_run_id", null]]);
    expect(claim.lteChecks).toEqual([
      ["updated_at", "2026-09-02T01:00:00.000Z"],
    ]);
    expect(mocks.start).toHaveBeenCalledWith(expect.any(Function), [JOB_ID, claimedToken]);
  });
});

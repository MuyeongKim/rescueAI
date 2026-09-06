import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  GENERATION_JOB_STATUSES,
  durableGenerationEstimateSeconds,
  isGenerationJobDispatchConfirmed,
  isTerminalGenerationJobStatus,
  type GenerationJobStatus,
} from "@/lib/generation-job";
import {
  GENERATION_JOB_PUBLIC_COLUMNS,
  toPublicGenerationJob,
} from "@/lib/generation-job-store";

type MapperRow = Parameters<typeof toPublicGenerationJob>[0];
type WorkerRow = MapperRow & {
  checkpoint: Record<string, unknown>;
  run_token: string | null;
};

function workerRow(overrides: Partial<WorkerRow> = {}): WorkerRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    status: "reviewing",
    stage: "quality-review",
    progress: 75,
    attempt: 1,
    estimated_seconds: 960,
    quality_passed: false,
    request: {
      type: "slides",
      category: "화재",
      audience: "일반 대원",
      duration: "2시간",
      topic: "고층건물 화재 대응",
    },
    result: { slides: [{ title: "내부 검토본" }] },
    error_message: null,
    workflow_run_id: "workflow-1",
    revision: 4,
    created_at: "2026-09-02T00:00:00.000Z",
    started_at: "2026-09-02T00:00:10.000Z",
    updated_at: "2026-09-02T00:04:00.000Z",
    completed_at: null,
    checkpoint: {
      outline: ["도입", "현장 적용"],
      completedBatches: [0, 1],
      privateMarker: "checkpoint-secret",
    },
    run_token: "22222222-2222-4222-8222-222222222222",
    ...overrides,
  };
}

describe("durable generation job 순수 로직", () => {
  it.each([
    ["plan", "1시간", 420],
    ["plan", "2시간", 420],
    ["plan", "4시간", 420],
    ["lesson", "1시간", 540],
    ["lesson", "2시간", 540],
    ["lesson", "4시간", 540],
    ["slides", "1시간", 720],
    ["slides", "2시간", 960],
    ["slides", "4시간", 1200],
  ] as const)("%s %s의 최초 ETA는 %i초다", (type, duration, expected) => {
    expect(durableGenerationEstimateSeconds(type, duration)).toBe(expected);
  });

  it("완료·보완·실패·사용자 검토 대기·중단은 자동 폴링을 끝낸다", () => {
    const terminal = new Set<GenerationJobStatus>([
      "completed",
      "needs_attention",
      "failed",
      "awaiting_review",
      "cancelled",
    ]);

    for (const status of GENERATION_JOB_STATUSES) {
      expect(isTerminalGenerationJobStatus(status), status).toBe(terminal.has(status));
    }
  });

  it("Workflow 실행이 확인된 뒤에만 화면 종료 가능 상태로 판정한다", () => {
    expect(
      isGenerationJobDispatchConfirmed({ status: "queued", workflowRunId: null })
    ).toBe(false);
    expect(
      isGenerationJobDispatchConfirmed({
        status: "queued",
        workflowRunId: "workflow-run-1",
      })
    ).toBe(true);
    expect(
      isGenerationJobDispatchConfirmed({ status: "retrieving", workflowRunId: null })
    ).toBe(true);
  });

  it("worker 전용 checkpoint와 run_token을 조회 projection과 공개 객체에서 제외한다", () => {
    const publicColumns = GENERATION_JOB_PUBLIC_COLUMNS.split(",");
    expect(publicColumns).not.toContain("checkpoint");
    expect(publicColumns).not.toContain("run_token");

    const publicJob = toPublicGenerationJob(workerRow());
    expect(publicJob).not.toHaveProperty("checkpoint");
    expect(publicJob).not.toHaveProperty("run_token");
    expect(publicJob).not.toHaveProperty("runToken");
    expect(JSON.stringify(publicJob)).not.toContain("checkpoint-secret");
    expect(JSON.stringify(publicJob)).not.toContain(
      "22222222-2222-4222-8222-222222222222"
    );
  });

  it.each([
    {
      label: "completed + quality 통과",
      status: "completed",
      qualityPassed: true,
      result: { slides: [{ title: "공개 완성본" }] },
      exposed: true,
    },
    {
      label: "completed지만 quality 미통과",
      status: "completed",
      qualityPassed: false,
      result: { slides: [{ title: "미검증 결과" }] },
      exposed: false,
    },
    {
      label: "quality 값이 잘못 참인 reviewing",
      status: "reviewing",
      qualityPassed: true,
      result: { slides: [{ title: "검토 중 결과" }] },
      exposed: false,
    },
    {
      label: "completed지만 result 없음",
      status: "completed",
      qualityPassed: true,
      result: null,
      exposed: false,
    },
    {
      label: "completed + quality라도 객체가 아닌 result",
      status: "completed",
      qualityPassed: true,
      result: "invalid-result",
      exposed: false,
    },
  ])("$label일 때 result 공개=$exposed", ({ status, qualityPassed, result, exposed }) => {
    const publicJob = toPublicGenerationJob(
      workerRow({ status, quality_passed: qualityPassed, result })
    );

    if (exposed) {
      expect(publicJob.result).toEqual(result);
    } else {
      expect(publicJob.result).toBeNull();
    }
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  listMyMaterials: vi.fn(),
  generateForm: vi.fn(() => null),
}));

vi.mock("@/lib/demo", () => ({ DEMO: false, demoDocuments: [] }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/generation-job-store", () => ({
  GENERATION_JOB_PUBLIC_COLUMNS:
    "id,status,stage,progress,attempt,estimated_seconds,quality_passed,request,result,error_message,workflow_run_id,revision,created_at,started_at,updated_at,completed_at",
  toPublicGenerationJob: vi.fn((row: Record<string, unknown>) => ({
    id: row.id,
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    attempt: row.attempt,
    estimatedSeconds: row.estimated_seconds,
    qualityPassed: row.quality_passed,
    request: row.request,
    result: row.result,
    errorMessage: row.error_message,
    workflowRunId: row.workflow_run_id,
    revision: row.revision,
    createdAt: row.created_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  })),
}));
vi.mock("@/lib/generated-materials", () => ({
  listMyMaterials: mocks.listMyMaterials,
}));
vi.mock("@/lib/rag-external", () => ({
  ragTableEnabled: () => false,
  listExternalRagCategories: vi.fn(),
}));
vi.mock("@/lib/courses", () => ({ COURSE_CATEGORIES: ["산악"] }));
vi.mock("@/lib/llm", () => ({ availableModels: () => [] }));
vi.mock("@/components/generate/GenerateForm", () => ({
  GenerateForm: mocks.generateForm,
}));
vi.mock("@/components/generate/SavedList", () => ({ SavedList: () => null }));
vi.mock("@/lib/generation-drafts-server", () => ({ listMyGenerationDrafts: vi.fn(async () => []), loadMyGenerationDraft: vi.fn(async () => undefined) }));
vi.mock("@/lib/generation-recovery", () => ({ listMyGenerationJobs: vi.fn(async () => []) }));
vi.mock("@/components/generate/GenerationRecoveryList", () => ({ GenerationRecoveryList: () => null }));
vi.mock("@/components/layout/OperationalHeader", () => ({
  OperationalHeader: () => null,
}));

import GeneratePage from "@/app/generate/page";

function makeDocumentsClient() {
  return {
    from: vi.fn(() => ({
      select: vi.fn().mockResolvedValue({
        data: [{ title: "산악구조 교범", category: "산악" }],
        error: null,
      }),
    })),
  };
}

function makeMaterialClient(userId: string | null = "user-1") {
  const eqs: Array<[string, unknown]> = [];
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((column: string, value: unknown) => {
      eqs.push([column, value]);
      return builder;
    }),
    maybeSingle: vi.fn().mockResolvedValue({
      data: { id: 17, kind: "plan", title: "산악구조 훈련계획", content: {} },
      error: null,
    }),
  };

  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: userId ? { id: userId } : null },
      }),
    },
    from: vi.fn(() => builder),
    eqs,
  };
}

function makeGenerationJobClient(userId: string | null = "user-1") {
  const eqs: Array<[string, unknown]> = [];
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((column: string, value: unknown) => {
      eqs.push([column, value]);
      return builder;
    }),
    maybeSingle: vi.fn().mockResolvedValue({
      data: {
        id: "019cbe63-acde-7000-8000-000000000001",
        status: "drafting",
        stage: "현장형 초안 작성",
        progress: 42,
        attempt: 1,
        estimated_seconds: 720,
        quality_passed: false,
        request: {
          type: "slides",
          category: "산악",
          audience: "일반 대원",
          duration: "1시간",
          topic: "로프 하강과 확보",
        },
        result: null,
        error_message: null,
        workflow_run_id: "run-1",
        revision: 2,
        created_at: "2026-09-02T01:00:00.000Z",
        started_at: "2026-09-02T01:00:01.000Z",
        updated_at: "2026-09-02T01:02:00.000Z",
        completed_at: null,
      },
      error: null,
    }),
  };

  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: userId ? { id: userId } : null },
      }),
    },
    from: vi.fn(() => builder),
    eqs,
  };
}

function makeMissingGenerationJobClient(userId: string | null = "user-1") {
  const eqs: Array<[string, unknown]> = [];
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((column: string, value: unknown) => {
      eqs.push([column, value]);
      return builder;
    }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
  };

  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: userId ? { id: userId } : null },
      }),
    },
    from: vi.fn(() => builder),
    eqs,
  };
}

describe("생성 자료 재편집 소유자 제한", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listMyMaterials.mockResolvedValue([]);
  });

  it("자료 id와 인증 user_id를 함께 조회 조건으로 사용한다", async () => {
    const materialClient = makeMaterialClient();
    mocks.createClient
      .mockResolvedValueOnce(makeDocumentsClient())
      .mockResolvedValueOnce(materialClient);

    await GeneratePage({ searchParams: { m: "17" } });

    expect(materialClient.auth.getUser).toHaveBeenCalledOnce();
    expect(materialClient.eqs).toEqual([
      ["id", 17],
      ["user_id", "user-1"],
    ]);
    expect(mocks.listMyMaterials).not.toHaveBeenCalled();
  });

  it("인증 사용자가 없으면 id 조회를 실행하지 않는다", async () => {
    const materialClient = makeMaterialClient(null);
    mocks.createClient
      .mockResolvedValueOnce(makeDocumentsClient())
      .mockResolvedValueOnce(materialClient);

    await GeneratePage({ searchParams: { m: "17" } });

    expect(materialClient.from).not.toHaveBeenCalled();
    expect(mocks.listMyMaterials).toHaveBeenCalledWith(5);
  });

  it("영속 생성 작업도 UUID와 인증 user_id를 함께 조회 조건으로 사용한다", async () => {
    const jobClient = makeGenerationJobClient();
    mocks.createClient
      .mockResolvedValueOnce(makeDocumentsClient())
      .mockResolvedValueOnce(jobClient);

    await GeneratePage({
      searchParams: { j: "019cbe63-acde-7000-8000-000000000001" },
    });

    expect(jobClient.auth.getUser).toHaveBeenCalledOnce();
    expect(jobClient.eqs).toEqual([
      ["id", "019cbe63-acde-7000-8000-000000000001"],
      ["user_id", "user-1"],
    ]);
    expect(mocks.listMyMaterials).not.toHaveBeenCalled();
  });

  it("접수 직후 행이 아직 보이지 않아도 URL 작업 ID를 폼에 넘겨 폴링으로 복구한다", async () => {
    const jobId = "019cbe63-acde-7000-8000-000000000001";
    const jobClient = makeMissingGenerationJobClient();
    mocks.createClient
      .mockResolvedValueOnce(makeDocumentsClient())
      .mockResolvedValueOnce(jobClient);

    const page = await GeneratePage({ searchParams: { j: jobId } });
    renderToStaticMarkup(page);

    expect(jobClient.eqs).toEqual([
      ["id", jobId],
      ["user_id", "user-1"],
    ]);
    expect(mocks.generateForm).toHaveBeenCalledWith(
      expect.objectContaining({
        initialJob: undefined,
        pendingJobId: jobId,
        durableGenerationEnabled: true,
      }),
      expect.anything()
    );
    expect(mocks.listMyMaterials).not.toHaveBeenCalled();
  });
});

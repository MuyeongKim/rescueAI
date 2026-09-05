// 실제 workflow의 목차 보완 제어 흐름을 검증한다. 모델은 mock이며 원문 적용 타당성 평가는 별도다.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  worker: vi.fn(), generateObject: vi.fn(), supplement: vi.fn(), fetchCategory: vi.fn(),
}));
vi.mock("ai", () => ({ generateObject: mocks.generateObject }));
vi.mock("workflow", () => ({
  FatalError: class FatalError extends Error {},
  RetryableError: class RetryableError extends Error {},
  getStepMetadata: () => ({ attempt: 1 }),
  getWorkflowMetadata: () => ({ workflowRunId: "test-workflow" }),
}));
vi.mock("@/lib/supabase/generation-worker", () => ({ createGenerationWorkerClient: mocks.worker }));
vi.mock("@/lib/generate-context", () => ({
  fetchCategoryContext: mocks.fetchCategory, supplementGenerationContext: mocks.supplement,
}));
vi.mock("@/lib/generation-grounding-review", () => ({ reviewGenerationGrounding: vi.fn().mockResolvedValue({ ok: true, issues: [] }) }));
vi.mock("@/lib/llm", () => ({ getChatModel: () => "test-model" }));

import { generateMaterialWorkflow } from "@/workflows/generate-material";
import { generateRequestSchema } from "@/lib/generation-request";
import type { GenerationContext } from "@/lib/generate-context";
import type { OutlineEvidenceRequirement } from "@/lib/generation-evidence-coverage";
import { slideCountRangeFor, TRAINING_PLAN_SECTIONS, type GeneratedSlide } from "@/lib/generate";

const jobId = "10000000-0000-4000-8000-000000000001";
const runToken = "20000000-0000-4000-8000-000000000002";
const label = "[공기호흡기 교범 p.1]";
const newLabel = "[공기호흡기 교범 p.2]";
const excerpt = "교육 전 공기호흡기의 외관과 결합부 손상 여부를 확인한다.";
const additionalExcerpt = "경고음이 발생하면 작업을 중단하고 즉시 안전구역으로 이동한다.";
const anchored = { requirement: "공기호흡기 사용 전 점검", sourceRef: label, excerpt };
const request = generateRequestSchema.parse({
  type: "plan", category: "화재", audience: "일반 대원", duration: "1시간",
  topic: "공기호흡기 점검", model: "gemini-pro",
});
type OutlineItem = {
  heading: string; purpose: string; keyPoints: string[]; sourceRefs: string[];
  evidenceRequirements?: OutlineEvidenceRequirement[]; minutes: number | null;
};
type Checkpoint = {
  version: 1; context: GenerationContext;
  documentOutline: { title: string; sections: OutlineItem[] };
  draft: { title: string; sections: Array<{ heading: string; content: string }> };
  outline?: { title: string; slides: Array<{
    title: string; purpose: string; role: "concept"; composition: "list";
    sourceRefs: string[]; sopTarget: boolean; evidenceRequirements: OutlineEvidenceRequirement[];
  }> };
  slides?: GeneratedSlide[];
  outlineEvidence?: { queries: string[]; completedQueries: string[]; addedContext: boolean; reviewed: boolean };
};
type Job = {
  id: string; run_token: string; workflow_run_id: string; started_at: string;
  status: string; stage: string; progress: number; revision: number;
  request: typeof request; checkpoint: Checkpoint; [key: string]: unknown;
};
let job: Job;
let draftPrompt: string;
let draftSystem: string;

function worker() {
  return { from(table: string) {
    expect(table).toBe("generation_jobs");
    const filters: Array<(candidate: Job) => boolean> = [];
    let patch: Record<string, unknown> | undefined;
    const builder = {
      select: () => builder,
      eq: (key: string, value: unknown) => { filters.push(candidate => candidate[key] === value); return builder; },
      in: (key: string, values: unknown[]) => { filters.push(candidate => values.includes(candidate[key])); return builder; },
      update: (values: Record<string, unknown>) => { patch = values; return builder; },
      maybeSingle: async () => {
        if (!filters.every(filter => filter(job))) return { data: null, error: null };
        if (patch) job = { ...job, ...structuredClone(patch), revision: job.revision + 1 } as Job;
        return { data: structuredClone(job), error: null };
      },
    };
    return builder;
  } };
}

beforeEach(() => {
  vi.clearAllMocks(); draftPrompt = ""; draftSystem = "";
  const source = { document_id: 1, doc: "공기호흡기 교범", page: 1 };
  job = {
    id: jobId, run_token: runToken, workflow_run_id: "test-workflow", started_at: "2026-09-05T00:00:00.000Z",
    status: "drafting", stage: "목차 저장 완료", progress: 28, revision: 1, request,
    checkpoint: {
      version: 1,
      context: { contextText: `${label}\n${excerpt}`, sources: [source], bindingSources: [source],
        degraded: false, sopEvidence: { status: "not_found", sourceLabels: [] } },
      documentOutline: { title: "공기호흡기 점검 훈련", sections: [
        { heading: "훈련목표", purpose: "공기호흡기 점검 항목을 정확히 확인한다", keyPoints: ["점검", "손상"], sourceRefs: [label], evidenceRequirements: [anchored], minutes: null },
        { heading: "훈련내용", purpose: "공기호흡기 이상 발생 시 대응한다", keyPoints: ["경고음", "대응"], sourceRefs: [label], evidenceRequirements: [], minutes: 60 },
      ] },
      draft: { title: "공기호흡기 점검 훈련", sections: [] },
    },
  };
  mocks.worker.mockReturnValue(worker());
  mocks.supplement.mockImplementation(async (context: GenerationContext) => ({
    ...context,
    contextText: `${context.contextText}\n\n---\n\n${newLabel}\n${additionalExcerpt}`,
    bindingSources: [...context.bindingSources, { document_id: 1, doc: "공기호흡기 교범", page: 2 }],
  }));
  mocks.generateObject.mockImplementation(async ({ schema, prompt, system }) => {
    if (schema.shape.bindings) return { object: { bindings: [{
      itemIndex: 1, requirementIndex: 0, sourceRef: newLabel, excerpt: additionalExcerpt,
    }] } };
    draftPrompt = prompt; draftSystem = system;
    // 본문 생성 직전 입력까지 관찰하고 멈춘다. 최종 품질 검증은 별도 workflow 테스트가 담당한다.
    throw new Error("stop after observing draft inputs");
  });
});

function addMissing(...requirements: string[]) {
  job.checkpoint.documentOutline.sections[1].evidenceRequirements = requirements.map((requirement) => ({
    requirement, sourceRef: null, excerpt: null,
  }));
}

describe("목차 생성 뒤 부족 근거만 보완하는 영속 workflow", () => {
  it("모든 원문 연결이 있으면 검색과 연결 검토 모델 호출을 추가하지 않는다", async () => {
    await generateMaterialWorkflow(jobId, runToken);
    expect(mocks.supplement).not.toHaveBeenCalled();
    expect(mocks.generateObject).toHaveBeenCalledOnce(); // 관찰용 본문 호출만
    expect(job.checkpoint.outlineEvidence).toEqual({ queries: [], completedQueries: [], addedContext: false, reviewed: true });
    expect(draftPrompt).not.toContain("[이번 묶음에서 원문 연결을 확인하지 못한 요구사항]");
  });

  it("세 부족 조건에도 검색은 최대 두 회이며 새로 연결된 원문만 작성 문맥에 추가한다", async () => {
    addMissing("저압 경고음 발생 시 대응", "공기 누설 확인", "결합부 교체 조건");
    await generateMaterialWorkflow(jobId, runToken);
    expect(mocks.supplement).toHaveBeenCalledTimes(2);
    expect(mocks.supplement.mock.calls.every((call) => call[1] === "화재")).toBe(true);
    expect(mocks.generateObject).toHaveBeenCalledTimes(2); // 연결 검토 1 + 본문 1
    expect(job.checkpoint.outlineEvidence?.completedQueries).toHaveLength(2);
    expect(job.checkpoint.outlineEvidence?.reviewed).toBe(true);
    expect(job.checkpoint.documentOutline.sections[1].sourceRefs).toContain(newLabel);
    expect(draftSystem).toContain(additionalExcerpt);
    expect(draftPrompt).toContain("공기 누설 확인");
    expect(draftPrompt).toContain("결합부 교체 조건");
    expect(draftPrompt).toContain("추정해 채우지 말고");
  });

  it("체크포인트에 완료된 검색과 연결 검토는 재시작 때 반복하지 않는다", async () => {
    addMissing("저압 경고음 발생 시 대응");
    job.checkpoint.outlineEvidence = {
      queries: ["저압 경고음 발생 시 대응 공기호흡기 점검"],
      completedQueries: ["저압 경고음 발생 시 대응 공기호흡기 점검"], addedContext: true, reviewed: true,
    };
    await generateMaterialWorkflow(jobId, runToken);
    expect(mocks.supplement).not.toHaveBeenCalled();
    expect(mocks.generateObject).toHaveBeenCalledOnce();
    expect(draftPrompt).toContain("저압 경고음 발생 시 대응");
  });

  it("추가 검색 장애를 완료된 근거로 바꾸지 않고 미확인 조건과 degraded를 보존한다", async () => {
    addMissing("저압 경고음 발생 시 대응");
    mocks.supplement.mockImplementation(async (context: GenerationContext) => ({ ...context, degraded: true }));
    await generateMaterialWorkflow(jobId, runToken);
    expect(mocks.supplement).toHaveBeenCalledOnce();
    expect(mocks.generateObject).toHaveBeenCalledOnce();
    expect(job.checkpoint.context.degraded).toBe(true);
    expect(draftPrompt).toContain("자료에서 확인 필요");
    expect(job.checkpoint.documentOutline.sections[1].evidenceRequirements?.[0].sourceRef).toBeNull();
  });

  it("모델이 새 자료에 없는 인용을 반환하면 출처를 연결하지 않는다", async () => {
    addMissing("저압 경고음 발생 시 대응");
    mocks.generateObject.mockImplementation(async ({ schema, prompt }) => {
      if (schema.shape.bindings) return { object: { bindings: [{
        itemIndex: 1, requirementIndex: 0, sourceRef: newLabel, excerpt: "교범에 없는 상황에서 계속 작업해도 안전하다는 위조 문장입니다.",
      }] } };
      draftPrompt = prompt;
      throw new Error("stop after draft inputs");
    });
    await generateMaterialWorkflow(jobId, runToken);
    expect(job.checkpoint.documentOutline.sections[1].sourceRefs).not.toContain(newLabel);
    expect(draftPrompt).toContain("저압 경고음 발생 시 대응");
    expect(draftPrompt).toContain("자료에서 확인 필요");
  });

  it("이미 본문 작성을 시작한 과거 작업의 근거는 재시작 때 바꾸지 않는다", async () => {
    addMissing("저압 경고음 발생 시 대응");
    job.checkpoint.draft.sections = [{ heading: "훈련목표", content: "이미 작성된 내용" }];
    const original = job.checkpoint.context.contextText;
    await generateMaterialWorkflow(jobId, runToken);
    expect(mocks.supplement).not.toHaveBeenCalled();
    expect(job.checkpoint.context.contextText).toBe(original);
    expect(job.checkpoint.outlineEvidence).toBeUndefined();
  });

  it("문서 선택 보완에서도 미확인 목차 조건을 추정하지 말라는 안내를 유지한다", async () => {
    job.checkpoint.documentOutline.sections[0].evidenceRequirements = [{
      requirement: "교체 시점의 구체적 판단 조건", sourceRef: null, excerpt: null,
    }];
    job.checkpoint.draft.sections = TRAINING_PLAN_SECTIONS.map((heading) => ({ heading, content: "보완이 필요한 짧은 초안" }));
    await generateMaterialWorkflow(jobId, runToken);
    expect(mocks.supplement).not.toHaveBeenCalled();
    expect(draftPrompt).toContain("[이번 단계의 출력 계약]");
    expect(draftPrompt).toContain("교체 시점의 구체적 판단 조건");
    expect(draftPrompt).toContain("추정해 채우지 말고");
  });

  it("슬라이드 선택 보완에서도 미확인 목차 조건을 추정하지 말라는 안내를 유지한다", async () => {
    job.request = { ...request, type: "slides" };
    const count = slideCountRangeFor(request.duration)[1];
    job.checkpoint.outline = { title: "공기호흡기 점검", slides: Array.from({ length: count }, (_, index) => ({
      title: `장비 점검 ${index + 1}`, purpose: "공기호흡기 점검 기준을 확인한다",
      role: "concept", composition: "list", sourceRefs: [label], sopTarget: false,
      evidenceRequirements: [{ requirement: "교체 시점의 구체적 판단 조건", sourceRef: null, excerpt: null }],
    })) };
    job.checkpoint.slides = Array.from({ length: count }, (_, index) => ({
      title: `장비 점검 ${index + 1}`, bullets: ["장비를 점검한다"], notes: "보완이 필요한 짧은 초안",
      role: "concept", composition: "list", sourceRefs: [label],
    }));
    await generateMaterialWorkflow(jobId, runToken);
    expect(mocks.supplement).not.toHaveBeenCalled();
    expect(draftPrompt).toContain("자동 품질검사 항목을 해결하세요");
    expect(draftPrompt).toContain("교체 시점의 구체적 판단 조건");
    expect(draftPrompt).toContain("추정해 채우지 말고");
  });
});

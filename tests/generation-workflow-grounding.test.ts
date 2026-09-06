// 실제 workflow 제어 흐름과 품질 게이트의 회귀검사다. 모델 의미검토는 mock이므로
// 실제 생성물의 사실 정확도나 운영 환경의 Workflow 재시도 실행을 증명하지 않는다.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const mocks = vi.hoisted(() => ({
  createGenerationWorkerClient: vi.fn(), generateObject: vi.fn(),
  reviewGenerationGrounding: vi.fn(), fetchCategoryContext: vi.fn(),
}));
vi.mock("ai", () => ({ generateObject: mocks.generateObject }));
vi.mock("workflow", () => ({
  FatalError: class FatalError extends Error {},
  RetryableError: class RetryableError extends Error {},
  getStepMetadata: () => ({ attempt: 1 }),
  getWorkflowMetadata: () => ({ workflowRunId: "test-workflow" }),
}));
vi.mock("@/lib/supabase/generation-worker", () => ({ createGenerationWorkerClient: mocks.createGenerationWorkerClient }));
vi.mock("@/lib/generation-grounding-review", () => ({ reviewGenerationGrounding: mocks.reviewGenerationGrounding }));
vi.mock("@/lib/generate-context", () => ({ fetchCategoryContext: mocks.fetchCategoryContext }));
vi.mock("@/lib/llm", () => ({ getChatModel: () => "test-model" }));

import { generateMaterialWorkflow } from "@/workflows/generate-material";
import { generationTextParts } from "@/lib/generation-grounding";
import { generateRequestSchema } from "@/lib/generation-request";
import { SOP_NOT_FOUND_DISCLOSURE } from "@/lib/sop-evidence";
import { inspectCurrentGenerationQuality, type GeneratedDoc, type GeneratedDocDraft, type GeneratedSlide, type GeneratedSlideDeck, type GenerationQualityIssue } from "@/lib/generate";

const jobId = "10000000-0000-4000-8000-000000000001";
const runToken = "20000000-0000-4000-8000-000000000002";
const source = { document_id: 1, doc: "공기호흡기 교범", page: 1 };
const sourceLabel = "[공기호흡기 교범 p.1]";
const request = generateRequestSchema.parse({
  type: "plan", category: "화재", audience: "일반 대원", duration: "1시간",
  topic: "공기호흡기 점검", model: "gemini-pro",
});

function fill(text: string, length: number) {
  let result = text;
  while (result.length < length) result += ` ${text}`;
  return result;
}

function validDraft(): GeneratedDocDraft {
  return {
    title: "화재 공기호흡기 점검 일반대원 1시간 훈련계획",
    sections: [
      { heading: "훈련목표", content: fill("대원은 점검 순서를 설명하고 교관의 체크리스트에 따라 장비 상태를 빠짐없이 확인하여 기준에 맞게 수행한다.", 60) },
      { heading: "훈련내용", content:
        "[이론교육 · 10분] 교관은 각 점검 항목의 목적과 적용 조건을 설명하고 대원은 장비에서 해당 부위를 찾아 말한다. " +
        "[교관시범 · 10분] 교관은 정상 순서를 천천히 시범 보이며 각 동작의 확인 지점과 자주 놓치는 부분을 질문한다.\n" +
        "[반복실습 · 25분] 대원 행동절차:\n1) 장비 외관을 눈으로 점검하고 손상 여부를 확인한다.\n" +
        "2) 결합부를 손으로 당겨 고정 상태를 확인하고 동료에게 결과를 말한다.\n" +
        "3) 작동 상태를 확인한 뒤 수행 결과를 교관에게 보고하고 역할을 교대한다.\n" +
        "이상 시: 수행을 즉시 중단하고 교관에게 보고한 뒤 해당 항목을 교정하여 다시 점검한다. 동료는 체크리스트에 따라 즉시 피드백한다. " +
        "[종합수행 · 15분] 대원은 처음부터 끝까지 독립 수행하고 교관은 누락된 동작을 기록한 뒤 다시 수행하게 한다. " +
        fill("각 단계는 설명, 수행, 즉시 피드백이 이어지도록 진행한다.", 80) + ` ${SOP_NOT_FOUND_DISCLOSURE}` },
      { heading: "필요장비", content: fill("교육용 장비는 실습 인원별로 준비하고 사용 전 외관, 결합 상태, 작동 여부를 교관과 대원이 함께 점검한다.", 55) },
      { heading: "안전관리", content: fill("교관은 위험 구역을 통제하고 보호장비 상태를 사전에 점검한다. 이상 징후나 장비 결함이 발견되면 훈련을 즉시 중단하고 안전담당자에게 보고한 뒤 원인이 해소된 경우에만 재개한다.", 120) },
      { heading: "훈련평가", content: fill("교관은 체크리스트로 대원의 순서 준수와 각 확인 동작을 관찰한다. 모든 필수 동작을 누락 없이 정확히 수행하면 통과하며, 누락 항목은 강평 후 다시 시연하여 기준 충족 여부를 확인한다.", 110) },
    ],
  };
}

type Checkpoint = {
  version: number;
  draft: GeneratedDocDraft;
  context: {
    contextText: string;
    sources: typeof source[];
    bindingSources: typeof source[];
    sopEvidence: { status: "not_found"; sourceLabels: string[] };
    degraded: boolean;
  };
  groundingReview?: { signature: string; evidenceSignature: string; partSignatures: string[]; report: { ok: boolean; issues: GenerationQualityIssue[] } };
  completedRepairs?: string[];
  repairCandidateReviews?: Array<{ signature: string; report: { ok: boolean; issues: GenerationQualityIssue[] } }>;
  documentOutline?: { title: string; sections: Array<{ heading: string; purpose: string; keyPoints: string[]; minutes: number | null; sourceRefs: string[] }> };
  slides?: GeneratedSlide[];
  outline?: { title: string; slides: Array<{ title: string; role: string; composition: string; purpose: string; sourceRefs: string[]; sopTarget: boolean }> };
  selectedRepairIndices?: number[];
  selectedRepairRunToken?: string;
};
type Job = {
  id: string; run_token: string; workflow_run_id: string; started_at: string;
  status: string; stage: string; progress: number; revision: number;
  request: typeof request; checkpoint: Checkpoint; quality_passed: boolean;
  result: unknown; [key: string]: unknown;
};
let job: Job;
let updates: Record<string, unknown>[];
let beforeUpdate: ((patch: Record<string, unknown>) => void) | undefined;
let conflicts: number;

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
        if (patch) beforeUpdate?.(patch);
        if (!filters.every(filter => filter(job))) {
          if (patch) conflicts += 1;
          return { data: null, error: null };
        }
        if (patch) {
          updates.push(structuredClone(patch));
          job = { ...job, ...structuredClone(patch), revision: job.revision + 1 } as Job;
        }
        // 실제 SELECT처럼 스냅샷을 반환하여 오래된 revision CAS를 드러낸다.
        return { data: structuredClone(job), error: null };
      },
    };
    return builder;
  } };
}

function semanticIssue(index: number, excerpt = "검토할 주장"): GenerationQualityIssue {
  return { code: "unsupported_evidence_claim", path: `sections.${index}.content`, excerpt, message: `${index + 1}번째 섹션 주장의 적용 조건을 원문에서 확인하지 못했습니다.` };
}

function reviewedDoc(): GeneratedDoc {
  return { ...job.checkpoint.draft, sources: [source], sourceLabels: [sourceLabel], sopEvidence: job.checkpoint.context.sopEvidence };
}

function seedPassingReview() {
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  job.checkpoint.groundingReview = {
    signature: hash(JSON.stringify({ reviewPolicyVersion: 2, request, draft: job.checkpoint.draft, context: job.checkpoint.context.contextText })),
    evidenceSignature: hash(job.checkpoint.context.contextText),
    partSignatures: generationTextParts(reviewedDoc()).map(part => hash(part.text)),
    report: { ok: true, issues: [] },
  };
}

function seedSlideJob() {
  job.request = generateRequestSchema.parse({ ...request, type: "slides" });
  job.checkpoint.selectedRepairIndices = [2];
  job.checkpoint.selectedRepairRunToken = runToken;
  job.checkpoint.slides = Array.from({ length: 12 }, (_, index) => ({
    title: `${index + 1}번째 장비 상태를 확인합니다`,
    bullets: [`${index + 1}번째 점검 지점을 확인합니다`, "확인 결과를 동료에게 보고합니다"],
    notes: fill(`${index + 1}번째 시범에서 교관은 확인 위치와 흔한 실수를 설명합니다. 대원은 수행 결과를 말하고 이상이 있으면 중단하고 보고합니다.`, 165),
    layout: "concept", role: "concept", composition: "list", visual: { mode: "none" }, sourceRefs: [sourceLabel],
  }));
  job.checkpoint.outline = { title: "공기호흡기 점검", slides: job.checkpoint.slides.map(slide => ({
    title: slide.title, role: "concept", composition: "list", purpose: "점검 기준 확인", sourceRefs: [sourceLabel], sopTarget: false,
  })) };
}

beforeEach(() => {
  vi.clearAllMocks();
  updates = []; beforeUpdate = undefined; conflicts = 0;
  const draft = validDraft();
  job = {
    id: jobId, run_token: runToken, workflow_run_id: "test-workflow", started_at: "2026-09-05T00:00:00.000Z",
    status: "drafting", stage: "초안 작성 완료", progress: 68, revision: 1,
    request, quality_passed: false, result: null,
    checkpoint: { version: 1, draft, context: {
      contextText: `${sourceLabel}\n${draft.sections.map(section => section.content).join("\n")}`,
      sources: [source], bindingSources: [source], degraded: false,
      sopEvidence: { status: "not_found", sourceLabels: [] },
    } },
  };
  mocks.createGenerationWorkerClient.mockReturnValue(worker());
  mocks.reviewGenerationGrounding.mockResolvedValue({ ok: true, issues: [] });
  mocks.generateObject.mockImplementation(async ({ schema }) => {
    const heading = schema.shape.heading.value;
    return { object: job.checkpoint.draft.sections.find(section => section.heading === heading) };
  });
});

describe("실제 영속 workflow의 근거 검토·보완·완료 경로", () => {
  it("구성 검사를 통과한 체크포인트도 의미검토를 거쳐야 completed로 공개한다", async () => {
    expect(inspectCurrentGenerationQuality("plan", reviewedDoc(), request.duration)).toEqual({ ok: true, issues: [] });
    const outcome = await generateMaterialWorkflow(jobId, runToken);
    expect(outcome.status).toBe("completed");
    expect(job.quality_passed).toBe(true);
    expect(job.result).not.toBeNull();
    expect(mocks.reviewGenerationGrounding).toHaveBeenCalledOnce();
    expect(mocks.fetchCategoryContext).not.toHaveBeenCalled();
    expect(mocks.generateObject).not.toHaveBeenCalled();
    expect(job.run_token).not.toBe(runToken);
  });

  it("모델 검토가 통과해도 미해결 위조 수치 99999 MPa는 완료를 막는다", async () => {
    job.checkpoint.draft.sections[2].content += " 설정 압력은 99999 MPa이다.";
    const outcome = await generateMaterialWorkflow(jobId, runToken);
    expect(outcome.status).toBe("needs_attention");
    expect(job.quality_passed).toBe(false);
    expect(job.result).toBeNull();
    expect(job.review_draft).toMatchObject({ title: job.checkpoint.draft.title });
    expect(job.quality_issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "unsupported_technical_value", blocking: true, suggestion: expect.any(String) })]));
    expect(mocks.generateObject).toHaveBeenCalledTimes(2);
    expect(updates.some(update => update.quality_passed === true)).toBe(false);
  });

  it("서로 다른 두 섹션의 의미 오류를 같은 첫 보완 회차에서 각각 수정한다", async () => {
    job.checkpoint.draft.sections[0].content += " 첫째미확인주장";
    job.checkpoint.draft.sections[2].content += " 둘째미확인주장";
    mocks.reviewGenerationGrounding.mockImplementation(async ({ draft, partIndices }: { draft: GeneratedDoc; partIndices?: number[] }) => {
      const issues = draft.sections.flatMap((section, index) =>
        (!partIndices || partIndices.includes(index)) && section.content.includes("미확인주장") ? [semanticIssue(index)] : []);
      return { ok: issues.length === 0, issues };
    });
    mocks.generateObject.mockImplementation(async ({ schema }) => {
      const current = job.checkpoint.draft.sections.find(section => section.heading === schema.shape.heading.value)!;
      return { object: { ...current, content: current.content.replace(/ (첫째|둘째)미확인주장/g, "") } };
    });
    expect((await generateMaterialWorkflow(jobId, runToken)).status).toBe("completed");
    expect(mocks.generateObject).toHaveBeenCalledTimes(2);
    expect(job.checkpoint.completedRepairs).toEqual([
      `document:${runToken}:1:0`, `document:${runToken}:1:2`,
    ]);
    expect(mocks.reviewGenerationGrounding).toHaveBeenCalledTimes(4);
    expect(mocks.reviewGenerationGrounding.mock.calls.map(([args]) => args.partIndices))
      .toEqual([undefined, [0], [2], undefined]);
  });

  it("선택 보완은 선택 부분만 고치되 선택하지 않은 오류도 최종 완료를 막는다", async () => {
    job.checkpoint.draft.sections[0].content += " 첫째미확인주장";
    job.checkpoint.draft.sections[2].content += " 둘째미확인주장";
    job.checkpoint.selectedRepairIndices = [2];
    job.checkpoint.selectedRepairRunToken = runToken;
    mocks.reviewGenerationGrounding.mockImplementation(async ({ draft, partIndices }: { draft: GeneratedDoc; partIndices?: number[] }) => {
      const issues = draft.sections.flatMap((section, index) =>
        (!partIndices || partIndices.includes(index)) && section.content.includes("미확인주장") ? [semanticIssue(index)] : []);
      return { ok: issues.length === 0, issues };
    });
    mocks.generateObject.mockImplementation(async ({ schema }) => {
      const current = job.checkpoint.draft.sections.find((section) => section.heading === schema.shape.heading.value)!;
      return { object: { ...current, content: current.content.replace(/ (첫째|둘째)미확인주장/g, "") } };
    });
    expect((await generateMaterialWorkflow(jobId, runToken)).status).toBe("needs_attention");
    expect(mocks.generateObject).toHaveBeenCalledOnce();
    expect(job.checkpoint.draft.sections[0].content).toContain("첫째미확인주장");
    expect(job.checkpoint.draft.sections[2].content).not.toContain("둘째미확인주장");
    expect(job.result).toBeNull();
    expect(job.quality_issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: "sections.0.content", blocking: true })]));
  });

  it("같은 의미 오류를 남긴 보완안은 원문을 대체하지 않고 동일 후보의 재검토를 재사용한다", async () => {
    const original = structuredClone(job.checkpoint.draft);
    mocks.reviewGenerationGrounding.mockResolvedValue({ ok: false, issues: [semanticIssue(2)] });
    mocks.generateObject.mockImplementation(async ({ schema }) => {
      const current = job.checkpoint.draft.sections.find(section => section.heading === schema.shape.heading.value)!;
      return { object: { ...current, content: `${current.content} 표현만 바꿉니다.` } };
    });
    expect((await generateMaterialWorkflow(jobId, runToken)).status).toBe("needs_attention");
    expect(mocks.reviewGenerationGrounding).toHaveBeenCalledTimes(2);
    expect(job.checkpoint.draft).toEqual(original);
    expect(job.checkpoint.repairCandidateReviews).toHaveLength(1);
    expect(job.quality_passed).toBe(false);
    expect(job.result).toBeNull();
    expect(updates.some(update => update.quality_passed === true)).toBe(false);
  });

  it("지적된 주장을 지우면서 원문에 있는 주의사항을 없다고 만든 보완안은 기존 내용을 덮지 않는다", async () => {
    job.checkpoint.draft.sections[2].content += " 기존미확인주장";
    const original = structuredClone(job.checkpoint.draft);
    job.checkpoint.documentOutline = { title: original.title, sections: original.sections.map(section => ({
      heading: section.heading, purpose: "기존 근거 확인", keyPoints: [], minutes: null, sourceRefs: [sourceLabel],
    })) };
    const scopedEvidence = `${job.checkpoint.context.contextText}\n사용 중 이상이 있으면 작업을 중지하고 안전한 장소에서 점검합니다.`;
    job.checkpoint.context.contextText = `${scopedEvidence}\n\n---\n\n[다른 장비 교범 p.2]\n다른 장비의 정비 절차`;
    mocks.reviewGenerationGrounding.mockImplementation(async ({ draft, evidenceText, partIndices }) => {
      if (partIndices) {
        expect(partIndices).toEqual([2]);
        expect(evidenceText).toBe(scopedEvidence);
        expect(job.checkpoint.draft).toEqual(original);
        return { ok: false, issues: [semanticIssue(2, "추가 주의사항은 참고 자료에서 확인되지 않습니다")] };
      }
      expect(draft.sections[2].content).toContain("기존미확인주장");
      return { ok: false, issues: [semanticIssue(2, "기존미확인주장")] };
    });
    mocks.generateObject.mockImplementation(async () => ({ object: {
      ...original.sections[2],
      content: original.sections[2].content.replace("기존미확인주장", "추가 주의사항은 참고 자료에서 확인되지 않습니다"),
    } }));
    expect((await generateMaterialWorkflow(jobId, runToken)).status).toBe("needs_attention");
    expect(job.checkpoint.draft).toEqual(original);
    expect(mocks.reviewGenerationGrounding).toHaveBeenCalledTimes(2);
    expect(updates.some(update =>
      (update.checkpoint as Checkpoint | undefined)?.draft.sections[2].content.includes("추가 주의사항"))).toBe(false);
  });

  it("보완안 검토가 실패하면 기존 초안은 유지하고 완성본을 공개하지 않는다", async () => {
    job.checkpoint.draft.sections[2].content += " 기존미확인주장";
    const original = structuredClone(job.checkpoint.draft);
    mocks.reviewGenerationGrounding.mockImplementation(async ({ partIndices }) => {
      if (partIndices) throw new Error("candidate review unavailable");
      return { ok: false, issues: [semanticIssue(2)] };
    });
    mocks.generateObject.mockResolvedValue({ object: {
      ...original.sections[2], content: original.sections[2].content.replace("기존미확인주장", "새로운 보완 내용"),
    } });
    expect((await generateMaterialWorkflow(jobId, runToken)).status).toBe("failed");
    expect(job.checkpoint.draft).toEqual(original);
    expect(job.quality_passed).toBe(false);
    expect(job.result).toBeNull();
  });

  it("의미 오류 두 개를 원문에 없는 수치 하나로 바꿔 총 오류 수를 줄여도 채택하지 않는다", async () => {
    job.checkpoint.draft.sections[2].content += " 첫미확인주장 둘째미확인주장";
    const original = structuredClone(job.checkpoint.draft);
    mocks.reviewGenerationGrounding.mockImplementation(async ({ partIndices }) => partIndices
      ? { ok: true, issues: [] }
      : { ok: false, issues: [semanticIssue(2, "첫미확인주장"), semanticIssue(2, "둘째미확인주장")] });
    mocks.generateObject.mockResolvedValue({ object: {
      ...original.sections[2], content: original.sections[2].content.replace("첫미확인주장 둘째미확인주장", "시험 압력을 99999 MPa로 설정합니다."),
    } });
    expect((await generateMaterialWorkflow(jobId, runToken)).status).toBe("needs_attention");
    expect(job.checkpoint.draft).toEqual(original);
    expect(job.result).toBeNull();
  });

  it("첫 후보가 거절돼도 다음 회차의 다른 후보는 새 검토 후 채택한다", async () => {
    job.checkpoint.draft.sections[2].content += " 기존미확인주장";
    const original = structuredClone(job.checkpoint.draft);
    let attempt = 0;
    mocks.generateObject.mockImplementation(async () => ({ object: {
      ...original.sections[2], content: original.sections[2].content.replace("기존미확인주장", ++attempt === 1 ? "새미확인주장" : ""),
    } }));
    mocks.reviewGenerationGrounding.mockImplementation(async ({ draft, partIndices }) => {
      const issues = draft.sections.flatMap((section: GeneratedDoc["sections"][number], index: number) =>
        (!partIndices || partIndices.includes(index)) && section.content.includes("미확인주장") ? [semanticIssue(index)] : []);
      return { ok: issues.length === 0, issues };
    });
    expect((await generateMaterialWorkflow(jobId, runToken)).status).toBe("completed");
    expect(mocks.generateObject).toHaveBeenCalledTimes(2);
    expect(mocks.reviewGenerationGrounding).toHaveBeenCalledTimes(4);
    expect(job.checkpoint.draft.sections[2].content).not.toContain("미확인주장");
    expect(job.checkpoint.repairCandidateReviews).toHaveLength(2);
  });

  it("슬라이드 핵심 문장의 새 근거 오류도 저장 전에 검토하여 이전 장을 보존한다", async () => {
    seedSlideJob();
    job.checkpoint.slides![2].bullets[0] = "훈련 점검 기준을 모든 현장 진입에 적용합니다";
    const original = structuredClone(job.checkpoint.slides);
    mocks.generateObject.mockResolvedValue({ object: {
      ...original[2], bullets: ["추가 주의사항은 참고 자료에서 확인되지 않습니다", original[2].bullets[1]],
    } });
    mocks.reviewGenerationGrounding.mockImplementation(async ({ draft, partIndices }: { draft: GeneratedSlideDeck; partIndices?: number[] }) => ({
      ok: false, issues: [{ code: "unsupported_evidence_claim", path: "slides.2.bullets.0",
        excerpt: draft.slides[2].bullets[0], message: partIndices ? "원문에 있는 주의사항이 없다고 잘못 설명합니다." : "훈련의 적용 조건을 생략했습니다." }],
    }));
    expect((await generateMaterialWorkflow(jobId, runToken)).status).toBe("needs_attention");
    expect(job.checkpoint.slides).toEqual(original);
    expect(mocks.reviewGenerationGrounding.mock.calls.map(([args]) => args.partIndices)).toEqual([undefined, [2]]);
    expect(job.result).toBeNull();
  });

  it("본문이 같아도 잘못 연결된 출처를 고치면 이전 의미 오류 캐시를 버리고 보완을 채택한다", async () => {
    seedSlideJob();
    const correctedSource = { document_id: 2, doc: "정확한 장비 교범", page: 2 };
    const correctedLabel = "[정확한 장비 교범 p.2]";
    job.checkpoint.context.sources.push(correctedSource);
    job.checkpoint.context.bindingSources.push(correctedSource);
    job.checkpoint.context.contextText += `\n\n---\n\n${correctedLabel}\n3번째 점검 지점을 확인하고 결과를 동료에게 보고합니다.`;
    const original = structuredClone(job.checkpoint.slides![2]);
    const candidate = { ...original, sourceRefs: [correctedLabel] };
    mocks.generateObject.mockResolvedValue({ object: candidate });
    mocks.reviewGenerationGrounding.mockImplementation(async ({ draft, partIndices, evidenceText }: { draft: GeneratedSlideDeck; partIndices?: number[]; evidenceText: string }) => {
      if (partIndices) {
        expect(partIndices).toEqual([2]);
        expect(evidenceText).toContain(correctedLabel);
      }
      const issues = draft.slides[2].sourceRefs?.includes(correctedLabel) ? [] : [{
        code: "unsupported_evidence_claim", path: "slides.2.bullets.0",
        excerpt: original.bullets[0], message: "현재 출처는 다른 장비의 절차입니다.",
      }];
      return { ok: issues.length === 0, issues };
    });
    await generateMaterialWorkflow(jobId, runToken);
    expect(job.checkpoint.slides![2]).toEqual(candidate);
    expect(job.checkpoint.slides![2].bullets).toEqual(original.bullets);
    expect(mocks.reviewGenerationGrounding.mock.calls.map(([args]) => args.partIndices))
      .toEqual([undefined, [2], undefined]);
  });

  it("의미 검토 호출 실패는 저장된 초안을 남기고 quality_passed를 false로 종료한다", async () => {
    mocks.reviewGenerationGrounding.mockRejectedValue(new Error("review connection failed"));
    expect((await generateMaterialWorkflow(jobId, runToken)).status).toBe("failed");
    expect(job.checkpoint.draft.sections).toHaveLength(5);
    expect(job.quality_passed).toBe(false);
    expect(job.result).toBeNull();
    expect(updates.some(update => update.quality_passed === true)).toBe(false);
  });

  it("본문·근거·요청이 그대로이면 저장된 통과 검토를 재사용한다", async () => {
    seedPassingReview();
    expect((await generateMaterialWorkflow(jobId, runToken)).status).toBe("completed");
    expect(mocks.reviewGenerationGrounding).not.toHaveBeenCalled();
    expect(job.quality_passed).toBe(true);
  });

  it("이전 검토 정책의 통과 서명은 본문·근거가 같아도 새 정책으로 다시 검토한다", async () => {
    seedPassingReview();
    job.checkpoint.groundingReview!.signature = createHash("sha256").update(JSON.stringify({
      request, draft: job.checkpoint.draft, context: job.checkpoint.context.contextText,
    })).digest("hex");
    mocks.reviewGenerationGrounding.mockRejectedValue(new Error("new source-scoped review failed"));
    expect((await generateMaterialWorkflow(jobId, runToken)).status).toBe("failed");
    expect(mocks.reviewGenerationGrounding).toHaveBeenCalledOnce();
    expect(job.quality_passed).toBe(false);
    expect(job.result).toBeNull();
  });

  it("이전 후보 검토 정책의 통과 캐시도 새 보완안 검토를 생략하지 못한다", async () => {
    job.checkpoint.draft.sections[2].content += " 기존미확인주장";
    const original = structuredClone(job.checkpoint.draft);
    const candidate = { ...original.sections[2], content: original.sections[2].content.replace("기존미확인주장", "새미확인주장") };
    const candidateDoc: GeneratedDoc = {
      ...reviewedDoc(), sections: original.sections.map((section, index) => index === 2 ? candidate : section),
    };
    job.checkpoint.repairCandidateReviews = [{
      signature: createHash("sha256").update(JSON.stringify({
        version: 1, request, index: 2, part: generationTextParts(candidateDoc)[2],
        evidenceText: job.checkpoint.context.contextText, item: candidate, modelKey: request.model,
      })).digest("hex"),
      report: { ok: true, issues: [] },
    }];
    mocks.reviewGenerationGrounding.mockResolvedValue({ ok: false, issues: [semanticIssue(2)] });
    mocks.generateObject.mockResolvedValue({ object: candidate });
    expect((await generateMaterialWorkflow(jobId, runToken)).status).toBe("needs_attention");
    expect(mocks.reviewGenerationGrounding.mock.calls.map(([args]) => args.partIndices)).toEqual([undefined, [2]]);
    expect(job.checkpoint.draft).toEqual(original);
    expect(job.checkpoint.repairCandidateReviews).toHaveLength(2);
  });

  it.each(["본문", "근거", "요청"])("통과한 옛 서명 이후 %s이 바뀌면 재검토 실패를 무시하지 않는다", async (changed) => {
    seedPassingReview();
    if (changed === "본문") job.checkpoint.draft.sections[0].content += " 이후 변경된 주장입니다.";
    if (changed === "근거") job.checkpoint.context.contextText += " 이후 추가된 근거입니다.";
    if (changed === "요청") job.request = { ...request, topic: "변경된 공기호흡기 점검 조건" };
    mocks.reviewGenerationGrounding.mockRejectedValue(new Error("new review failed"));
    expect((await generateMaterialWorkflow(jobId, runToken)).status).toBe("failed");
    expect(mocks.reviewGenerationGrounding).toHaveBeenCalledOnce();
    expect(job.quality_passed).toBe(false);
  });

  it("최종 완료 CAS 직전에 내용이 바뀌면 최신 서명 검증이 완료를 막는다", async () => {
    beforeUpdate = (patch) => {
      if (patch.status !== "completed") return;
      beforeUpdate = undefined;
      job.checkpoint.draft.sections[2].content += " 새 압력은 99999 MPa이다.";
      job.revision += 1;
    };
    expect((await generateMaterialWorkflow(jobId, runToken)).status).toBe("failed");
    expect(conflicts).toBe(1);
    expect(job.quality_passed).toBe(false);
    expect(job.result).toBeNull();
    expect(updates.some(update => update.quality_passed === true)).toBe(false);
  });

  it("최종 저장 직전 사용자가 중단하면 오래된 완료 쓰기가 취소 상태를 되살리지 않는다", async () => {
    beforeUpdate = (patch) => {
      if (patch.status !== "completed") return;
      beforeUpdate = undefined;
      job.status = "cancelled";
      job.run_token = "cancelled-run-token";
      job.revision += 1;
    };
    expect((await generateMaterialWorkflow(jobId, runToken)).status).toBe("cancelled");
    expect(job.quality_passed).toBe(false);
    expect(job.result).toBeNull();
    expect(updates.some((update) => update.status === "failed" || update.status === "completed")).toBe(false);
  });
});

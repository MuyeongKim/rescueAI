import { generateObject } from "ai";
import { z } from "zod";
import { createHash } from "node:crypto";
import { generationTextParts, inspectTechnicalGrounding, mergeGroundingQuality } from "@/lib/generation-grounding";
import { reviewGenerationGrounding } from "@/lib/generation-grounding-review";
import {
  FatalError,
  getStepMetadata,
  getWorkflowMetadata,
  RetryableError,
} from "workflow";

import { createGenerationWorkerClient } from "@/lib/supabase/generation-worker";
import { withSupabaseRequestTimeout } from "@/lib/supabase/request-timeout";
import { fetchCategoryContext, supplementGenerationContext, type GenerationContext } from "@/lib/generate-context";
import {
  bindOutlineEvidence,
  hasOutlineEvidenceExcerpt,
  MAX_OUTLINE_EVIDENCE_SEARCHES,
  outlineEvidenceGaps,
  outlineEvidenceGuidance,
  outlineEvidenceRequirementsSchema,
  outlineEvidenceSearchQueries,
  type OutlineEvidenceRequirement,
} from "@/lib/generation-evidence-coverage";
import { buildFocusedTrainingQuery } from "@/lib/generate-focus";
import { generateRequestSchema, type ValidatedGenerateRequest } from "@/lib/generation-request";
import { getChatModel } from "@/lib/llm";
import { generationErrorInfo } from "@/lib/generation-model-error";
import { projectGenerationOutline, projectGenerationReviewDraft, publicGenerationQualityIssues } from "@/lib/generation-job-review";
import {
  SLIDE_COMPOSITION_TYPES,
  SLIDE_ROLE_TYPES,
  LESSON_SECTIONS,
  TRAINING_PLAN_SECTIONS,
  bindSlideVisualsToSources,
  blockingGenerationQualityIssues,
  buildGenerationRepairPrompt,
  buildGeneratePrompt,
  buildGenerateSystemPrompt,
  buildSlideRegenPrompt,
  extractSourceLabels,
  generatedDocSchemaFor,
  generationQualityMessages,
  inspectCurrentGenerationQuality,
  resolveSlideDeckMode,
  selectGenerationContextBySourceRefs,
  slideCountRangeFor,
  strictGeneratedSlideSchemaFor,
  strictGeneratedSlidesSchemaFor,
  stripDocumentInlineSourceRefs,
  stripSectionInlineSourceRefs,
  type GeneratedDoc,
  type GeneratedDocDraft,
  type GeneratedSlide,
  type GeneratedSlideDeck,
  type GeneratedSlideDeckDraft,
  type GeneratedSection,
  type GenerationQualityIssue,
  type GenerationQualityReport,
} from "@/lib/generate";
import type { Database, Json } from "@/lib/database.types";

const MODEL_CALL_MAX_MS = 235_000;
// 보완은 같은 step에서 후보의 원문 의미 검토까지 마친다. 두 모델 호출과 DB I/O가
// 300초 실행 상한을 넘지 않도록 작성 예산과 검토 예산을 따로 둔다.
const REPAIR_MODEL_CALL_MAX_MS = 180_000;
const REPAIR_REVIEW_MAX_MS = 45_000;
// 원문 범위·의미 검토 규칙이 바뀌면 이전 배포의 통과 기록도 다시 대조한다.
const GROUNDING_REVIEW_POLICY_VERSION = 2;
const RETRIEVAL_STEP_MAX_MS = 215_000;
// 모델 step은 load + 상태 저장 + 최대 235초 호출 + checkpoint 저장을 한 invocation에서
// 수행하므로 원장 I/O를 짧게 실패시켜 300초 플랫폼 상한 안에서 Workflow 재시도로 넘긴다.
const WORKER_DB_REQUEST_MAX_MS = 15_000;
const DOCUMENT_BATCH_SIZE = 2;
const SLIDE_BATCH_SIZE = 2;
const MAX_QUALITY_REPAIR_ROUNDS = 2;
const MAX_SLIDE_REPAIRS_PER_ROUND = 4;
const ACTIVE_GENERATION_JOB_STATUSES = [
  "queued",
  "retrieving",
  "drafting",
  "reviewing",
  "repairing",
] as const;
const WORKER_JOB_COLUMNS =
  "id,request,checkpoint,run_token,workflow_run_id,started_at,status,stage,progress,revision";

type SlideOutlineItem = {
  title: string;
  role: (typeof SLIDE_ROLE_TYPES)[number];
  composition: (typeof SLIDE_COMPOSITION_TYPES)[number];
  purpose: string;
  sourceRefs: string[];
  sopTarget: boolean;
  /** 새 작업은 필수. 과거 체크포인트를 이어가기 위해 읽을 때만 선택값으로 둔다. */
  actionRequirements?: string[];
  evidenceRequirements?: OutlineEvidenceRequirement[];
};

type SlideOutline = {
  title: string;
  slides: SlideOutlineItem[];
};

type DocumentOutlineItem = {
  heading: string;
  purpose: string;
  keyPoints: string[];
  minutes: number | null;
  /** 새 작업은 필수. 배포 전에 시작된 체크포인트를 이어가기 위해 읽을 때만 선택값으로 둔다. */
  sourceRefs?: string[];
  /** 해당 섹션에서 실제로 보여 줄 행동·확인·이상 대응 요구사항. */
  actionRequirements?: string[];
  evidenceRequirements?: OutlineEvidenceRequirement[];
};

type DocumentOutline = {
  title: string;
  sections: DocumentOutlineItem[];
};

type GenerationCheckpoint = {
  version: 1;
  modelCandidates?: string[];
  activeModelIndex?: number;
  context?: GenerationContext;
  documentOutline?: DocumentOutline;
  outline?: SlideOutline;
  slides?: GeneratedSlide[];
  draft?: GeneratedDocDraft;
  repaired?: boolean;
  repairAttempts?: number;
  completedRepairs?: string[];
  repairCandidateReviews?: Array<{ signature: string; report: GenerationQualityReport }>;
  groundingReview?: {
    signature: string;
    evidenceSignature: string;
    partSignatures: string[];
    report: GenerationQualityReport;
  };
  outlineEvidence?: {
    queries: string[];
    completedQueries: string[];
    addedContext: boolean;
    reviewed: boolean;
  };
  outlineApproved?: boolean;
  selectedRepairIndices?: number[];
  selectedRepairRunToken?: string;
};

function documentHeadings(type: "plan" | "lesson"): readonly string[] {
  return type === "plan" ? TRAINING_PLAN_SECTIONS : LESSON_SECTIONS;
}

function documentMinutes(
  type: "plan" | "lesson",
  duration: ValidatedGenerateRequest["duration"],
  heading: string
): number | null {
  const total = duration === "1시간" ? 60 : duration === "2시간" ? 120 : 240;
  if (type === "plan") return heading === "훈련내용" ? total : null;
  const allocations =
    total === 60
      ? [null, 5, 15, 10, 20, 5, 5]
      : total === 120
        ? [null, 10, 30, 20, 40, 10, 10]
        : [null, 20, 60, 40, 80, 20, 20];
  return allocations[LESSON_SECTIONS.indexOf(heading as (typeof LESSON_SECTIONS)[number])] ?? null;
}

type WorkerJobRow = {
  id: string;
  request: Json;
  checkpoint: Json;
  run_token: string;
  workflow_run_id: string | null;
  started_at: string | null;
  status: string;
  stage: string;
  progress: number;
  revision: number;
};

type WorkflowReview = {
  blockingIssues: number;
  totalIssues: number;
  repairIndices: number[];
};

type WorkflowResult = {
  jobId: string;
  status: "completed" | "needs_attention" | "failed" | "awaiting_review" | "cancelled";
};

type GenerationJobUpdate =
  Database["public"]["Tables"]["generation_jobs"]["Update"];

function checkpointOf(value: Json): GenerationCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { version: 1 };
  const candidate = value as unknown as Partial<GenerationCheckpoint>;
  return candidate.version === 1 ? { ...candidate, version: 1 } : { version: 1 };
}

function asJson(value: unknown): Json {
  return value as Json;
}

function safeWorkflowFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("인덱싱된 자료")) return message.slice(0, 300);
  if (message.includes("검증된 근거 출처")) return message.slice(0, 300);
  if (message.includes("근거 자료 조회")) {
    return "근거 자료 조회가 반복해서 지연되었습니다. 저장된 요청으로 다시 시도해 주세요.";
  }
  if (message.includes("정밀 모델")) {
    return "정밀 모델 호출이 반복해서 지연되었습니다. 저장된 단계부터 다시 이어갈 수 있습니다.";
  }
  return "정밀 생성 단계가 반복해서 완료되지 않았습니다. 저장된 단계부터 다시 시도해 주세요.";
}

async function withRetrievalDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new RetryableError("근거 자료 조회가 지연되어 같은 단계를 다시 시도합니다.", {
                retryAfter: "15s",
              })
            ),
          RETRIEVAL_STEP_MAX_MS
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function loadWorkerJob(jobId: string, runToken: string): Promise<WorkerJobRow> {
  const admin = createGenerationWorkerClient();
  const { data, error } = await withSupabaseRequestTimeout(
    admin
      .from("generation_jobs")
      .select(WORKER_JOB_COLUMNS)
      .eq("id", jobId)
      .eq("run_token", runToken)
      .maybeSingle(),
    WORKER_DB_REQUEST_MAX_MS
  );
  if (error) {
    throw new RetryableError(`생성 작업 조회 실패: ${error.message}`, { retryAfter: "10s" });
  }
  if (!data) throw new FatalError("이미 교체되었거나 존재하지 않는 생성 작업입니다.");
  return data as unknown as WorkerJobRow;
}

async function loadWorkerJobById(jobId: string): Promise<WorkerJobRow | null> {
  const admin = createGenerationWorkerClient();
  const { data, error } = await withSupabaseRequestTimeout(
    admin
      .from("generation_jobs")
      .select(WORKER_JOB_COLUMNS)
      .eq("id", jobId)
      .maybeSingle(),
    WORKER_DB_REQUEST_MAX_MS
  );
  if (error) {
    throw new RetryableError(`생성 작업 조회 실패: ${error.message}`, { retryAfter: "10s" });
  }
  return data ? (data as unknown as WorkerJobRow) : null;
}

function isActiveWorkerJob(row: WorkerJobRow): boolean {
  return ACTIVE_GENERATION_JOB_STATUSES.includes(
    row.status as (typeof ACTIVE_GENERATION_JOB_STATUSES)[number]
  );
}

async function updateActiveWorkerJobCas(
  row: WorkerJobRow,
  values: GenerationJobUpdate
): Promise<WorkerJobRow | null> {
  const admin = createGenerationWorkerClient();
  const { data, error } = await withSupabaseRequestTimeout(
    admin
      .from("generation_jobs")
      .update(values)
      .eq("id", row.id)
      .eq("run_token", row.run_token)
      .eq("revision", row.revision)
      .in("status", [...ACTIVE_GENERATION_JOB_STATUSES])
      .select(WORKER_JOB_COLUMNS)
      .maybeSingle(),
    WORKER_DB_REQUEST_MAX_MS
  );
  if (error) {
    throw new RetryableError(`생성 작업 저장 실패: ${error.message}`, { retryAfter: "10s" });
  }
  return data ? (data as unknown as WorkerJobRow) : null;
}

/** 같은 단계가 중복 전달되어도 진행률과 화면 문구를 이전 단계로 되돌리지 않는다. */
async function announceWorkerStage(
  row: WorkerJobRow,
  values: GenerationJobUpdate & { progress: number }
): Promise<WorkerJobRow> {
  if (!isActiveWorkerJob(row)) throw new FatalError("이미 종료된 생성 작업입니다.");
  if (
    typeof values.workflow_run_id === "string" &&
    row.workflow_run_id !== null &&
    row.workflow_run_id !== values.workflow_run_id
  ) {
    throw new FatalError("현재 실행과 다른 Workflow 식별자가 저장되어 있습니다.");
  }
  const targetProgress = Math.max(row.progress, values.progress);
  const needsWorkflowRunBackfill =
    typeof values.workflow_run_id === "string" && row.workflow_run_id === null;
  const sameVisibleStage =
    row.progress === values.progress &&
    (values.status === undefined || row.status === values.status) &&
    (values.stage === undefined || row.stage === values.stage);
  if (
    (row.progress > values.progress || sameVisibleStage) &&
    !needsWorkflowRunBackfill
  ) {
    return row;
  }

  const updateValues =
    row.progress > values.progress
      ? { workflow_run_id: values.workflow_run_id, progress: row.progress }
      : { ...values, progress: targetProgress };

  const updated = await updateActiveWorkerJobCas(row, updateValues);
  if (updated) return updated;

  const current = await loadWorkerJob(row.id, row.run_token);
  if (current.progress >= values.progress) return current;
  throw new RetryableError("다른 생성 단계의 저장이 끝나기를 기다립니다.", {
    retryAfter: "3s",
  });
}

async function advanceWorkerProgress(row: WorkerJobRow, progress: number): Promise<WorkerJobRow> {
  if (row.progress >= progress) return row;
  const updated = await updateActiveWorkerJobCas(row, { progress });
  if (updated) return updated;
  const current = await loadWorkerJob(row.id, row.run_token);
  if (current.progress >= progress) return current;
  throw new RetryableError("진행 상태 저장을 다시 시도합니다.", { retryAfter: "3s" });
}

/**
 * 체크포인트는 revision CAS로 합친다. Workflow의 at-least-once 재전달이 겹쳐도
 * 이미 저장된 뒤 단계나 다른 슬라이드를 오래된 스냅샷으로 덮지 않는다.
 */
async function saveCheckpointCas(
  initialRow: WorkerJobRow,
  satisfied: (checkpoint: GenerationCheckpoint) => boolean,
  mutate: (checkpoint: GenerationCheckpoint) => GenerationCheckpoint,
  values: Omit<GenerationJobUpdate, "checkpoint"> = {}
): Promise<WorkerJobRow> {
  let row = initialRow;
  for (let conflict = 0; conflict < 3; conflict += 1) {
    const checkpoint = checkpointOf(row.checkpoint);
    if (satisfied(checkpoint)) return row;
    const next = mutate(checkpoint);
    const requestedProgress = typeof values.progress === "number" ? values.progress : row.progress;
    const updated = await updateActiveWorkerJobCas(row, {
      ...values,
      progress: Math.max(row.progress, requestedProgress),
      checkpoint: asJson(next),
    });
    if (updated) return updated;
    row = await loadWorkerJob(row.id, row.run_token);
  }
  if (satisfied(checkpointOf(row.checkpoint))) return row;
  throw new RetryableError("동시에 저장된 생성 단계를 안전하게 합치는 중입니다.", {
    retryAfter: "3s",
  });
}

function modelCandidates(
  checkpoint: GenerationCheckpoint,
  request: ValidatedGenerateRequest
): string[] {
  const candidates = Array.from(
    new Set(
      (checkpoint.modelCandidates ?? [request.model])
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    )
  );
  return candidates.length > 0 ? candidates : request.model ? [request.model] : [];
}

function activeModelKey(
  checkpoint: GenerationCheckpoint,
  request: ValidatedGenerateRequest
): string | undefined {
  const candidates = modelCandidates(checkpoint, request);
  if (candidates.length === 0) return request.model;
  const index = Math.max(
    0,
    Math.min(candidates.length - 1, Math.floor(checkpoint.activeModelIndex ?? 0))
  );
  return candidates[index];
}

async function retryGenerationError(
  error: unknown,
  row: WorkerJobRow,
  request: ValidatedGenerateRequest
): Promise<never> {
  const info = generationErrorInfo(error);
  const checkpoint = checkpointOf(row.checkpoint);
  const candidates = modelCandidates(checkpoint, request);
  const currentIndex = Math.max(
    0,
    Math.min(candidates.length - 1, Math.floor(checkpoint.activeModelIndex ?? 0))
  );
  const metadata = getStepMetadata();
  const switchableTransient =
    (info.rateLimited ||
      info.timedOut ||
      info.serverFailure ||
      info.networkFailure ||
      info.invalidOutput) &&
    metadata.attempt >= 2;
  const shouldSwitch = info.authentication || switchableTransient;

  if (shouldSwitch && currentIndex + 1 < candidates.length) {
    const nextIndex = currentIndex + 1;
    await saveCheckpointCas(
      row,
      (current) => Math.floor(current.activeModelIndex ?? 0) >= nextIndex,
      (current) => ({ ...current, activeModelIndex: nextIndex })
    );
    throw new RetryableError(
      `정밀 모델 연결을 ${candidates[nextIndex]} 후보로 전환해 같은 단계를 이어갑니다.`,
      { retryAfter: "2s" }
    );
  }

  if (info.authentication) {
    throw new FatalError("사용 가능한 정밀 모델의 인증 또는 접근 권한을 확인해 주세요.");
  }
  if (info.rateLimited) {
    throw new RetryableError("정밀 모델 요청이 몰려 잠시 뒤 다시 시도합니다.", {
      retryAfter: "45s",
    });
  }
  if (info.timedOut) {
    throw new RetryableError("정밀 모델 응답이 늦어 같은 단계를 다시 시도합니다.", {
      retryAfter: "10s",
    });
  }
  if (info.serverFailure) {
    throw new RetryableError("정밀 모델 서비스가 안정화되면 같은 단계를 다시 시도합니다.", {
      retryAfter: "20s",
    });
  }
  if (info.networkFailure) {
    throw new RetryableError("정밀 모델 연결이 안정화되면 같은 단계를 다시 시도합니다.", {
      retryAfter: "20s",
    });
  }
  throw error;
}

function validatedRequest(row: WorkerJobRow): ValidatedGenerateRequest {
  const parsed = generateRequestSchema.safeParse(row.request);
  if (!parsed.success) throw new FatalError("저장된 생성 요청 형식이 올바르지 않습니다.");
  return parsed.data;
}

function contextFromCheckpoint(checkpoint: GenerationCheckpoint): GenerationContext {
  const context = checkpoint.context;
  if (!context?.contextText || !Array.isArray(context.bindingSources)) {
    throw new FatalError("저장된 생성 근거를 복원할 수 없습니다.");
  }
  return context;
}

function allowedSourceLabels(context: GenerationContext): string[] {
  const labels = extractSourceLabels(context.contextText);
  if (labels.length === 0) {
    throw new FatalError("자료제작에 연결할 검증된 근거 출처가 없습니다.");
  }
  return labels;
}

function documentSectionUsesSop(
  type: "plan" | "lesson",
  heading: string
): boolean {
  return type === "plan" ? heading === "훈련내용" : heading === "핵심이론";
}

function scopedGenerationContext(
  context: GenerationContext,
  sourceRefs: readonly string[],
  includeSop: boolean
): string {
  return selectGenerationContextBySourceRefs(context.contextText, [
    ...sourceRefs,
    ...(includeSop ? context.sopEvidence.sourceLabels : []),
  ]);
}

function targetSlideCount(duration: ValidatedGenerateRequest["duration"]): number {
  return slideCountRangeFor(duration)[1];
}

function outlineEvidencePrompt(): string {
  return `[목차별 근거 연결]
- evidenceRequirements에는 요청 주제와 직접 관련된 기술 내용·적용 조건 중 핵심 1~3개를 requirement로 적으세요. 일정·소개·일반 학습목표처럼 별도 기술 근거가 필요 없는 항목만 빈 배열로 둡니다.
- 해당 요구사항을 실제로 뒷받침하는 sourceRef와 그 출처의 연속된 원문 12~360자를 excerpt에 정확히 복사하세요. 출처 제목이나 다른 페이지 문장을 대신 쓰지 마세요.
- 요청에 필요한 조건을 현재 자료에서 확인하지 못하면 requirement는 남기고 sourceRef와 excerpt를 모두 null로 두세요. 부족한 근거를 확인할 기회가 있으므로, 출처가 있다는 이유만으로 조건이 맞는다고 판단하지 마세요.
- 서로 다른 상황의 원문을 합쳐 복합 상황의 새로운 기술 절차를 만들지 마세요.`;
}

function outlineItems(checkpoint: GenerationCheckpoint): Array<SlideOutlineItem | DocumentOutlineItem> {
  return checkpoint.outline?.slides ?? checkpoint.documentOutline?.sections ?? [];
}

function withEvidenceItems(
  checkpoint: GenerationCheckpoint,
  items: Array<SlideOutlineItem | DocumentOutlineItem>,
): GenerationCheckpoint {
  return checkpoint.outline
    ? { ...checkpoint, outline: { ...checkpoint.outline, slides: items as SlideOutlineItem[] } }
    : checkpoint.documentOutline
      ? { ...checkpoint, documentOutline: { ...checkpoint.documentOutline, sections: items as DocumentOutlineItem[] } }
      : checkpoint;
}

function qualityScore(report: GenerationQualityReport): readonly [number, number] {
  return [blockingGenerationQualityIssues(report).length, report.issues.length];
}

function isQualityImprovement(
  current: GenerationQualityReport,
  candidate: GenerationQualityReport
): boolean {
  const [currentBlocking, currentTotal] = qualityScore(current);
  const [candidateBlocking, candidateTotal] = qualityScore(candidate);
  return (
    candidateBlocking < currentBlocking ||
    (candidateBlocking === currentBlocking && candidateTotal < currentTotal)
  );
}

function isQualityNonRegression(
  current: GenerationQualityReport,
  candidate: GenerationQualityReport
): boolean {
  const [currentBlocking, currentTotal] = qualityScore(current);
  const [candidateBlocking, candidateTotal] = qualityScore(candidate);
  return candidateBlocking <= currentBlocking && candidateTotal <= currentTotal;
}

function hasRepairMarker(checkpoint: GenerationCheckpoint, marker: string): boolean {
  return checkpoint.completedRepairs?.includes(marker) === true;
}

function checkpointWithRepairMarker(
  checkpoint: GenerationCheckpoint,
  marker: string
): GenerationCheckpoint {
  return {
    ...checkpoint,
    completedRepairs: Array.from(new Set([...(checkpoint.completedRepairs ?? []), marker])).slice(-100),
  };
}

function operationalWarnings(context: GenerationContext, checkpoint: GenerationCheckpoint): string[] {
  const missing = Array.from(new Set(outlineEvidenceGaps(outlineItems(checkpoint), context.contextText)
    .map((gap) => gap.requirement)));
  return [
    ...(context.sopEvidence.status === "not_found"
      ? ["관련 SOP 근거 미확인 — 시행 전 최신 SOP 확인 필요"]
      : context.sopEvidence.status === "degraded"
        ? ["SOP 자료 검색 상태 확인 불가 — 시행 전 다시 확인 필요"]
        : []),
    ...(context.degraded ? ["자료 검색 일부 기능 제한 — 회수 근거 확인 필요"] : []),
    ...(missing.length > 0 ? [
      `목차의 ${missing.length}개 조건은 조회한 근거에서 추가 확인이 필요합니다: ${missing.slice(0, 2).map((item) => item.slice(0, 80)).join(" / ")}${missing.length > 2 ? " 외" : ""}`,
    ] : []),
  ];
}

function groundingSignature(request: ValidatedGenerateRequest, checkpoint: GenerationCheckpoint): string {
  return createHash("sha256").update(JSON.stringify({
    reviewPolicyVersion: GROUNDING_REVIEW_POLICY_VERSION,
    request, draft: checkpoint.draft, slides: checkpoint.slides,
    slideTitle: checkpoint.outline?.title,
    context: checkpoint.context?.contextText,
  })).digest("hex");
}

function textSignature(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function groundingPartSignatures(draft: GeneratedDoc | GeneratedSlideDeck): string[] {
  return generationTextParts(draft).map((part, index) => {
    if (!("slides" in draft)) return textSignature(part.text);
    const slide = draft.slides[index];
    return textSignature(JSON.stringify({
      text: part.text,
      sourceRefs: slide?.sourceRefs,
      visualSource: slide?.visual && {
        mode: slide.visual.mode, sourceRef: slide.visual.sourceRef,
        documentId: slide.visual.documentId, page: slide.visual.page, assetId: slide.visual.assetId,
      },
    }));
  });
}

function issuePartIndex(issue: GenerationQualityIssue): number {
  if (issue.path === "title") return 0;
  const match = /^(?:slides|sections)\.(\d+)(?:\.|$)/.exec(issue.path);
  return match ? Number(match[1]) : -1;
}

function repairPreservesBlockingChecks(
  current: GenerationQualityReport,
  candidate: GenerationQualityReport,
  index: number
): boolean {
  const prior = new Set(blockingGenerationQualityIssues(current)
    .map((issue) => JSON.stringify([issue.code, issue.path])));
  return blockingGenerationQualityIssues(candidate).every((issue) =>
    prior.has(JSON.stringify([issue.code, issue.path])) &&
    !(issue.code === "unsupported_technical_value" && issuePartIndex(issue) === index));
}

function withGroundingQuality(
  quality: GenerationQualityReport,
  draft: GeneratedDoc | GeneratedSlideDeck,
  request: ValidatedGenerateRequest,
  checkpoint: GenerationCheckpoint
): GenerationQualityReport {
  const reviewed = checkpoint.groundingReview;
  // 하나를 고친 뒤에도 아직 바뀌지 않은 다른 부분의 검토 항목은 같은 보완 회차에
  // 처리한다. 완성본 통과 여부는 아래 최종 단계에서 전체 서명을 다시 검사한다.
  const parts = generationTextParts(draft);
  const partSignatures = groundingPartSignatures(draft);
  const semanticIssues = reviewed?.signature === groundingSignature(request, checkpoint)
    ? reviewed.report.issues
    : reviewed?.evidenceSignature === textSignature(contextFromCheckpoint(checkpoint).contextText)
      ? reviewed.report.issues.filter((issue) => {
          const index = issuePartIndex(issue);
          return index >= 0 && parts[index] !== undefined &&
            reviewed.partSignatures?.[index] === partSignatures[index];
        })
      : [];
  const semantic = { ok: semanticIssues.length === 0, issues: semanticIssues };
  return mergeGroundingQuality(quality,
    inspectTechnicalGrounding(draft, contextFromCheckpoint(checkpoint).contextText, request), semantic);
}

/** 보완안은 원문 의미 검토를 통과하기 전까지 기존 초안을 대체하지 않는다. */
async function reviewRepairCandidate(
  request: ValidatedGenerateRequest,
  checkpoint: GenerationCheckpoint,
  candidate: GenerationCheckpoint,
  index: number,
  evidenceText: string
): Promise<{ signature: string; report: GenerationQualityReport }> {
  const { result } = resultWithQuality(request, candidate);
  const draft = result as unknown as GeneratedDoc | GeneratedSlideDeck;
  const part = generationTextParts(draft)[index];
  if (!part) throw new Error("보완안의 원문 검토 위치를 확인하지 못했습니다.");
  const signature = textSignature(JSON.stringify({
    reviewPolicyVersion: GROUNDING_REVIEW_POLICY_VERSION, request, index, part, title: draft.title, evidenceText,
    // 같은 문장이라도 출처·도식 연결을 바꾸면 재검토해야 한다.
    item: "slides" in draft ? draft.slides[index] : draft.sections[index],
    modelKey: activeModelKey(checkpoint, request),
  }));
  const cached = checkpoint.repairCandidateReviews?.find((review) => review.signature === signature);
  if (cached) return cached;
  const report = await reviewGenerationGrounding({
    draft, evidenceText, request, partIndices: [index],
    modelKey: activeModelKey(checkpoint, request), timeoutMs: REPAIR_REVIEW_MAX_MS,
  });
  return { signature, report };
}

function withRepairCandidateReview(
  checkpoint: GenerationCheckpoint,
  review: { signature: string; report: GenerationQualityReport }
): GenerationCheckpoint {
  return {
    ...checkpoint,
    repairCandidateReviews: [
      ...(checkpoint.repairCandidateReviews ?? []).filter((item) => item.signature !== review.signature),
      review,
    ].slice(-8),
  };
}

function resultWithQuality(
  request: ValidatedGenerateRequest,
  checkpoint: GenerationCheckpoint
): { result: Record<string, unknown>; report: GenerationQualityReport } {
  const context = contextFromCheckpoint(checkpoint);
  const labels = extractSourceLabels(context.contextText);
  const repaired = checkpoint.repaired === true;
  if (request.type === "slides") {
    if (!checkpoint.outline || checkpoint.slides?.length !== checkpoint.outline.slides.length) {
      throw new FatalError("슬라이드 묶음이 모두 저장되지 않았습니다.");
    }
    const raw: GeneratedSlideDeckDraft = {
      title: checkpoint.outline.title,
      mode: resolveSlideDeckMode(request.slideMode),
      slides: checkpoint.slides,
    };
    const strict = strictGeneratedSlidesSchemaFor(allowedSourceLabels(context)).safeParse(raw);
    if (!strict.success) throw new Error("저장된 슬라이드 묶음의 구조가 올바르지 않습니다.");
    const bound = bindSlideVisualsToSources(strict.data, context.bindingSources);
    const deck: GeneratedSlideDeck = {
      ...bound,
      sources: context.bindingSources,
      sourceLabels: labels,
      sopEvidence: context.sopEvidence,
    };
    const report = withGroundingQuality(inspectCurrentGenerationQuality("slides", deck, request.duration), deck, request, checkpoint);
    const messages = generationQualityMessages(report, operationalWarnings(context, checkpoint));
    return {
      result: {
        ...deck,
        quality: { checked: true, repaired, ...messages, issues: report.issues },
      },
      report,
    };
  }

  const parsed = generatedDocSchemaFor(request.type).safeParse(checkpoint.draft);
  if (!parsed.success) throw new Error("저장된 문서 초안의 구조가 올바르지 않습니다.");
  const cleaned = stripDocumentInlineSourceRefs(parsed.data, labels);
  const doc: GeneratedDoc = {
    ...cleaned,
    sources: context.bindingSources,
    sourceLabels: labels,
    sopEvidence: context.sopEvidence,
  };
  const report = withGroundingQuality(inspectCurrentGenerationQuality(request.type, doc, request.duration), doc, request, checkpoint);
  const messages = generationQualityMessages(report, operationalWarnings(context, checkpoint));
  return {
    result: {
      ...doc,
      quality: { checked: true, repaired, ...messages, issues: report.issues },
    },
    report,
  };
}

function slideRepairIndices(
  report: GenerationQualityReport,
  slides: readonly GeneratedSlide[],
  selected?: readonly number[],
): number[] {
  const indices = new Set<number>();
  const add = (index: number) => {
    if (Number.isSafeInteger(index) && index >= 0 && index < slides.length) indices.add(index);
  };
  for (const issue of report.issues) {
    const match = issue.path.match(/^slides\.(\d+)(?:\.|$)/);
    if (match) add(Number(match[1]));
    if (issue.code === "missing_slide_scenario") {
      add(slides.findIndex((slide) => slide.role === "case"));
      add(Math.floor(slides.length * 0.6));
    }
    if (issue.code === "missing_slide_practice") add(Math.floor(slides.length * 0.72));
    if (issue.code === "invalid_slide_learning_flow") {
      add(Math.floor(slides.length * 0.6));
      add(Math.floor(slides.length * 0.72));
      add(Math.max(0, slides.length - 2));
    }
    if (
      issue.code === "missing_sop_application" ||
      issue.code === "missing_sop_reference" ||
      issue.code === "missing_sop_disclosure"
    ) {
      add(slides.findIndex((slide) => slide.role === "procedure"));
      add(slides.findIndex((slide) => slide.role === "safety"));
    }
    if (issue.code === "repetitive_slide_role" || issue.code === "repetitive_slide_composition") {
      add(Math.floor(slides.length / 2));
      add(Math.floor(slides.length / 2) + 1);
    }
  }
  if (indices.size === 0 && report.issues.length > 0) add(Math.max(0, slides.length - 2));
  return Array.from(indices).filter((index) => !selected || selected.includes(index)).slice(0, MAX_SLIDE_REPAIRS_PER_ROUND);
}

function issuesForSlide(
  report: GenerationQualityReport,
  index: number
): GenerationQualityIssue[] {
  const prefix = `slides.${index}`;
  const local = report.issues.filter(
    (issue) => issue.path === prefix || issue.path.startsWith(`${prefix}.`)
  );
  const global = report.issues.filter((issue) => !/^slides\.\d+(?:\.|$)/.test(issue.path));
  return [...local, ...global].slice(0, 8);
}

function documentRepairIndices(
  report: GenerationQualityReport,
  sections: readonly GeneratedSection[],
  type: "plan" | "lesson"
): number[] {
  const indices = new Set<number>();
  const add = (index: number) => {
    if (Number.isSafeInteger(index) && index >= 0 && index < sections.length) indices.add(index);
  };
  for (const issue of report.issues) {
    const match = issue.path.match(/^sections\.(\d+)(?:\.|$)/);
    if (match) add(Number(match[1]));
    if (issue.code === "time_total_mismatch") {
      sections.forEach((section, index) => {
        if (type === "plan" ? section.heading === "훈련내용" : index > 0) add(index);
      });
    }
  }
  if (indices.size === 0 && report.issues.length > 0) {
    const preferred =
      type === "plan"
        ? sections.findIndex((section) => section.heading === "훈련내용")
        : sections.findIndex((section) => section.heading === "핵심이론");
    add(preferred >= 0 ? preferred : Math.max(0, sections.length - 1));
  }
  return Array.from(indices).sort((a, b) => a - b);
}

function issuesForDocumentSection(
  report: GenerationQualityReport,
  index: number
): GenerationQualityIssue[] {
  const prefix = `sections.${index}`;
  const local = report.issues.filter(
    (issue) => issue.path === prefix || issue.path.startsWith(`${prefix}.`)
  );
  const global = report.issues.filter((issue) => !/^sections\.\d+(?:\.|$)/.test(issue.path));
  return [...local, ...global].slice(0, 8);
}

function reviewProgress(round: number): { start: number; end: number } {
  if (round <= 0) return { start: 72, end: 75 };
  if (round === 1) return { start: 88, end: 90 };
  return { start: 96, end: 97 };
}

function repairProgress(round: number, index: number, total: number): number {
  const base = round === 1 ? 76 : 91;
  const span = round === 1 ? 10 : 4;
  return Math.min(95, base + Math.floor((Math.max(0, index) / Math.max(1, total)) * span));
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function prepareGenerationJobStep(
  jobId: string,
  runToken: string
): Promise<{ type: ValidatedGenerateRequest["type"]; slideCount: number; selectedRepairIndices?: number[] }> {
  "use step";
  let row = await loadWorkerJob(jobId, runToken);
  const request = validatedRequest(row);
  if (
    row.status === "queued" &&
    Math.floor(checkpointOf(row.checkpoint).activeModelIndex ?? 0) > 0
  ) {
    row = await saveCheckpointCas(
      row,
      (current) => Math.floor(current.activeModelIndex ?? 0) === 0,
      (current) => ({ ...current, activeModelIndex: 0 })
    );
  }
  const workflowRunId = getWorkflowMetadata().workflowRunId;
  row = await announceWorkerStage(row, {
    status: "retrieving",
    stage: "관련 교범과 SOP를 선별하는 중",
    progress: 5,
    workflow_run_id: workflowRunId,
    workflow_checked_at: null,
    workflow_missing_count: 0,
    workflow_missing_since: null,
    started_at: row.started_at ?? new Date().toISOString(),
    error_message: null,
    quality_passed: false,
    completed_at: null,
  });
  const existing = checkpointOf(row.checkpoint);
  if (!existing.context?.contextText) {
    const admin = createGenerationWorkerClient();
    const context = await withRetrievalDeadline(
      fetchCategoryContext(
        request.category,
        40,
        buildFocusedTrainingQuery(request.topic, request.focus ?? ""),
        admin,
        { conditions: request.conditions }
      )
    );
    if (!context.contextText) {
      if (context.degraded) {
        throw new RetryableError("근거 자료 조회가 지연되어 같은 단계를 다시 시도합니다.", {
          retryAfter: "15s",
        });
      }
      throw new FatalError("해당 분야에 인덱싱된 자료가 없어 생성할 수 없습니다.");
    }
    await saveCheckpointCas(
      row,
      (current) => Boolean(current.context?.contextText),
      (current) => ({ ...current, version: 1, context }),
      { progress: 15 }
    );
  } else {
    await advanceWorkerProgress(row, 15);
  }
  return {
    type: request.type,
    slideCount: request.type === "slides" ? targetSlideCount(request.duration) : 0,
    selectedRepairIndices: existing.selectedRepairRunToken === runToken ? existing.selectedRepairIndices : undefined,
  };
}

async function pauseForOutlineReviewStep(jobId: string, runToken: string): Promise<boolean> {
  "use step";
  const row = await loadWorkerJob(jobId, runToken);
  const request = validatedRequest(row);
  const checkpoint = checkpointOf(row.checkpoint);
  // Old jobs and explicit quick generation keep their existing behavior.
  if (!request.reviewOutline || checkpoint.outlineApproved || checkpoint.draft?.sections.length || checkpoint.slides?.length) return false;
  const outline = projectGenerationOutline(checkpoint, request.type);
  if (!outline) throw new FatalError("검토할 목차를 확인하지 못했습니다.");
  const updated = await updateActiveWorkerJobCas(row, {
    status: "awaiting_review", stage: "목차와 시간 배분을 확인해 주세요", progress: 28,
    review_outline: asJson(outline), review_draft: null, quality_issues: [],
    result: null, quality_passed: false, completed_at: null,
    run_token: crypto.randomUUID(),
  });
  if (updated) return true;
  const current = await loadWorkerJobById(jobId);
  if (current?.status === "awaiting_review") return true;
  throw new FatalError("다른 화면에서 생성 작업이 변경되었습니다.");
}

async function generateDocumentOutlineStep(jobId: string, runToken: string): Promise<void> {
  "use step";
  let row = await loadWorkerJob(jobId, runToken);
  const request = validatedRequest(row);
  if (request.type === "slides") throw new FatalError("문서 구성 단계 유형이 맞지 않습니다.");
  const checkpoint = checkpointOf(row.checkpoint);
  if (checkpoint.draft && generatedDocSchemaFor(request.type).safeParse(checkpoint.draft).success) {
    return;
  }
  if (checkpoint.documentOutline) return;
  const context = contextFromCheckpoint(checkpoint);
  const headings = documentHeadings(request.type);
  const headingSchema = z.enum(headings as [string, ...string[]]);
  const labelSchema = z.enum(allowedSourceLabels(context) as [string, ...string[]]);
  const schema = z.object({
    title: z.string().min(4).max(100),
    sections: z
      .array(
        z.object({
          heading: headingSchema,
          purpose: z.string().min(10).max(300),
          keyPoints: z.array(z.string().min(2).max(120)).min(2).max(6),
          sourceRefs: z.array(labelSchema).min(1).max(4),
          actionRequirements: z.array(z.string().min(4).max(140)).min(1).max(6),
          evidenceRequirements: outlineEvidenceRequirementsSchema(allowedSourceLabels(context) as [string, ...string[]]),
        })
      )
      .length(headings.length)
      .superRefine((sections, ctx) => {
        headings.forEach((heading, index) => {
          if (sections[index]?.heading === heading) return;
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, "heading"],
            message: `${index + 1}번째 섹션은 '${heading}'이어야 합니다.`,
          });
        });
      }),
  });
  row = await announceWorkerStage(row, {
    status: "drafting",
    stage: "정밀 모델이 전체 교안 구조와 시간 배분을 설계하는 중",
    progress: 22,
  });
  try {
    const { object } = await generateObject({
      model: getChatModel(activeModelKey(checkpointOf(row.checkpoint), request)),
      schema,
      system: buildGenerateSystemPrompt(request.category, context.contextText, context.sopEvidence),
      prompt: `${buildGeneratePrompt(request, context.sopEvidence)}

[이번 단계]
- 지금은 본문을 쓰지 말고 ${headings.length}개 고정 섹션의 전체 설계만 작성하세요.
- 섹션 순서는 ${headings.join(" → ")}로 정확히 유지하세요.
- 각 섹션의 역할과 반드시 다룰 근거 기반 핵심어를 먼저 확정하세요.
- 각 섹션의 sourceRefs에는 실제로 그 섹션 작성에 사용할 참고 자료 라벨만 1~4개 지정하세요.
- actionRequirements에는 그 섹션에서 대원이 실제로 할 행동, 행동 후 확인, 이상 시 조치·보고 또는 평가 연결 중 필요한 항목을 구체적으로 지정하세요. 자료에 고정 순서가 없으면 기술 절차를 만들지 마세요.
${outlineEvidencePrompt()}`,
      temperature: 0.3,
      abortSignal: AbortSignal.timeout(MODEL_CALL_MAX_MS),
    });
    const documentOutline: DocumentOutline = {
      title: object.title,
      sections: object.sections.map((section) => ({
        ...bindOutlineEvidence(section, context.contextText),
        minutes: documentMinutes(request.type as "plan" | "lesson", request.duration, section.heading),
      })),
    };
    await saveCheckpointCas(
      row,
      (current) => Boolean(current.documentOutline),
      (current) => ({
        ...current,
        documentOutline,
        draft: { title: object.title, sections: [] },
      }),
      { progress: 28 }
    );
  } catch (error) {
    await retryGenerationError(error, row, request);
  }
}

async function supplementOutlineEvidenceStep(
  jobId: string,
  runToken: string,
  searchIndex: number,
): Promise<void> {
  "use step";
  if (searchIndex < 0 || searchIndex >= MAX_OUTLINE_EVIDENCE_SEARCHES) return;
  let row = await loadWorkerJob(jobId, runToken);
  const request = validatedRequest(row);
  let checkpoint = checkpointOf(row.checkpoint);
  // 배포 전에 초안 작성이 시작된 작업의 근거를 뒤늦게 교체하지 않는다.
  if ((checkpoint.draft?.sections.length ?? 0) > 0 || (checkpoint.slides?.length ?? 0) > 0) return;
  if (!checkpoint.outlineEvidence) {
    const context = contextFromCheckpoint(checkpoint);
    const queries = outlineEvidenceSearchQueries(
      buildFocusedTrainingQuery(request.topic, request.focus ?? ""),
      outlineEvidenceGaps(outlineItems(checkpoint), context.contextText),
      request.conditions,
    );
    row = await saveCheckpointCas(row, (current) => Boolean(current.outlineEvidence), (current) => ({
      ...current,
      outlineEvidence: { queries, completedQueries: [], addedContext: false, reviewed: queries.length === 0 },
    }));
    checkpoint = checkpointOf(row.checkpoint);
  }
  const state = checkpoint.outlineEvidence!;
  const query = state.queries.slice(0, MAX_OUTLINE_EVIDENCE_SEARCHES)[searchIndex]?.trim().slice(0, 100);
  if (!query || state.reviewed || state.completedQueries.includes(query)) return;
  row = await announceWorkerStage(row, {
    status: "retrieving",
    stage: `목차에서 부족한 근거를 추가 확인하는 중 · ${searchIndex + 1}/${Math.min(state.queries.length, MAX_OUTLINE_EVIDENCE_SEARCHES)}`,
    progress: row.progress,
  });
  const original = contextFromCheckpoint(checkpoint);
  const context = await withRetrievalDeadline(supplementGenerationContext(
    original, request.category, query, createGenerationWorkerClient(),
  ));
  await saveCheckpointCas(
    row,
    (current) => current.outlineEvidence?.completedQueries.includes(query) === true,
    (current) => {
      if (current.context?.contextText !== original.contextText) {
        throw new RetryableError("최신 목차 근거를 기준으로 부족한 조건을 다시 확인합니다.", { retryAfter: "3s" });
      }
      const saved = current.outlineEvidence!;
      return {
        ...current,
        context,
        outlineEvidence: {
          ...saved,
          completedQueries: Array.from(new Set([...saved.completedQueries, query])).slice(0, MAX_OUTLINE_EVIDENCE_SEARCHES),
          addedContext: saved.addedContext || context.contextText !== original.contextText,
        },
      };
    },
  );
}

async function reviewOutlineEvidenceStep(jobId: string, runToken: string): Promise<void> {
  "use step";
  let row = await loadWorkerJob(jobId, runToken);
  const request = validatedRequest(row);
  const checkpoint = checkpointOf(row.checkpoint);
  const state = checkpoint.outlineEvidence;
  if (!state || state.reviewed) return;
  if ((checkpoint.draft?.sections.length ?? 0) > 0 || (checkpoint.slides?.length ?? 0) > 0) return;
  const context = contextFromCheckpoint(checkpoint);
  const items = outlineItems(checkpoint);
  const gaps = outlineEvidenceGaps(items, context.contextText);
  const finish = async (nextItems = items) => saveCheckpointCas(
    row,
    (current) => current.outlineEvidence?.reviewed === true,
    (current) => {
      if (current.context?.contextText !== context.contextText || !sameJson(outlineItems(current), items)) {
        throw new RetryableError("최신 목차와 원문에 맞춰 근거 연결을 다시 검토합니다.", { retryAfter: "3s" });
      }
      return {
        ...withEvidenceItems(current, nextItems.map((item) => bindOutlineEvidence(item, context.contextText))),
        outlineEvidence: { ...current.outlineEvidence!, reviewed: true },
      };
    },
  );
  if (!state.addedContext || gaps.length === 0) {
    await finish();
    return;
  }
  const labels = allowedSourceLabels(context) as [string, ...string[]];
  const schema = z.object({
    bindings: z.array(z.object({
      itemIndex: z.number().int().min(0).max(items.length - 1),
      requirementIndex: z.number().int().min(0).max(2),
      sourceRef: z.enum(labels).nullable(),
      excerpt: z.string().min(12).max(360).nullable(),
    })).max(gaps.length),
  });
  row = await announceWorkerStage(row, {
    status: "drafting", stage: "추가로 찾은 원문과 목차의 적용 조건을 대조하는 중",
    progress: row.progress,
  });
  try {
    const { object } = await generateObject({
      model: getChatModel(activeModelKey(checkpointOf(row.checkpoint), request)),
      schema,
      system: buildGenerateSystemPrompt(request.category, context.contextText, context.sopEvidence),
      prompt: `${buildGeneratePrompt(request, context.sopEvidence)}
[부족한 목차 근거 연결만 검토]
${JSON.stringify(gaps)}
- itemIndex와 requirementIndex를 그대로 사용해 위 미해결 항목만 검토하세요. 새로운 요구사항이나 본문은 작성하지 마세요.
- 해당 요구사항의 대상·상황·적용 조건을 실제로 뒷받침하는 출처만 연결하고 연속 원문 12~360자를 그대로 복사하세요.
- 단어만 비슷하거나 다른 상황에 대한 원문이면 sourceRef와 excerpt를 null로 남기세요. 검색 결과가 있다는 이유만으로 적용 가능하다고 판단하지 마세요.
- 서로 다른 근거의 절차를 결합해 복합 상황을 해결했다고 처리하지 마세요.`,
      temperature: 0,
      abortSignal: AbortSignal.timeout(MODEL_CALL_MAX_MS),
    });
    const byGap = new Map(gaps.map((gap) => [`${gap.itemIndex}:${gap.requirementIndex}`, gap]));
    const nextItems = items.map((item) => ({
      ...item, evidenceRequirements: item.evidenceRequirements?.map((requirement) => ({ ...requirement })),
    }));
    const used = new Set<string>();
    for (const binding of object.bindings) {
      const key = `${binding.itemIndex}:${binding.requirementIndex}`;
      if (!byGap.has(key) || used.has(key)) continue;
      used.add(key);
      const requirement = nextItems[binding.itemIndex].evidenceRequirements?.[binding.requirementIndex];
      if (!requirement) continue;
      const candidate = { ...requirement, sourceRef: binding.sourceRef, excerpt: binding.excerpt };
      if (hasOutlineEvidenceExcerpt(candidate, context.contextText)) Object.assign(requirement, candidate);
    }
    await finish(nextItems);
  } catch (error) {
    await retryGenerationError(error, row, request);
  }
}

async function generateDocumentBatchStep(
  jobId: string,
  runToken: string,
  start: number,
  end: number
): Promise<void> {
  "use step";
  let row = await loadWorkerJob(jobId, runToken);
  const request = validatedRequest(row);
  if (request.type === "slides") throw new FatalError("문서 작성 단계 유형이 맞지 않습니다.");
  const checkpoint = checkpointOf(row.checkpoint);
  if (checkpoint.draft && generatedDocSchemaFor(request.type).safeParse(checkpoint.draft).success) {
    return;
  }
  const context = contextFromCheckpoint(checkpoint);
  const outline = checkpoint.documentOutline;
  const currentSections = checkpoint.draft?.sections ?? [];
  if (!outline || end > outline.sections.length || start < 0 || start >= end) {
    throw new FatalError("저장된 문서 구성안을 복원할 수 없습니다.");
  }
  if (currentSections.length >= end) return;
  if (currentSections.length !== start) {
    throw new RetryableError("앞선 문서 섹션 저장을 기다립니다.", { retryAfter: "5s" });
  }
  const batchPlan = outline.sections.slice(start, end);
  const batchHeadings = batchPlan.map(({ heading }) => heading) as [string, ...string[]];
  const headingSchema = z.enum(batchHeadings);
  const schema = z.object({
    sections: z
      .array(
        z.object({
          heading: headingSchema,
          content: z.string().min(1).max(20_000),
        })
      )
      .length(batchPlan.length)
      .superRefine((sections, ctx) => {
        batchPlan.forEach(({ heading }, index) => {
          if (sections[index]?.heading === heading) return;
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, "heading"],
            message: `${index + 1}번째 결과는 '${heading}'이어야 합니다.`,
          });
        });
      }),
  });
  const totalBatches = Math.ceil(outline.sections.length / DOCUMENT_BATCH_SIZE);
  const batchNumber = Math.floor(start / DOCUMENT_BATCH_SIZE) + 1;
  const batchSourceRefs = batchPlan.flatMap((section) => section.sourceRefs ?? []);
  const batchUsesSop = batchPlan.some((section) =>
    documentSectionUsesSop(request.type as "plan" | "lesson", section.heading)
  );
  const batchContextText = scopedGenerationContext(
    context,
    batchSourceRefs,
    batchUsesSop
  );
  row = await announceWorkerStage(row, {
    status: "drafting",
    stage: `문서 ${start + 1}~${end}번째 섹션 정밀 작성 중 · ${batchNumber}/${totalBatches}묶음`,
    progress: 28 + Math.floor((start / outline.sections.length) * 40),
  });
  try {
    const { object } = await generateObject({
      model: getChatModel(activeModelKey(checkpointOf(row.checkpoint), request)),
      schema,
      system: buildGenerateSystemPrompt(request.category, batchContextText, context.sopEvidence),
      prompt: `${buildGeneratePrompt(request, context.sopEvidence)}

[확정된 전체 문서 설계]
제목: ${outline.title}
${outline.sections
  .map(
    (section, index) =>
      `${index + 1}. ${section.heading}: ${section.purpose} / 핵심 ${section.keyPoints.join(", ")}${
        section.minutes === null ? "" : ` / 배정 시간 ${section.minutes}분`
      } / 행동 요구 ${(section.actionRequirements ?? []).join("; ") || "기존 핵심 기준 적용"}`
  )
  .join("\n")}

[이번 단계]
- ${start + 1}번째부터 ${end}번째까지 ${batchPlan.length}개 섹션만 작성하세요.
- 제목·순서·역할을 바꾸지 말고, 다른 섹션과 중복되지 않게 구체화하세요.
- 배정 시간이 있는 섹션은 그 합계가 정확히 맞도록 [단계명 · 00분] 표기를 사용하세요.
${batchPlan
  .map(
    (section) =>
      `${section.heading}: ${section.purpose} / 핵심 ${section.keyPoints.join(", ")}${
        section.minutes === null ? "" : ` / 이 섹션 시간 합계 정확히 ${section.minutes}분`
      } / 행동 요구 ${(section.actionRequirements ?? []).join("; ") || "기존 핵심 기준 적용"} / 기술 조건 ${(section.evidenceRequirements ?? []).map((item) => item.requirement).join("; ") || "기존 핵심 기준 적용"} / 허용 근거 ${(section.sourceRefs ?? []).join(", ") || "기존 전체 근거"}`
  )
  .join("\n")}
${outlineEvidenceGuidance(batchPlan, context.contextText)}`,
      temperature: 0.35,
      abortSignal: AbortSignal.timeout(MODEL_CALL_MAX_MS),
    });
    const sections = object.sections.map((section, index) => ({
      ...section,
      heading: batchPlan[index].heading,
    }));
    await saveCheckpointCas(
      row,
      (current) => (current.draft?.sections.length ?? 0) >= end,
      (current) => {
        const savedSections = current.draft?.sections ?? [];
        if (savedSections.length !== start) {
          throw new RetryableError("앞선 문서 섹션과 안전하게 합치는 중입니다.", {
            retryAfter: "3s",
          });
        }
        return {
          ...current,
          draft: { title: outline.title, sections: [...savedSections, ...sections] },
        };
      },
      { progress: 28 + Math.floor((end / outline.sections.length) * 40) }
    );
  } catch (error) {
    await retryGenerationError(error, row, request);
  }
}

async function generateSlideOutlineStep(
  jobId: string,
  runToken: string,
  expectedCount: number
): Promise<void> {
  "use step";
  let row = await loadWorkerJob(jobId, runToken);
  const request = validatedRequest(row);
  if (request.type !== "slides") throw new FatalError("슬라이드 구성 단계 유형이 맞지 않습니다.");
  const checkpoint = checkpointOf(row.checkpoint);
  if (checkpoint.outline?.slides.length === expectedCount) return;
  const context = contextFromCheckpoint(checkpoint);
  const labels = allowedSourceLabels(context);
  const labelSchema = z.enum(labels as [string, ...string[]]);
  const outlineSchema = z.object({
    title: z.string().min(2).max(34),
    slides: z
      .array(
        z.object({
          title: z.string().min(4).max(34),
          role: z.enum(SLIDE_ROLE_TYPES),
          composition: z.enum(SLIDE_COMPOSITION_TYPES),
          purpose: z.string().min(10).max(220),
          sourceRefs: z.array(labelSchema).min(1).max(4),
          sopTarget: z.boolean(),
          actionRequirements: z.array(z.string().min(4).max(140)).min(1).max(5),
          evidenceRequirements: outlineEvidenceRequirementsSchema(labels as [string, ...string[]]),
        })
      )
      .length(expectedCount)
      .superRefine((slides, ctx) => {
        if (slides.some((slide) => slide.sopTarget)) return;
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "SOP 적용 근거 장이 필요합니다." });
      }),
  });
  row = await announceWorkerStage(row, {
    status: "drafting",
    stage: `정밀 모델이 ${expectedCount}장 전체 구성을 설계하는 중`,
    progress: 22,
  });
  try {
    const { object } = await generateObject({
      model: getChatModel(activeModelKey(checkpointOf(row.checkpoint), request)),
      schema: outlineSchema,
      system: buildGenerateSystemPrompt(request.category, context.contextText, context.sopEvidence),
      prompt: `${buildGeneratePrompt(request, context.sopEvidence)}

[이번 단계]
- 지금은 본문을 쓰지 말고 정확히 ${expectedCount}장의 전체 구성안만 만드세요.
- 학습 목표에서 개념·절차·장비·판단 사례·실습·안전·평가·요약으로 이어지는 흐름을 먼저 확정하세요.
- 각 장마다 결론형 제목, 역할, 서로 다른 화면 구도, 교육 목적, 정확한 근거 라벨을 지정하세요.
- actionRequirements에는 해당 장에서 대원이 할 행동, 확인 지점, 이상 시 조치 또는 평가 연결을 구체적으로 지정하세요. 참여 실습 장은 실제 행동 3~5개를 설계하세요.
- SOP 적용 근거 장은 sopTarget=true로 표시하세요.
${outlineEvidencePrompt()}`,
      temperature: 0.3,
      abortSignal: AbortSignal.timeout(MODEL_CALL_MAX_MS),
    });
    await saveCheckpointCas(
      row,
      (current) => current.outline?.slides.length === expectedCount,
      (current) => ({ ...current, outline: {
        ...object, slides: object.slides.map((slide) => bindOutlineEvidence(slide, context.contextText)),
      }, slides: [] }),
      { progress: 30 }
    );
  } catch (error) {
    await retryGenerationError(error, row, request);
  }
}

async function generateSlideBatchStep(
  jobId: string,
  runToken: string,
  start: number,
  end: number
): Promise<void> {
  "use step";
  let row = await loadWorkerJob(jobId, runToken);
  const request = validatedRequest(row);
  if (request.type !== "slides") throw new FatalError("슬라이드 본문 단계 유형이 맞지 않습니다.");
  const checkpoint = checkpointOf(row.checkpoint);
  const context = contextFromCheckpoint(checkpoint);
  const outline = checkpoint.outline;
  if (!outline || end > outline.slides.length || start < 0 || start >= end) {
    throw new FatalError("저장된 슬라이드 구성안을 복원할 수 없습니다.");
  }
  const currentSlides = checkpoint.slides ?? [];
  if (currentSlides.length >= end) return;
  if (currentSlides.length !== start) {
    throw new RetryableError("앞선 슬라이드 묶음 저장을 기다립니다.", { retryAfter: "5s" });
  }
  const labels = allowedSourceLabels(context);
  const batchPlan = outline.slides.slice(start, end);
  const schema = z.object({
    slides: z.array(strictGeneratedSlideSchemaFor(labels)).length(batchPlan.length),
  });
  const totalBatches = Math.ceil(outline.slides.length / SLIDE_BATCH_SIZE);
  const batchNumber = Math.floor(start / SLIDE_BATCH_SIZE) + 1;
  const batchContextText = scopedGenerationContext(
    context,
    batchPlan.flatMap((slide) => slide.sourceRefs),
    batchPlan.some((slide) => slide.sopTarget)
  );
  row = await announceWorkerStage(row, {
    status: "drafting",
    stage: `슬라이드 ${start + 1}~${end}장 정밀 작성 중 · ${batchNumber}/${totalBatches}묶음`,
    progress: 30 + Math.floor((start / outline.slides.length) * 38),
  });
  try {
    const { object } = await generateObject({
      model: getChatModel(activeModelKey(checkpointOf(row.checkpoint), request)),
      schema,
      system: buildGenerateSystemPrompt(request.category, batchContextText, context.sopEvidence),
      prompt: `${buildGeneratePrompt(request, context.sopEvidence)}

[확정된 전체 구성안]
${outline.slides
  .map(
    (slide, index) =>
      `${index + 1}. ${slide.title} · role=${slide.role} · composition=${slide.composition}${
        slide.sopTarget ? " · SOP 적용 근거 장" : ""
      } · 행동 요구 ${(slide.actionRequirements ?? []).join("; ") || "기존 목적 적용"}`
  )
  .join("\n")}

[이번 단계]
- ${start + 1}번부터 ${end}번까지 ${batchPlan.length}장만 순서대로 작성하세요.
- 각 장의 확정 제목·role·composition·교육 목적·근거 범위를 유지하세요.
${batchPlan
  .map(
    (slide, index) =>
      `${start + index + 1}번 ${JSON.stringify(slide.title)}: ${slide.purpose} / 근거 ${slide.sourceRefs.join(", ")}${
        slide.sopTarget ? " / 이 장에 SOP 적용 계약을 정확히 반영" : ""
      } / 행동 요구 ${(slide.actionRequirements ?? []).join("; ") || "기존 목적 적용"} / 기술 조건 ${(slide.evidenceRequirements ?? []).map((item) => item.requirement).join("; ") || "기존 목적 적용"}`
  )
  .join("\n")}
${outlineEvidenceGuidance(batchPlan, context.contextText)}`,
      temperature: 0.35,
      abortSignal: AbortSignal.timeout(MODEL_CALL_MAX_MS),
    });
    const normalized = object.slides.map((slide, index) => ({
      ...slide,
      title: batchPlan[index].title,
      role: batchPlan[index].role,
      composition: batchPlan[index].composition,
    }));
    await saveCheckpointCas(
      row,
      (current) => (current.slides?.length ?? 0) >= end,
      (current) => {
        const savedSlides = current.slides ?? [];
        if (savedSlides.length !== start) {
          throw new RetryableError("앞선 슬라이드 묶음과 안전하게 합치는 중입니다.", {
            retryAfter: "3s",
          });
        }
        return { ...current, slides: [...savedSlides, ...normalized] };
      },
      { progress: 30 + Math.floor((end / outline.slides.length) * 38) }
    );
  } catch (error) {
    await retryGenerationError(error, row, request);
  }
}

async function reviewGenerationStep(
  jobId: string,
  runToken: string,
  round: number
): Promise<WorkflowReview> {
  "use step";
  let row = await loadWorkerJob(jobId, runToken);
  const request = validatedRequest(row);
  const progress = reviewProgress(round);
  row = await announceWorkerStage(row, {
    status: "reviewing",
    stage: "구성·기술 수치·원문 근거·요청 조건을 대조하는 중",
    progress: progress.start,
  });
  let checkpoint = checkpointOf(row.checkpoint);
  const signature = groundingSignature(request, checkpoint);
  if (checkpoint.groundingReview?.signature !== signature) {
    const { result } = resultWithQuality(request, checkpoint);
    const draft = result as unknown as GeneratedDoc | GeneratedSlideDeck;
    const grounding = await reviewGenerationGrounding({
      draft,
      evidenceText: contextFromCheckpoint(checkpoint).contextText,
      request, modelKey: activeModelKey(checkpoint, request),
    });
    row = await saveCheckpointCas(row,
      (saved) => saved.groundingReview?.signature === signature,
      (saved) => {
        if (groundingSignature(request, saved) !== signature) {
          throw new RetryableError("변경된 초안의 근거를 다시 확인합니다.", { retryAfter: "3s" });
        }
        return { ...saved, groundingReview: {
          signature, report: grounding,
          evidenceSignature: textSignature(contextFromCheckpoint(checkpoint).contextText),
          partSignatures: groundingPartSignatures(draft),
        } };
      });
    checkpoint = checkpointOf(row.checkpoint);
  }
  const { report } = resultWithQuality(request, checkpoint);
  await advanceWorkerProgress(row, progress.end);
  return {
    blockingIssues: blockingGenerationQualityIssues(report).length,
    totalIssues: report.issues.length,
    repairIndices:
      request.type === "slides"
        ? slideRepairIndices(report, checkpoint.slides ?? [], checkpoint.selectedRepairRunToken === runToken ? checkpoint.selectedRepairIndices : undefined)
        : documentRepairIndices(
            report,
            checkpoint.draft?.sections ?? [],
            request.type
          ),
  };
}

async function repairDocumentSectionStep(
  jobId: string,
  runToken: string,
  round: number,
  index: number
): Promise<void> {
  "use step";
  let row = await loadWorkerJob(jobId, runToken);
  const request = validatedRequest(row);
  if (request.type === "slides") throw new FatalError("문서 보완 단계 유형이 맞지 않습니다.");
  let checkpoint = checkpointOf(row.checkpoint);
  const marker = `document:${runToken}:${round}:${index}`;
  if (hasRepairMarker(checkpoint, marker)) return;
  row = await announceWorkerStage(row, {
    status: "repairing",
    stage: `${index + 1}번째 문서 섹션 정밀 보완 중 · ${round}/${MAX_QUALITY_REPAIR_ROUNDS}차`,
    progress: repairProgress(round, index, checkpoint.draft?.sections.length ?? 1),
  });
  checkpoint = checkpointOf(row.checkpoint);
  if (hasRepairMarker(checkpoint, marker)) return;
  const context = contextFromCheckpoint(checkpoint);
  const { report: currentReport } = resultWithQuality(request, checkpoint);
  if (currentReport.issues.length === 0) return;
  const currentDraft = checkpoint.draft as GeneratedDocDraft;
  const current = currentDraft.sections[index];
  if (!current) return;
  const relevantIssues = issuesForDocumentSection(currentReport, index);
  const focusedReport: GenerationQualityReport = {
    ok: false,
    issues: relevantIssues,
  };
  const outlineItem = checkpoint.documentOutline?.sections[index];
  const sectionContextText = scopedGenerationContext(
    context,
    outlineItem?.sourceRefs ?? [],
    documentSectionUsesSop(
      request.type as "plan" | "lesson",
      current.heading
    )
  );
  try {
    const { object } = await generateObject({
      model: getChatModel(activeModelKey(checkpoint, request)),
      schema: z.object({
        heading: z.literal(current.heading),
        content: z.string().min(1).max(20_000),
      }),
      system: buildGenerateSystemPrompt(
        request.category,
        sectionContextText,
        context.sopEvidence
      ),
      prompt: `${buildGenerationRepairPrompt({
          type: request.type,
          request,
          draft: currentDraft,
          report: focusedReport,
          sopEvidence: context.sopEvidence,
        })}

[이번 단계의 출력 계약]
- 전체 문서가 아니라 ${index + 1}번째 '${current.heading}' 섹션 하나만 JSON 객체로 반환하세요.
- heading은 '${current.heading}'으로 고정하고 content만 보완하세요.
${outlineItem ? `- 이 섹션의 목적: ${outlineItem.purpose}\n- 반드시 다룰 핵심: ${outlineItem.keyPoints.join(", ")}` : ""}
${outlineItem?.actionRequirements?.length ? `- 반드시 구현할 행동·확인 기준: ${outlineItem.actionRequirements.join("; ")}` : ""}
${outlineItem?.sourceRefs?.length ? `- 이 섹션에 허용된 근거: ${outlineItem.sourceRefs.join(", ")}` : ""}
${outlineItem?.minutes == null ? "" : `- [단계명 · 00분] 표기의 시간 합계를 정확히 ${outlineItem.minutes}분으로 맞추세요.`}
- 다른 섹션의 내용을 대신 쓰거나 전체 sections 배열을 반환하지 마세요.
${outlineEvidenceGuidance(outlineItem ? [outlineItem] : [], context.contextText)}`,
      temperature: 0.3,
      abortSignal: AbortSignal.timeout(REPAIR_MODEL_CALL_MAX_MS),
    });
    const labels = extractSourceLabels(context.contextText);
    const repairedSection = stripSectionInlineSourceRefs(
      { heading: current.heading, content: object.content },
      labels
    );
    const candidateDraft: GeneratedDocDraft = {
      ...currentDraft,
      sections: currentDraft.sections.map((section, sectionIndex) =>
        sectionIndex === index ? repairedSection : section
      ),
    };
    const candidateCheckpoint: GenerationCheckpoint = {
      ...checkpoint,
      draft: candidateDraft,
      repaired: true,
      repairAttempts: Math.max(checkpoint.repairAttempts ?? 0, round),
    };
    const candidateReview = sameJson(repairedSection, current)
      ? undefined
      : await reviewRepairCandidate(request, checkpoint, candidateCheckpoint, index, sectionContextText);
    const { report: uncheckedCandidateReport } = resultWithQuality(request, candidateCheckpoint);
    const candidateReport = candidateReview
      ? mergeGroundingQuality(uncheckedCandidateReport, candidateReview.report)
      : uncheckedCandidateReport;
    const hasGlobalIssue = relevantIssues.some(
      (issue) => !/^sections\.\d+(?:\.|$)/.test(issue.path)
    );
    const accept = candidateReview !== undefined && candidateReview.report.issues.length === 0 &&
      repairPreservesBlockingChecks(currentReport, candidateReport, index) && (
      isQualityImprovement(currentReport, candidateReport) ||
      (hasGlobalIssue && isQualityNonRegression(currentReport, candidateReport))
    );
    await saveCheckpointCas(
      row,
      (saved) => hasRepairMarker(saved, marker),
      (saved) => {
        const savedCurrent = saved.draft?.sections[index];
        if (!sameJson(savedCurrent, current) ||
            groundingSignature(request, saved) !== groundingSignature(request, checkpoint)) {
          throw new RetryableError("최신 문서 섹션을 기준으로 보완을 다시 계산합니다.", {
            retryAfter: "3s",
          });
        }
        const next = accept
          ? {
              ...saved,
              draft: {
                ...(saved.draft as GeneratedDocDraft),
                sections: (saved.draft as GeneratedDocDraft).sections.map(
                  (section, sectionIndex) =>
                    sectionIndex === index ? repairedSection : section
                ),
              },
              repaired: true,
              repairAttempts: Math.max(saved.repairAttempts ?? 0, round),
            }
          : {
              ...saved,
              repairAttempts: Math.max(saved.repairAttempts ?? 0, round),
            };
        return checkpointWithRepairMarker(
          candidateReview ? withRepairCandidateReview(next, candidateReview) : next,
          marker
        );
      },
      { progress: repairProgress(round, index + 1, currentDraft.sections.length) }
    );
  } catch (error) {
    await retryGenerationError(error, row, request);
  }
}

async function repairSlideStep(
  jobId: string,
  runToken: string,
  round: number,
  index: number
): Promise<void> {
  "use step";
  let row = await loadWorkerJob(jobId, runToken);
  const request = validatedRequest(row);
  if (request.type !== "slides") throw new FatalError("슬라이드 보완 단계 유형이 맞지 않습니다.");
  let checkpoint = checkpointOf(row.checkpoint);
  const marker = `slide:${runToken}:${round}:${index}`;
  if (hasRepairMarker(checkpoint, marker)) return;
  row = await announceWorkerStage(row, {
    status: "repairing",
    stage: `${index + 1}번 슬라이드 정밀 보완 중 · ${round}/${MAX_QUALITY_REPAIR_ROUNDS}차`,
    progress: repairProgress(round, index, checkpoint.slides?.length ?? 1),
  });
  checkpoint = checkpointOf(row.checkpoint);
  if (hasRepairMarker(checkpoint, marker)) return;
  const context = contextFromCheckpoint(checkpoint);
  const slides = checkpoint.slides ?? [];
  const current = slides[index];
  if (!current || !checkpoint.outline) return;
  const { report: currentReport } = resultWithQuality(request, checkpoint);
  if (currentReport.issues.length === 0) return;
  const relevantIssues = issuesForSlide(currentReport, index);
  const sopTarget =
    checkpoint.outline.slides[index]?.sopTarget === true ||
    relevantIssues.some((issue) => issue.code.startsWith("missing_sop"));
  const slideOutline = checkpoint.outline.slides[index];
  const slideContextText = scopedGenerationContext(
    context,
    [
      ...(slideOutline?.sourceRefs ?? []),
      ...(current.sourceRefs ?? []),
    ],
    sopTarget
  );
  try {
    const labels = allowedSourceLabels(context);
    const { object } = await generateObject({
      model: getChatModel(activeModelKey(checkpoint, request)),
      schema: strictGeneratedSlideSchemaFor(labels),
      system: buildGenerateSystemPrompt(
        request.category,
        slideContextText,
        context.sopEvidence
      ),
      prompt: buildSlideRegenPrompt({
        category: request.category,
        audience: request.audience,
        duration: request.duration,
        slideMode: request.slideMode,
        deckTitle: checkpoint.outline.title,
        outline: checkpoint.outline.slides.map((slide) => slide.title),
        index,
        current,
        topic: request.topic,
        focus: request.focus,
        sopEvidence: context.sopEvidence,
        conditions: request.conditions,
        sopTarget,
        instruction: `자동 품질검사 항목을 해결하세요: ${relevantIssues
          .map((issue) => issue.message)
          .join(" / ")}${
          slideOutline?.actionRequirements?.length
            ? ` / 구성안의 행동·확인 요구: ${slideOutline.actionRequirements.join("; ")}`
            : ""
        }${outlineEvidenceGuidance(slideOutline ? [slideOutline] : [], context.contextText)}`,
      }),
      temperature: 0.3,
      abortSignal: AbortSignal.timeout(REPAIR_MODEL_CALL_MAX_MS),
    });
    const candidateSlides = slides.map((slide, slideIndex) =>
      slideIndex === index ? object : slide
    );
    const candidateCheckpoint: GenerationCheckpoint = {
      ...checkpoint,
      slides: candidateSlides,
      repaired: true,
      repairAttempts: (checkpoint.repairAttempts ?? 0) + 1,
    };
    const candidateReview = sameJson(object, current)
      ? undefined
      : await reviewRepairCandidate(request, checkpoint, candidateCheckpoint, index, context.contextText);
    const { report: uncheckedCandidateReport } = resultWithQuality(request, candidateCheckpoint);
    const candidateReport = candidateReview
      ? mergeGroundingQuality(uncheckedCandidateReport, candidateReview.report)
      : uncheckedCandidateReport;
    const hasGlobalIssue = relevantIssues.some(
      (issue) => !/^slides\.\d+(?:\.|$)/.test(issue.path)
    );
    const accept = candidateReview !== undefined && candidateReview.report.issues.length === 0 &&
      repairPreservesBlockingChecks(currentReport, candidateReport, index) && (
      isQualityImprovement(currentReport, candidateReport) ||
      (hasGlobalIssue && isQualityNonRegression(currentReport, candidateReport))
    );
    await saveCheckpointCas(
      row,
      (saved) => hasRepairMarker(saved, marker),
      (saved) => {
        const savedCurrent = saved.slides?.[index];
        if (!sameJson(savedCurrent, current) ||
            groundingSignature(request, saved) !== groundingSignature(request, checkpoint)) {
          throw new RetryableError("최신 슬라이드를 기준으로 보완을 다시 계산합니다.", {
            retryAfter: "3s",
          });
        }
        const next = accept
          ? {
              ...saved,
              slides: (saved.slides ?? []).map((slide, slideIndex) =>
                slideIndex === index ? object : slide
              ),
              repaired: true,
              repairAttempts: Math.max(saved.repairAttempts ?? 0, round),
            }
          : {
              ...saved,
              repairAttempts: Math.max(saved.repairAttempts ?? 0, round),
            };
        return checkpointWithRepairMarker(
          candidateReview ? withRepairCandidateReview(next, candidateReview) : next,
          marker
        );
      },
      { progress: repairProgress(round, index + 1, slides.length) }
    );
  } catch (error) {
    await retryGenerationError(error, row, request);
  }
}

async function finishGenerationJobStep(
  jobId: string,
  runToken: string,
  review: WorkflowReview
): Promise<WorkflowResult> {
  "use step";
  let row = await loadWorkerJob(jobId, runToken);
  for (let conflict = 0; conflict < 3; conflict += 1) {
    const request = validatedRequest(row);
    const checkpoint = checkpointOf(row.checkpoint);
    if (checkpoint.groundingReview?.signature !== groundingSignature(request, checkpoint)) {
      throw new FatalError("최신 초안의 원문 근거 검토가 완료되지 않았습니다.");
    }
    const { result, report } = resultWithQuality(request, checkpoint);
    const blockingIssues = blockingGenerationQualityIssues(report);
    const completed = blockingIssues.length === 0;
    const status = completed ? "completed" : "needs_attention";
    const updated = await updateActiveWorkerJobCas(row, {
      status,
      stage: completed
        ? "품질 점검을 통과해 제작이 완료됨"
        : "저장된 초안에 추가 보완이 필요함",
      progress: 100,
      result: completed ? asJson(result) : null,
      review_draft: completed ? null : asJson(result),
      review_outline: null,
      quality_issues: completed ? [] : asJson(publicGenerationQualityIssues(report.issues, blockingIssues)),
      quality_passed: completed,
      completed_at: new Date().toISOString(),
      error_message: completed
        ? null
        : `핵심 품질 항목 ${Math.max(blockingIssues.length, review.blockingIssues)}건이 남아 있습니다. 저장된 초안부터 다시 보완할 수 있습니다.`,
      // 완료 뒤 도착한 오래된 step이 terminal 상태를 되살리지 못하게 실행권을 폐기한다.
      run_token: crypto.randomUUID(),
      workflow_missing_count: 0,
      workflow_missing_since: null,
    });
    if (updated) return { jobId, status };

    const current = await loadWorkerJobById(jobId);
    if (!current) throw new FatalError("생성 작업을 찾을 수 없습니다.");
    if (
      current.status === "completed" ||
      current.status === "needs_attention" ||
      current.status === "failed" || current.status === "cancelled" || current.status === "awaiting_review"
    ) {
      return { jobId, status: current.status };
    }
    if (current.run_token !== runToken) {
      throw new FatalError("새 실행으로 교체된 생성 작업입니다.");
    }
    row = current;
  }
  throw new RetryableError("최종 품질 결과를 안전하게 저장하는 중입니다.", {
    retryAfter: "5s",
  });
}

async function failGenerationJobStep(
  jobId: string,
  runToken: string,
  message: string
): Promise<WorkflowResult> {
  "use step";
  const currentBeforeFailure = await loadWorkerJobById(jobId);
  if (currentBeforeFailure && ["completed", "needs_attention", "failed", "cancelled", "awaiting_review"].includes(currentBeforeFailure.status)) {
    return { jobId, status: currentBeforeFailure.status as WorkflowResult["status"] };
  }
  if (currentBeforeFailure && currentBeforeFailure.run_token !== runToken) throw new FatalError("새 실행으로 교체된 생성 작업입니다.");
  const reviewDraft = projectGenerationReviewDraft(currentBeforeFailure?.checkpoint);
  const admin = createGenerationWorkerClient();
  const { data, error } = await withSupabaseRequestTimeout(
    admin
      .from("generation_jobs")
      .update({
        status: "failed",
        stage: "저장된 단계에서 처리가 멈춤",
        progress: 100,
        quality_passed: false,
        error_message: message.slice(0, 500),
        review_draft: reviewDraft ? asJson(reviewDraft) : null,
        completed_at: new Date().toISOString(),
        run_token: crypto.randomUUID(),
        workflow_missing_count: 0,
        workflow_missing_since: null,
      })
      .eq("id", jobId)
      .eq("run_token", runToken)
      .in("status", ["queued", "retrieving", "drafting", "reviewing", "repairing"])
      .select("id")
      .maybeSingle(),
    WORKER_DB_REQUEST_MAX_MS
  );
  if (error) {
    // DB 장애가 수초보다 길어도 UI가 영구히 진행 중으로 남지 않도록 충분히 재시도한다.
    throw new RetryableError(`생성 작업 실패 상태 저장 실패: ${error.message}`, {
      retryAfter: "15s",
    });
  }
  if (data) return { jobId, status: "failed" };

  const current = await loadWorkerJobById(jobId);
  if (
    current?.status === "completed" ||
    current?.status === "needs_attention" ||
    current?.status === "failed" || current?.status === "cancelled" || current?.status === "awaiting_review"
  ) {
    return { jobId, status: current.status };
  }
  if (current && current.run_token !== runToken) {
    throw new FatalError("새 실행으로 교체된 생성 작업입니다.");
  }
  throw new RetryableError("실패 상태를 작업 원장에 다시 저장합니다.", {
    retryAfter: "15s",
  });
}

prepareGenerationJobStep.maxRetries = 6;
generateDocumentOutlineStep.maxRetries = 6;
pauseForOutlineReviewStep.maxRetries = 3;
supplementOutlineEvidenceStep.maxRetries = 3;
reviewOutlineEvidenceStep.maxRetries = 3;
generateDocumentBatchStep.maxRetries = 6;
generateSlideOutlineStep.maxRetries = 6;
generateSlideBatchStep.maxRetries = 6;
reviewGenerationStep.maxRetries = 3;
repairDocumentSectionStep.maxRetries = 6;
repairSlideStep.maxRetries = 6;
finishGenerationJobStep.maxRetries = 6;
failGenerationJobStep.maxRetries = 12;

/**
 * 장시간 정밀 생성을 개별 Function 상한보다 짧은 단계로 나눠 실행한다.
 * Workflow 인수·반환에는 본문을 넣지 않고, 모든 산출물은 generation_jobs.checkpoint/result에 둔다.
 */
export async function generateMaterialWorkflow(
  jobId: string,
  runToken: string
): Promise<WorkflowResult> {
  "use workflow";
  try {
    const prepared = await prepareGenerationJobStep(jobId, runToken);
    if (prepared.type === "slides") {
      await generateSlideOutlineStep(jobId, runToken, prepared.slideCount);
      if (await pauseForOutlineReviewStep(jobId, runToken)) return { jobId, status: "awaiting_review" };
      for (let index = 0; index < MAX_OUTLINE_EVIDENCE_SEARCHES; index += 1) {
        await supplementOutlineEvidenceStep(jobId, runToken, index);
      }
      await reviewOutlineEvidenceStep(jobId, runToken);
      for (let start = 0; start < prepared.slideCount; start += SLIDE_BATCH_SIZE) {
        await generateSlideBatchStep(
          jobId,
          runToken,
          start,
          Math.min(prepared.slideCount, start + SLIDE_BATCH_SIZE)
        );
      }
    } else {
      await generateDocumentOutlineStep(jobId, runToken);
      if (await pauseForOutlineReviewStep(jobId, runToken)) return { jobId, status: "awaiting_review" };
      for (let index = 0; index < MAX_OUTLINE_EVIDENCE_SEARCHES; index += 1) {
        await supplementOutlineEvidenceStep(jobId, runToken, index);
      }
      await reviewOutlineEvidenceStep(jobId, runToken);
      const headings = documentHeadings(prepared.type);
      for (let start = 0; start < headings.length; start += DOCUMENT_BATCH_SIZE) {
        await generateDocumentBatchStep(
          jobId,
          runToken,
          start,
          Math.min(headings.length, start + DOCUMENT_BATCH_SIZE)
        );
      }
    }

    let review = await reviewGenerationStep(jobId, runToken, 0);
    for (
      let round = 1;
      round <= MAX_QUALITY_REPAIR_ROUNDS && review.totalIssues > 0;
      round += 1
    ) {
      if (prepared.type === "slides") {
        for (const index of review.repairIndices.filter((index) => !prepared.selectedRepairIndices || prepared.selectedRepairIndices.includes(index))) {
          await repairSlideStep(jobId, runToken, round, index);
        }
      } else {
        for (const index of review.repairIndices.filter((index) => !prepared.selectedRepairIndices || prepared.selectedRepairIndices.includes(index))) {
          await repairDocumentSectionStep(jobId, runToken, round, index);
        }
      }
      review = await reviewGenerationStep(jobId, runToken, round);
    }
    return await finishGenerationJobStep(jobId, runToken, review);
  } catch (error) {
    return await failGenerationJobStep(jobId, runToken, safeWorkflowFailureMessage(error));
  }
}

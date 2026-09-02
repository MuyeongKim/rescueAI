import type { ValidatedGenerateRequest } from "@/lib/generation-request";

export const GENERATION_JOB_STATUSES = [
  "queued",
  "retrieving",
  "drafting",
  "reviewing",
  "repairing",
  "completed",
  "needs_attention",
  "failed",
] as const;

export type GenerationJobStatus = (typeof GENERATION_JOB_STATUSES)[number];

export type GenerationJobResult = Record<string, unknown>;

/** 브라우저에 공개해도 되는 작업 상태. run_token/checkpoint는 절대 포함하지 않는다. */
export type PublicGenerationJob = {
  id: string;
  status: GenerationJobStatus;
  stage: string;
  progress: number;
  /** 최초 실행 뒤 작업 전체를 다시 발행한 횟수. Workflow 내부 step 재시도와는 별개다. */
  attempt: number;
  estimatedSeconds: number;
  qualityPassed: boolean;
  request: ValidatedGenerateRequest;
  result: GenerationJobResult | null;
  errorMessage: string | null;
  workflowRunId: string | null;
  revision: number;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
};

export function isTerminalGenerationJobStatus(status: GenerationJobStatus): boolean {
  return status === "completed" || status === "needs_attention" || status === "failed";
}

/** queued를 벗어났거나 run ID가 저장된 뒤에만 브라우저와 독립된 실행으로 안내한다. */
export function isGenerationJobDispatchConfirmed(
  job: Pick<PublicGenerationJob, "status" | "workflowRunId">
): boolean {
  return job.status !== "queued" || Boolean(job.workflowRunId);
}

/** 실제 workflow 단계 수를 반영한 보수적 최초 예상. 상한이 아니라 안내값이다. */
export function durableGenerationEstimateSeconds(
  type: ValidatedGenerateRequest["type"],
  duration: ValidatedGenerateRequest["duration"]
): number {
  if (type === "plan") return 7 * 60;
  if (type === "lesson") return 9 * 60;
  if (duration === "1시간") return 12 * 60;
  if (duration === "2시간") return 16 * 60;
  return 20 * 60;
}

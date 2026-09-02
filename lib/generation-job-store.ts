import "server-only";

import { generateRequestSchema } from "@/lib/generation-request";
import {
  GENERATION_JOB_STATUSES,
  type GenerationJobResult,
  type GenerationJobStatus,
  type PublicGenerationJob,
} from "@/lib/generation-job";

export const GENERATION_JOB_PUBLIC_COLUMNS =
  "id,status,stage,progress,attempt,estimated_seconds,quality_passed,request,result,error_message,workflow_run_id,revision,created_at,started_at,updated_at,completed_at";

type PublicGenerationJobRow = {
  id: string;
  status: string;
  stage: string;
  progress: number;
  attempt: number;
  estimated_seconds: number;
  quality_passed: boolean;
  request: unknown;
  result: unknown;
  error_message: string | null;
  workflow_run_id: string | null;
  revision: number;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  completed_at: string | null;
};

function generationJobStatus(value: string): GenerationJobStatus {
  if (GENERATION_JOB_STATUSES.includes(value as GenerationJobStatus)) {
    return value as GenerationJobStatus;
  }
  throw new Error("지원하지 않는 생성 작업 상태입니다.");
}

/** DB 행에서 worker 전용 필드를 제거하고 완료·품질 통과 결과만 공개한다. */
export function toPublicGenerationJob(row: PublicGenerationJobRow): PublicGenerationJob {
  const request = generateRequestSchema.parse(row.request);
  const status = generationJobStatus(row.status);
  const result =
    status === "completed" && row.quality_passed && row.result && typeof row.result === "object"
      ? (row.result as GenerationJobResult)
      : null;
  return {
    id: row.id,
    status,
    stage: row.stage,
    progress: Math.max(0, Math.min(100, Math.floor(row.progress))),
    attempt: Math.max(0, Math.floor(row.attempt)),
    estimatedSeconds: Math.max(1, Math.floor(row.estimated_seconds)),
    qualityPassed: row.quality_passed,
    request,
    result,
    errorMessage: row.error_message,
    workflowRunId: row.workflow_run_id,
    revision: Math.max(0, Math.floor(row.revision)),
    createdAt: row.created_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

import "server-only";

import { getRun } from "workflow/api";
import { WorkflowRunNotFoundError } from "workflow/errors";

import type { PublicGenerationJob } from "@/lib/generation-job";
import {
  GENERATION_JOB_PUBLIC_COLUMNS,
  toPublicGenerationJob,
} from "@/lib/generation-job-store";
import { createGenerationWorkerClient } from "@/lib/supabase/generation-worker";
import { withSupabaseRequestTimeout } from "@/lib/supabase/request-timeout";

const ACTIVE_STATUSES = ["queued", "retrieving", "drafting", "reviewing", "repairing"] as const;
const HEALTH_COLUMNS = `${GENERATION_JOB_PUBLIC_COLUMNS},user_id,run_token,last_progress_at,workflow_checked_at,workflow_missing_count,workflow_missing_since`;

export const GENERATION_ACTIVE_STALE_MS = 10 * 60 * 1000;
export const GENERATION_WORKFLOW_CHECK_LEASE_MS = 2 * 60 * 1000;
const WORKFLOW_STATUS_TIMEOUT_MS = 6_000;
const HEALTH_DB_REQUEST_TIMEOUT_MS = 10_000;
const WORKFLOW_MISSING_CONFIRMATIONS = 3;
const WORKFLOW_MISSING_MIN_AGE_MS = 4 * 60 * 1000;

type HealthJobRow = {
  id: string;
  user_id: string;
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
  run_token: string | null;
  last_progress_at: string;
  workflow_checked_at: string | null;
  workflow_missing_count: number;
  workflow_missing_since: string | null;
};

function isActiveStatus(status: string): boolean {
  return ACTIVE_STATUSES.includes(status as (typeof ACTIVE_STATUSES)[number]);
}

function olderThan(value: string | null, before: number): boolean {
  if (!value) return true;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= before;
}

async function workflowStatusWithTimeout(runId: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      getRun(runId).status,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Workflow 상태 조회 시간 초과")),
          WORKFLOW_STATUS_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 열린 화면의 폴링을 안전망으로 사용해, 실제 Workflow는 끝났지만 DB만 active로
 * 남은 작업을 재시도 가능한 failed 상태로 정리한다. pending/running/조회 실패는
 * 정상 장기 실행일 수 있으므로 절대 시간만 보고 실패시키지 않는다.
 */
export async function reconcileStalledActiveGenerationJob(
  job: PublicGenerationJob,
  userId: string
): Promise<PublicGenerationJob | null> {
  if (!isActiveStatus(job.status) || !job.workflowRunId) return null;
  const now = Date.now();
  // 공개 updated_at으로 먼저 거르면 정상적인 235초 모델 호출 동안 매 폴링마다
  // service-role 조회가 발생하지 않는다. 실제 판정은 아래 private last_progress_at으로 한다.
  if (!olderThan(job.updatedAt, now - GENERATION_ACTIVE_STALE_MS)) return null;

  const worker = createGenerationWorkerClient();
  const { data: candidateData, error: candidateError } = await withSupabaseRequestTimeout(
    worker
      .from("generation_jobs")
      .select(HEALTH_COLUMNS)
      .eq("id", job.id)
      .eq("user_id", userId)
      .maybeSingle(),
    HEALTH_DB_REQUEST_TIMEOUT_MS
  );
  if (candidateError || !candidateData) {
    if (candidateError) {
      console.error("[generation-job-reconciliation] candidate", candidateError);
    }
    return null;
  }
  const candidate = candidateData as unknown as HealthJobRow;
  if (
    !isActiveStatus(candidate.status) ||
    !candidate.workflow_run_id ||
    !candidate.run_token ||
    !olderThan(candidate.last_progress_at, now - GENERATION_ACTIVE_STALE_MS) ||
    !olderThan(candidate.workflow_checked_at, now - GENERATION_WORKFLOW_CHECK_LEASE_MS)
  ) {
    return null;
  }

  let claim = worker
    .from("generation_jobs")
    .update({ workflow_checked_at: new Date(now).toISOString() })
    .eq("id", candidate.id)
    .eq("user_id", userId)
    .eq("revision", candidate.revision)
    .eq("workflow_run_id", candidate.workflow_run_id)
    .eq("run_token", candidate.run_token)
    .in("status", [...ACTIVE_STATUSES])
    .lte("last_progress_at", new Date(now - GENERATION_ACTIVE_STALE_MS).toISOString());
  claim = candidate.workflow_checked_at
    ? claim.eq("workflow_checked_at", candidate.workflow_checked_at)
    : claim.is("workflow_checked_at", null);
  const { data: claimedData, error: claimError } = await withSupabaseRequestTimeout(
    claim.select(HEALTH_COLUMNS).maybeSingle(),
    HEALTH_DB_REQUEST_TIMEOUT_MS
  );
  if (claimError || !claimedData) {
    if (claimError) console.error("[generation-job-reconciliation] claim", claimError);
    return null;
  }
  const claimed = claimedData as unknown as HealthJobRow;

  let workflowStatus: "pending" | "running" | "completed" | "failed" | "cancelled";
  try {
    workflowStatus = await workflowStatusWithTimeout(claimed.workflow_run_id as string);
  } catch (error) {
    if (WorkflowRunNotFoundError.is(error)) {
      const firstMissingAt = claimed.workflow_missing_since ?? new Date(now).toISOString();
      const missingCount = Math.min(100, claimed.workflow_missing_count + 1);
      const firstMissingTimestamp = Date.parse(firstMissingAt);
      const confirmedMissing =
        missingCount >= WORKFLOW_MISSING_CONFIRMATIONS &&
        Number.isFinite(firstMissingTimestamp) &&
        firstMissingTimestamp <= now - WORKFLOW_MISSING_MIN_AGE_MS;
      const { data: missingData, error: missingError } = await withSupabaseRequestTimeout(
        worker
          .from("generation_jobs")
          .update(
            confirmedMissing
              ? {
                  status: "failed",
                  stage: "서버 생성 실행 연결을 복구해야 함",
                  progress: 100,
                  result: null,
                  quality_passed: false,
                  completed_at: new Date().toISOString(),
                  error_message:
                    "서버 생성 실행을 반복 확인했지만 찾지 못했습니다. 보존된 단계부터 다시 시도해 주세요.",
                  workflow_missing_count: missingCount,
                  workflow_missing_since: firstMissingAt,
                  run_token: crypto.randomUUID(),
                }
              : {
                  workflow_missing_count: missingCount,
                  workflow_missing_since: firstMissingAt,
                }
          )
          .eq("id", claimed.id)
          .eq("user_id", userId)
          .eq("revision", claimed.revision)
          .eq("workflow_run_id", claimed.workflow_run_id as string)
          .eq("run_token", claimed.run_token as string)
          .in("status", [...ACTIVE_STATUSES])
          .select(HEALTH_COLUMNS)
          .maybeSingle(),
        HEALTH_DB_REQUEST_TIMEOUT_MS
      );
      if (missingError) {
        console.error("[generation-job-reconciliation] missing run", missingError);
        return toPublicGenerationJob(claimed);
      }
      return missingData
        ? toPublicGenerationJob(missingData as unknown as HealthJobRow)
        : toPublicGenerationJob(claimed);
    }
    // 네트워크 단절, 5xx, API 시간 초과는 상태 미상이다. 정상 실행을 오판하지 않는다.
    console.error("[generation-job-reconciliation] workflow status", error);
    return toPublicGenerationJob(claimed);
  }
  if (workflowStatus === "pending" || workflowStatus === "running") {
    if (claimed.workflow_missing_count > 0 || claimed.workflow_missing_since) {
      const { data: resetData, error: resetError } = await withSupabaseRequestTimeout(
        worker
          .from("generation_jobs")
          .update({ workflow_missing_count: 0, workflow_missing_since: null })
          .eq("id", claimed.id)
          .eq("user_id", userId)
          .eq("revision", claimed.revision)
          .eq("workflow_run_id", claimed.workflow_run_id as string)
          .eq("run_token", claimed.run_token as string)
          .in("status", [...ACTIVE_STATUSES])
          .select(HEALTH_COLUMNS)
          .maybeSingle(),
        HEALTH_DB_REQUEST_TIMEOUT_MS
      );
      if (resetError) console.error("[generation-job-reconciliation] reset missing", resetError);
      if (resetData) return toPublicGenerationJob(resetData as unknown as HealthJobRow);
    }
    return toPublicGenerationJob(claimed);
  }

  const completedWithoutResult = workflowStatus === "completed";
  const { data: failedData, error: failedError } = await withSupabaseRequestTimeout(
    worker
      .from("generation_jobs")
      .update({
        status: "failed",
        stage: completedWithoutResult
          ? "최종 결과 저장을 복구해야 함"
          : "서버 생성 실행이 종료되어 복구 대기 중",
        progress: 100,
        result: null,
        quality_passed: false,
        completed_at: new Date().toISOString(),
        error_message: completedWithoutResult
          ? "서버 작업은 끝났지만 최종 결과 저장이 완료되지 않았습니다. 보존된 단계부터 다시 시도해 주세요."
          : "서버 생성 실행이 중단되었습니다. 보존된 단계부터 다시 시도해 주세요.",
        run_token: crypto.randomUUID(),
        workflow_missing_count: 0,
        workflow_missing_since: null,
      })
      .eq("id", claimed.id)
      .eq("user_id", userId)
      .eq("revision", claimed.revision)
      .eq("workflow_run_id", claimed.workflow_run_id as string)
      .eq("run_token", claimed.run_token as string)
      .in("status", [...ACTIVE_STATUSES])
      .select(HEALTH_COLUMNS)
      .maybeSingle(),
    HEALTH_DB_REQUEST_TIMEOUT_MS
  );
  if (failedError) {
    console.error("[generation-job-reconciliation] finalize", failedError);
    return toPublicGenerationJob(claimed);
  }
  if (failedData) return toPublicGenerationJob(failedData as unknown as HealthJobRow);

  const { data: current, error: currentError } = await withSupabaseRequestTimeout(
    worker
      .from("generation_jobs")
      .select(HEALTH_COLUMNS)
      .eq("id", claimed.id)
      .eq("user_id", userId)
      .maybeSingle(),
    HEALTH_DB_REQUEST_TIMEOUT_MS
  );
  if (currentError || !current) return toPublicGenerationJob(claimed);
  return toPublicGenerationJob(current as unknown as HealthJobRow);
}

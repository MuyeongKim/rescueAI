import "server-only";

import { start } from "workflow/api";

import { GENERATION_JOB_PUBLIC_COLUMNS } from "@/lib/generation-job-store";
import { createGenerationWorkerClient } from "@/lib/supabase/generation-worker";
import { generateMaterialWorkflow } from "@/workflows/generate-material";
import { withSupabaseRequestTimeout } from "@/lib/supabase/request-timeout";

// start 호출이 끊긴 저장 작업은 짧은 유예 뒤 새 run_token으로 회수한다. 이전 실행은
// token fence 때문에 모델 호출 전에 종료되므로, 긴 무응답보다 빠른 자동 복구를 우선한다.
export const GENERATION_DISPATCH_LEASE_MS = 60 * 1000;
const GENERATION_DISPATCH_START_MAX_MS = 30_000;
const GENERATION_DISPATCH_DB_MAX_MS = 10_000;

async function startGenerationWorkflow(jobId: string, runToken: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      start(generateMaterialWorkflow, [jobId, runToken]),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Workflow 시작 연결 시간 초과")),
          GENERATION_DISPATCH_START_MAX_MS
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Workflow 실행을 시작하고 추적 ID를 작업 원장에 기록한다.
 *
 * start()가 반환한 뒤에는 작업이 이미 큐에 들어간 상태다. 따라서 추적 ID만
 * 저장하지 못한 경우 실행 실패로 되돌리지 않고 null을 반환해 폴링으로 실제
 * 상태를 이어서 확인하게 한다.
 */
export async function dispatchGenerationJob(jobId: string, runToken: string) {
  const run = await startGenerationWorkflow(jobId, runToken);
  const worker = createGenerationWorkerClient();
  const { data, error } = await withSupabaseRequestTimeout(
    worker
      .from("generation_jobs")
      .update({ workflow_run_id: run.runId })
      .eq("id", jobId)
      .eq("run_token", runToken)
      .select(GENERATION_JOB_PUBLIC_COLUMNS)
      .maybeSingle(),
    GENERATION_DISPATCH_DB_MAX_MS
  );

  if (error) {
    console.error("[generation-job-dispatch] workflow run id persist", error);
    return null;
  }
  return data;
}

/** 시작 실패도 원장에 남겨 사용자가 저장된 단계에서 재시도할 수 있게 한다. */
export async function markGenerationDispatchFailed(
  jobId: string,
  runToken: string
) {
  const worker = createGenerationWorkerClient();
  const { data, error } = await withSupabaseRequestTimeout(
    worker
      .from("generation_jobs")
      .update({
        status: "failed",
        stage: "정밀 생성 작업을 시작하지 못함",
        progress: 100,
        quality_passed: false,
        result: null,
        error_message: "작업 실행 연결이 일시적으로 지연되었습니다. 저장된 요청으로 다시 시도해 주세요.",
        completed_at: new Date().toISOString(),
        // start() 결과가 모호한 경우에도 뒤늦은 이전 실행이 상태를 되살리지 못하게 한다.
        run_token: crypto.randomUUID(),
      })
      .eq("id", jobId)
      .eq("run_token", runToken)
      .eq("status", "queued")
      .is("workflow_run_id", null)
      .select(GENERATION_JOB_PUBLIC_COLUMNS)
      .maybeSingle(),
    GENERATION_DISPATCH_DB_MAX_MS
  );

  if (error) throw new Error(`생성 작업 실패 상태 저장 실패: ${error.message}`);
  if (data) return data;

  // Workflow가 먼저 retrieving 상태로 전환된 경우 그 실행을 실패로 덮지 않는다.
  const { data: current, error: currentError } = await withSupabaseRequestTimeout(
    worker
      .from("generation_jobs")
      .select(GENERATION_JOB_PUBLIC_COLUMNS)
      .eq("id", jobId)
      .eq("run_token", runToken)
      .maybeSingle(),
    GENERATION_DISPATCH_DB_MAX_MS
  );
  if (currentError) {
    throw new Error(`생성 작업 현재 상태 조회 실패: ${currentError.message}`);
  }
  return current;
}

/**
 * 요청 저장 뒤 프로세스가 종료되어 시작 호출 자체가 누락된 queued 작업을 회수한다.
 * revision + 상태 + 만료 시각 CAS로 여러 폴링 요청 중 하나만 복구권을 얻는다.
 */
export async function recoverStalledGenerationDispatch(
  jobId: string,
  userId: string,
  revision: number,
  attempt: number,
  staleBefore: string
) {
  const runToken = crypto.randomUUID();
  const worker = createGenerationWorkerClient();
  const { data: claimed, error } = await withSupabaseRequestTimeout(
    worker
      .from("generation_jobs")
      .update({
        status: "queued",
        stage: "중단된 작업 시작 연결을 자동 복구하는 중",
        progress: 0,
        attempt: Math.max(0, Math.floor(attempt)) + 1,
        workflow_run_id: null,
        run_token: runToken,
        workflow_checked_at: null,
        workflow_missing_count: 0,
        workflow_missing_since: null,
        error_message: null,
        completed_at: null,
      })
      .eq("id", jobId)
      .eq("user_id", userId)
      .eq("revision", revision)
      .eq("status", "queued")
      .is("workflow_run_id", null)
      .lte("updated_at", staleBefore)
      .select(GENERATION_JOB_PUBLIC_COLUMNS)
      .maybeSingle(),
    GENERATION_DISPATCH_DB_MAX_MS
  );

  if (error) throw new Error(`생성 작업 시작 복구권 확보 실패: ${error.message}`);
  if (!claimed) return null;

  try {
    return (await dispatchGenerationJob(jobId, runToken)) ?? claimed;
  } catch (dispatchError) {
    console.error("[generation-job-dispatch] stalled workflow recovery", dispatchError);
    return (await markGenerationDispatchFailed(jobId, runToken)) ?? claimed;
  }
}

import { z } from "zod";

import { requireApiUser } from "@/lib/auth";
import { DEMO } from "@/lib/demo-flag";
import {
  GENERATION_DISPATCH_LEASE_MS,
  dispatchGenerationJob,
  markGenerationDispatchFailed,
  recoverStalledGenerationDispatch,
} from "@/lib/generation-job-dispatch";
import {
  GENERATION_JOB_PUBLIC_COLUMNS,
  toPublicGenerationJob,
} from "@/lib/generation-job-store";
import { durableGenerationEstimateSeconds } from "@/lib/generation-job";
import { generateRequestSchema } from "@/lib/generation-request";
import {
  LimitedJsonBodyError,
  readLimitedJsonBody,
} from "@/lib/generated-material-save";
import { availableModels } from "@/lib/llm";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { createGenerationWorkerClient } from "@/lib/supabase/generation-worker";
import { withSupabaseRequestTimeout } from "@/lib/supabase/request-timeout";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/database.types";

const MAX_JOB_REQUEST_BYTES = 12 * 1024;
const JOB_DB_REQUEST_MAX_MS = 10_000;
const createJobSchema = generateRequestSchema.extend({
  jobId: z.string().uuid(),
  clientRequestId: z.string().uuid(),
});

const PREFERRED_PRECISION_MODELS = ["gemini-pro", "claude-sonnet-4-5"] as const;
const ACTIVE_GENERATION_STATUSES = [
  "queued",
  "retrieving",
  "drafting",
  "reviewing",
  "repairing",
] as const;

function qualityFirstModels(requested: string | undefined): string[] {
  const models = availableModels();
  const keys = new Set(models.map((model) => model.key));
  return Array.from(
    new Set([
      ...PREFERRED_PRECISION_MODELS.filter((key) => keys.has(key)),
      ...(requested && requested !== "gemini-flash" && keys.has(requested)
        ? [requested]
        : []),
      ...models.map((model) => model.key).filter((key) => key !== "gemini-flash"),
    ])
  );
}

async function findIdempotentJob(userId: string, clientRequestId: string) {
  const worker = createGenerationWorkerClient();
  const { data, error } = await withSupabaseRequestTimeout(
    worker
      .from("generation_jobs")
      .select(GENERATION_JOB_PUBLIC_COLUMNS)
      .eq("user_id", userId)
      .eq("client_request_id", clientRequestId)
      .maybeSingle(),
    JOB_DB_REQUEST_MAX_MS
  );
  if (error) throw new Error(`기존 생성 작업 조회 실패: ${error.message}`);
  return data;
}

async function findActiveJob(userId: string) {
  const worker = createGenerationWorkerClient();
  const { data, error } = await withSupabaseRequestTimeout(
    worker
      .from("generation_jobs")
      .select(GENERATION_JOB_PUBLIC_COLUMNS)
      .eq("user_id", userId)
      .in("status", [...ACTIVE_GENERATION_STATUSES])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    JOB_DB_REQUEST_MAX_MS
  );
  if (error) throw new Error(`진행 중 생성 작업 조회 실패: ${error.message}`);
  return data;
}

async function recoverIdempotentJobIfStalled(
  job: NonNullable<Awaited<ReturnType<typeof findIdempotentJob>>>,
  userId: string
) {
  const updatedAt = Date.parse(job.updated_at);
  const stalledBefore = new Date(Date.now() - GENERATION_DISPATCH_LEASE_MS);
  if (
    job.status !== "queued" ||
    job.workflow_run_id !== null ||
    !Number.isFinite(updatedAt) ||
    updatedAt > stalledBefore.getTime()
  ) {
    return job;
  }
  try {
    return (
      (await recoverStalledGenerationDispatch(
        job.id,
        userId,
        job.revision,
        job.attempt,
        stalledBefore.toISOString()
      )) ?? job
    );
  } catch (error) {
    // 같은 clientRequestId 응답은 유지하고, 상태 폴링에서도 복구를 다시 시도한다.
    console.error("[generate/jobs] stalled idempotent dispatch recovery", error);
    return job;
  }
}

export const maxDuration = 100;

export async function POST(request: Request) {
  if (DEMO) {
    return Response.json(
      { error: "데모 모드에서는 즉시 생성 방식을 사용합니다." },
      { status: 409 }
    );
  }

  const supabase = await createClient();
  const auth = await requireApiUser(supabase);
  if (!auth.ok) return auth.response;

  let input: unknown;
  try {
    input = await readLimitedJsonBody(request, MAX_JOB_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof LimitedJsonBodyError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "요청 내용을 확인해 주세요." }, { status: 400 });
  }

  const parsed = createJobSchema.safeParse(input);
  if (!parsed.success) {
    return Response.json(
      { error: "자료 유형·분야·훈련 주제와 입력 분량을 확인해 주세요." },
      { status: 400 }
    );
  }

  const { jobId, clientRequestId, ...rawRequest } = parsed.data;
  try {
    const existing = await findIdempotentJob(auth.user.id, clientRequestId);
    if (existing) {
      const current = await recoverIdempotentJobIfStalled(existing, auth.user.id);
      return Response.json(
        { job: toPublicGenerationJob(current) },
        { status: 202, headers: { "Cache-Control": "no-store" } }
      );
    }

    // 응답 유실 재전송은 제한하지 않고 기존 작업을 돌려준다. 실제 새 Workflow만 제한한다.
    const limited = rateLimit(`generate-job:${auth.user.id}`, 10, 60_000);
    if (!limited.ok) return tooManyRequests(limited.retryAfterSec);

    const modelCandidates = qualityFirstModels(rawRequest.model);
    if (modelCandidates.length === 0) {
      return Response.json(
        { error: "사용 가능한 정밀 생성 모델이 설정되지 않았습니다." },
        { status: 503 }
      );
    }
    const jobRequest = { ...rawRequest, model: modelCandidates[0] };

    const runToken = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const worker = createGenerationWorkerClient();
    const { data: inserted, error: insertError } = await withSupabaseRequestTimeout(
      worker
        .from("generation_jobs")
        .insert({
          id: jobId,
          user_id: auth.user.id,
          status: "queued",
          stage: "정밀 생성 작업을 준비하는 중",
          request: jobRequest as Json,
          checkpoint: { version: 1, modelCandidates, activeModelIndex: 0 },
          progress: 0,
          attempt: 0,
          estimated_seconds: durableGenerationEstimateSeconds(
            jobRequest.type,
            jobRequest.duration
          ),
          quality_passed: false,
          run_token: runToken,
          client_request_id: clientRequestId,
          started_at: startedAt,
        })
        .select(GENERATION_JOB_PUBLIC_COLUMNS)
        .single(),
      JOB_DB_REQUEST_MAX_MS
    );

    if (insertError) {
      if (insertError.code === "23505") {
        const duplicate = await findIdempotentJob(auth.user.id, clientRequestId);
        if (duplicate) {
          const current = await recoverIdempotentJobIfStalled(duplicate, auth.user.id);
          return Response.json(
            { job: toPublicGenerationJob(current) },
            { status: 202, headers: { "Cache-Control": "no-store" } }
          );
        }
        const active = await findActiveJob(auth.user.id);
        if (active) {
          return Response.json(
            {
              error: "이미 진행 중인 품질 우선 생성 작업이 있습니다.",
              job: toPublicGenerationJob(active),
            },
            { status: 409, headers: { "Cache-Control": "no-store" } }
          );
        }
      }
      throw new Error(`생성 작업 저장 실패: ${insertError.message}`);
    }

    try {
      const dispatched = await dispatchGenerationJob(inserted.id, runToken);
      return Response.json(
        { job: toPublicGenerationJob(dispatched ?? inserted) },
        { status: 202, headers: { "Cache-Control": "no-store" } }
      );
    } catch (error) {
      console.error("[generate/jobs] workflow dispatch failed", error);
      const failed = await markGenerationDispatchFailed(inserted.id, runToken);
      return Response.json(
        { job: toPublicGenerationJob(failed ?? inserted) },
        { status: 202, headers: { "Cache-Control": "no-store" } }
      );
    }
  } catch (error) {
    console.error("[generate/jobs]", error);
    return Response.json(
      { error: "생성 작업을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요." },
      { status: 500 }
    );
  }
}

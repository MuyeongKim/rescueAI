import { z } from "zod";

import { requireApiUser } from "@/lib/auth";
import {
  dispatchGenerationJob,
  markGenerationDispatchFailed,
} from "@/lib/generation-job-dispatch";
import {
  GENERATION_JOB_PUBLIC_COLUMNS,
  toPublicGenerationJob,
} from "@/lib/generation-job-store";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { createGenerationWorkerClient } from "@/lib/supabase/generation-worker";
import { withSupabaseRequestTimeout } from "@/lib/supabase/request-timeout";
import { createClient } from "@/lib/supabase/server";

const jobIdSchema = z.string().uuid();
const JOB_RETRY_DB_REQUEST_MAX_MS = 10_000;

export const maxDuration = 100;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const parsedId = jobIdSchema.safeParse(id);
  if (!parsedId.success) {
    return Response.json({ error: "올바르지 않은 작업 번호입니다." }, { status: 400 });
  }

  const supabase = await createClient();
  const auth = await requireApiUser(supabase);
  if (!auth.ok) return auth.response;

  const limited = rateLimit(`generate-job-retry:${auth.user.id}`, 6, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSec);

  let read;
  try {
    read = await withSupabaseRequestTimeout(
      supabase
        .from("generation_jobs")
        .select(GENERATION_JOB_PUBLIC_COLUMNS)
        .eq("id", parsedId.data)
        .eq("user_id", auth.user.id)
        .maybeSingle(),
      JOB_RETRY_DB_REQUEST_MAX_MS
    );
  } catch (readFailure) {
    console.error("[generate/jobs/:id/retry] read timeout", readFailure);
    return Response.json({ error: "생성 작업 확인이 지연되고 있습니다." }, { status: 503 });
  }
  const { data: current, error: readError } = read;
  if (readError) {
    console.error("[generate/jobs/:id/retry] read", readError);
    return Response.json({ error: "생성 작업을 확인하지 못했습니다." }, { status: 500 });
  }
  if (!current) return Response.json({ error: "생성 작업을 찾을 수 없습니다." }, { status: 404 });
  if (current.status !== "failed" && current.status !== "needs_attention") {
    return Response.json(
      { error: "실패했거나 보완이 필요한 작업만 다시 시도할 수 있습니다." },
      { status: 409 }
    );
  }

  const runToken = crypto.randomUUID();
  const worker = createGenerationWorkerClient();
  let queuedResult;
  try {
    queuedResult = await withSupabaseRequestTimeout(
      worker
        .from("generation_jobs")
        .update({
          status: "queued",
          stage: "저장된 단계부터 다시 준비하는 중",
          progress: 0,
          attempt: current.attempt + 1,
          quality_passed: false,
          result: null,
          workflow_run_id: null,
          run_token: runToken,
          workflow_checked_at: null,
          workflow_missing_count: 0,
          workflow_missing_since: null,
          error_message: null,
          completed_at: null,
          started_at: new Date().toISOString(),
        })
        .eq("id", current.id)
        .eq("user_id", auth.user.id)
        .eq("revision", current.revision)
        .in("status", ["failed", "needs_attention"])
        .select(GENERATION_JOB_PUBLIC_COLUMNS)
        .maybeSingle(),
      JOB_RETRY_DB_REQUEST_MAX_MS
    );
  } catch (updateFailure) {
    console.error("[generate/jobs/:id/retry] queue timeout", updateFailure);
    return Response.json({ error: "재시도 상태 저장이 지연되고 있습니다." }, { status: 503 });
  }
  const { data: queued, error: updateError } = queuedResult;

  if (updateError) {
    console.error("[generate/jobs/:id/retry] queue", updateError);
    if (updateError.code === "23505") {
      return Response.json(
        { error: "다른 품질 우선 생성 작업이 진행 중입니다. 완료 후 다시 시도해 주세요." },
        { status: 409 }
      );
    }
    return Response.json({ error: "재시도 상태를 저장하지 못했습니다." }, { status: 500 });
  }
  if (!queued) {
    return Response.json(
      { error: "다른 화면에서 작업 상태가 변경되었습니다. 새로고침 후 확인해 주세요." },
      { status: 409 }
    );
  }

  try {
    const dispatched = await dispatchGenerationJob(queued.id, runToken);
    return Response.json(
      { job: toPublicGenerationJob(dispatched ?? queued) },
      { status: 202, headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("[generate/jobs/:id/retry] dispatch", error);
    const failed = await markGenerationDispatchFailed(queued.id, runToken);
    return Response.json(
      { job: toPublicGenerationJob(failed ?? queued) },
      { status: 202, headers: { "Cache-Control": "no-store" } }
    );
  }
}

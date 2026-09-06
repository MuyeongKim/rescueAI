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
import { readLimitedJsonBody, LimitedJsonBodyError } from "@/lib/generated-material-save";
import { applyGenerationReviewDraftEdit } from "@/lib/generation-job-review";
import { generateRequestSchema } from "@/lib/generation-request";
import type { Json } from "@/lib/database.types";

const jobIdSchema = z.string().uuid();
const JOB_RETRY_DB_REQUEST_MAX_MS = 10_000;
const retrySchema = z.object({
  revision: z.number().int().nonnegative().optional(),
  repairIndices: z.array(z.number().int().min(0).max(19)).min(1).max(20).optional(),
  reviewDraft: z.record(z.unknown()).optional(),
}).strict().refine((value) => !(value.reviewDraft || value.repairIndices) || value.revision !== undefined);

export const maxDuration = 100;

export async function POST(
  request: Request,
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
  let input: z.infer<typeof retrySchema>;
  try { input = retrySchema.parse(request.body ? await readLimitedJsonBody(request, 768 * 1024) : {}); }
  catch (error) { return Response.json({ error: error instanceof LimitedJsonBodyError ? error.message : "보완할 초안과 작업 개정 번호를 확인해 주세요." }, { status: error instanceof LimitedJsonBodyError ? error.status : 400 }); }

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
  if (current.status !== "failed" && current.status !== "needs_attention" && current.status !== "cancelled") {
    return Response.json(
      { error: "실패했거나 보완이 필요한 작업만 다시 시도할 수 있습니다." },
      { status: 409 }
    );
  }
  if (input.revision !== undefined && input.revision !== current.revision) return Response.json({ error: "다른 화면에서 초안이 변경되었습니다. 최신 상태를 확인해 주세요.", job: toPublicGenerationJob(current) }, { status: 409 });

  const runToken = crypto.randomUUID();
  const worker = createGenerationWorkerClient();
  let checkpointPatch: { checkpoint?: Json } = {};
  if (input.reviewDraft || input.repairIndices) {
    let privateRead;
    try {
      privateRead = await withSupabaseRequestTimeout(worker.from("generation_jobs")
        .select("checkpoint,revision").eq("id", current.id).eq("user_id", auth.user.id).eq("revision", current.revision).maybeSingle(), JOB_RETRY_DB_REQUEST_MAX_MS);
    } catch (readError) {
      console.error("[generate/jobs/retry] review draft lookup", readError);
      return Response.json({ error: "저장된 초안 조회가 지연되고 있습니다." }, { status: 503 });
    }
    const { data: privateRow, error: privateError } = privateRead;
    if (privateError) return Response.json({ error: "저장된 초안을 확인하지 못했습니다." }, { status: 503 });
    if (!privateRow) return Response.json({ error: "초안이 변경되었습니다. 최신 상태를 확인해 주세요." }, { status: 409 });
    try {
      const validated = generateRequestSchema.parse(current.request);
      const checkpoint = (input.reviewDraft ? applyGenerationReviewDraftEdit(privateRow.checkpoint, validated.type, input.reviewDraft) : privateRow.checkpoint) as Record<string, Json>;
      const draft = checkpoint.draft as { sections?: unknown[] } | undefined;
      const count = validated.type === "slides" ? (checkpoint.slides as unknown[] | undefined)?.length ?? 0 : draft?.sections?.length ?? 0;
      if (input.repairIndices?.some((index) => index >= count)) throw new Error("저장된 초안에 없는 보완 항목입니다.");
      checkpointPatch = { checkpoint: JSON.parse(JSON.stringify({ ...checkpoint,
        selectedRepairIndices: input.repairIndices ? Array.from(new Set(input.repairIndices)) : undefined,
        selectedRepairRunToken: runToken,
      })) as Json };
    } catch (editError) { return Response.json({ error: editError instanceof z.ZodError ? "초안의 제목·본문 분량을 확인해 주세요." : editError instanceof Error ? editError.message : "초안을 확인해 주세요." }, { status: 422 }); }
  }
  let queuedResult;
  try {
    queuedResult = await withSupabaseRequestTimeout(
      worker
        .from("generation_jobs")
        .update({
          ...checkpointPatch,
          status: "queued",
          stage: "저장된 단계부터 다시 준비하는 중",
          progress: 0,
          attempt: current.attempt + 1,
          quality_passed: false,
          result: null,
          review_draft: null,
          quality_issues: [],
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
        .in("status", ["failed", "needs_attention", "cancelled"])
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

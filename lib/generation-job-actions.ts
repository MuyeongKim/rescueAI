import "server-only";
import { z } from "zod";
import { getRun } from "workflow/api";
import { requireApiUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createGenerationWorkerClient } from "@/lib/supabase/generation-worker";
import { withSupabaseRequestTimeout } from "@/lib/supabase/request-timeout";
import { readLimitedJsonBody, LimitedJsonBodyError } from "@/lib/generated-material-save";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { GENERATION_JOB_PUBLIC_COLUMNS, toPublicGenerationJob } from "@/lib/generation-job-store";
import { applyGenerationOutlineEdit, generationOutlineEditSchema, projectGenerationOutline, projectGenerationReviewDraft } from "@/lib/generation-job-review";
import { generateRequestSchema } from "@/lib/generation-request";
import { dispatchGenerationJob, markGenerationDispatchFailed } from "@/lib/generation-job-dispatch";
import type { Json } from "@/lib/database.types";

const baseSchema = z.object({ revision: z.number().int().nonnegative() }).strict();
const reviewSchema = baseSchema.extend({ outline: generationOutlineEditSchema.optional() }).strict();
const ACTIVE = ["queued", "retrieving", "drafting", "reviewing", "repairing"] as const;

export async function generationJobAction(request: Request, id: string, action: "review" | "cancel") {
  if (!z.string().uuid().safeParse(id).success) return Response.json({ error: "올바르지 않은 작업 번호입니다." }, { status: 400 });
  const client = await createClient();
  const auth = await requireApiUser(client);
  if (!auth.ok) return auth.response;
  const limited = rateLimit(`generate-job-${action}:${auth.user.id}`, 10, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSec);
  let body: z.infer<typeof reviewSchema>;
  try {
    const input = await readLimitedJsonBody(request, 64 * 1024);
    body = (action === "review" ? reviewSchema : baseSchema).parse(input);
  } catch (error) {
    return Response.json({ error: error instanceof LimitedJsonBodyError ? error.message : "목차와 작업 개정 번호를 확인해 주세요." }, { status: error instanceof LimitedJsonBodyError ? error.status : 400 });
  }
  const worker = createGenerationWorkerClient();
  try {
    // The authenticated owner is bound on every read and CAS write. Private fields never leave this route.
    const { data: current, error } = await withSupabaseRequestTimeout(worker.from("generation_jobs")
      .select(`${GENERATION_JOB_PUBLIC_COLUMNS},checkpoint,run_token`).eq("id", id).eq("user_id", auth.user.id).maybeSingle(), 10_000);
    if (error) throw error;
    if (!current) return Response.json({ error: "생성 작업을 찾을 수 없습니다." }, { status: 404 });
    if (action === "cancel" && current.status === "cancelled") return Response.json({ job: toPublicGenerationJob(current) }, { headers: { "Cache-Control": "no-store" } });
    if (current.revision !== body.revision) return Response.json({ error: "다른 화면에서 작업이 변경되었습니다. 최신 상태를 확인해 주세요.", job: toPublicGenerationJob(current) }, { status: 409 });
    if (action === "cancel") {
      if (![...ACTIVE, "awaiting_review"].includes(current.status as typeof ACTIVE[number])) return Response.json({ error: "진행 중이거나 목차 검토 중인 작업만 중단할 수 있습니다." }, { status: 409 });
      const draft = projectGenerationReviewDraft(current.checkpoint);
      const { data: cancelled, error: updateError } = await withSupabaseRequestTimeout(worker.from("generation_jobs").update({
        status: "cancelled", stage: "사용자가 작업을 중단함", result: null, quality_passed: false,
        run_token: crypto.randomUUID(), review_draft: draft ? JSON.parse(JSON.stringify(draft)) as Json : null,
        completed_at: new Date().toISOString(), error_message: null,
      }).eq("id", id).eq("user_id", auth.user.id).eq("revision", body.revision)
        .in("status", [...ACTIVE, "awaiting_review"]).select(GENERATION_JOB_PUBLIC_COLUMNS).maybeSingle(), 10_000);
      if (updateError) throw updateError;
      if (!cancelled) return Response.json({ error: "중단 전에 작업 상태가 변경되었습니다. 최신 상태를 확인해 주세요." }, { status: 409 });
      // DB token revocation is authoritative even if provider cancellation is delayed.
      if (current.workflow_run_id && current.status !== "awaiting_review") {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([getRun(current.workflow_run_id).cancel(), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Workflow cancellation deadline")), 6_000);
          })]);
        } catch (cancelError) { console.error("[generate/jobs/cancel] provider cancellation", cancelError); }
        finally { if (timer) clearTimeout(timer); }
      }
      return Response.json({ job: toPublicGenerationJob(cancelled) }, { headers: { "Cache-Control": "no-store" } });
    }
    if (current.status !== "awaiting_review") return Response.json({ error: "목차 검토를 기다리는 작업만 진행할 수 있습니다." }, { status: 409 });
    const parsedRequest = generateRequestSchema.parse(current.request);
    const original = projectGenerationOutline(current.checkpoint, parsedRequest.type);
    if (!original) return Response.json({ error: "저장된 목차를 확인하지 못했습니다." }, { status: 422 });
    let checkpoint: Json;
    try {
      const outline = "outline" in body && body.outline ? body.outline : {
        title: original.title, items: original.items.map(({ title, purpose, keyPoints, actionRequirements, minutes }) => ({ title, purpose, keyPoints, actionRequirements, minutes })),
      };
      checkpoint = applyGenerationOutlineEdit(current.checkpoint, parsedRequest, outline);
    } catch (editError) { return Response.json({ error: editError instanceof Error ? editError.message : "목차를 확인해 주세요." }, { status: 422 }); }
    const runToken = crypto.randomUUID();
    const { data: queued, error: updateError } = await withSupabaseRequestTimeout(worker.from("generation_jobs").update({
      status: "queued", stage: "확인한 목차로 본문 제작을 준비하는 중", checkpoint,
      result: null, quality_passed: false, workflow_run_id: null, run_token: runToken,
      started_at: new Date().toISOString(), completed_at: null, error_message: null,
      workflow_checked_at: null, workflow_missing_count: 0, workflow_missing_since: null,
      review_outline: null, review_draft: null, quality_issues: [], progress: 0,
    }).eq("id", id).eq("user_id", auth.user.id).eq("revision", body.revision).eq("status", "awaiting_review")
      .select(GENERATION_JOB_PUBLIC_COLUMNS).maybeSingle(), 10_000);
    if (updateError?.code === "23505") return Response.json({ error: "다른 생성 작업이 진행 중입니다. 해당 작업을 완료하거나 중단한 뒤 진행해 주세요." }, { status: 409 });
    if (updateError) throw updateError;
    if (!queued) return Response.json({ error: "다른 화면에서 목차가 처리되었습니다. 최신 상태를 확인해 주세요." }, { status: 409 });
    let dispatched;
    try { dispatched = await dispatchGenerationJob(id, runToken); }
    catch (dispatchError) { console.error("[generate/jobs/review] dispatch", dispatchError); dispatched = await markGenerationDispatchFailed(id, runToken); }
    return Response.json({ job: toPublicGenerationJob(dispatched ?? queued) }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(`[generate/jobs/${action}]`, error);
    return Response.json({ error: "작업 상태를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요." }, { status: 503 });
  }
}

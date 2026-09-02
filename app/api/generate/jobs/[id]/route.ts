import { z } from "zod";

import { requireApiUser } from "@/lib/auth";
import {
  GENERATION_DISPATCH_LEASE_MS,
  recoverStalledGenerationDispatch,
} from "@/lib/generation-job-dispatch";
import {
  GENERATION_JOB_PUBLIC_COLUMNS,
  toPublicGenerationJob,
} from "@/lib/generation-job-store";
import { reconcileStalledActiveGenerationJob } from "@/lib/generation-job-reconciliation";
import { createClient } from "@/lib/supabase/server";
import { withSupabaseRequestTimeout } from "@/lib/supabase/request-timeout";

const jobIdSchema = z.string().uuid();
const JOB_STATUS_DB_REQUEST_MAX_MS = 10_000;

export const maxDuration = 100;

export async function GET(
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

  let lookup;
  try {
    lookup = await withSupabaseRequestTimeout(
      supabase
        .from("generation_jobs")
        .select(GENERATION_JOB_PUBLIC_COLUMNS)
        .eq("id", parsedId.data)
        .eq("user_id", auth.user.id)
        .maybeSingle(),
      JOB_STATUS_DB_REQUEST_MAX_MS
    );
  } catch (lookupError) {
    console.error("[generate/jobs/:id] lookup timeout", lookupError);
    return Response.json({ error: "생성 작업 상태 조회가 지연되고 있습니다." }, { status: 503 });
  }
  const { data, error } = lookup;

  if (error) {
    console.error("[generate/jobs/:id]", error);
    return Response.json({ error: "생성 작업 상태를 확인하지 못했습니다." }, { status: 500 });
  }
  if (!data) return Response.json({ error: "생성 작업을 찾을 수 없습니다." }, { status: 404 });

  let current = data;
  const updatedAt = Date.parse(data.updated_at);
  const stalledBefore = new Date(Date.now() - GENERATION_DISPATCH_LEASE_MS);
  if (
    data.status === "queued" &&
    data.workflow_run_id === null &&
    Number.isFinite(updatedAt) &&
    updatedAt <= stalledBefore.getTime()
  ) {
    try {
      const recovered = await recoverStalledGenerationDispatch(
        data.id,
        auth.user.id,
        data.revision,
        data.attempt,
        stalledBefore.toISOString()
      );
      if (recovered) current = recovered;
    } catch (recoveryError) {
      // 다음 폴링이 같은 CAS 복구를 다시 시도할 수 있으므로 상태 조회 자체는 유지한다.
      console.error("[generate/jobs/:id] stalled dispatch recovery", recoveryError);
    }
  }

  let publicJob = toPublicGenerationJob(current);
  try {
    publicJob =
      (await reconcileStalledActiveGenerationJob(publicJob, auth.user.id)) ?? publicJob;
  } catch (reconcileError) {
    // 상태 확인 안전망의 장애가 정상 폴링을 막아서는 안 된다.
    console.error("[generate/jobs/:id] workflow reconciliation", reconcileError);
  }

  return Response.json(
    { job: publicJob },
    { headers: { "Cache-Control": "no-store" } }
  );
}

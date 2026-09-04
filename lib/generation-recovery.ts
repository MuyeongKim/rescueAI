import "server-only";
import { createClient } from "@/lib/supabase/server";
import { DEMO } from "@/lib/demo-flag";
import { generateRequestSchema } from "@/lib/generation-request";
import { GENERATION_JOB_STATUSES, type GenerationJobStatus } from "@/lib/generation-job";
import { withSupabaseRequestTimeout } from "@/lib/supabase/request-timeout";

export type GenerationJobSummary = { id: string; status: GenerationJobStatus; stage: string; topic: string; type: string; updatedAt: string };
export async function listMyGenerationJobs(limit = 12): Promise<GenerationJobSummary[]> {
  if (DEMO) return [];
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const { data, error } = await withSupabaseRequestTimeout(supabase.from("generation_jobs")
    .select("id,status,stage,request,updated_at").eq("user_id", user.id)
    .order("updated_at", { ascending: false }).limit(Math.min(50, Math.max(1, limit))), 10_000);
  if (error) return [];
  return (data ?? []).flatMap((row) => {
    const request = generateRequestSchema.safeParse(row.request);
    if (!request.success || !GENERATION_JOB_STATUSES.includes(row.status as GenerationJobStatus)) return [];
    return [{ id: row.id, status: row.status as GenerationJobStatus, stage: row.stage,
      topic: request.data.topic, type: request.data.type, updatedAt: row.updated_at }];
  });
}

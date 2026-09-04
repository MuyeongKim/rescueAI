import { z } from "zod";
import { requireApiUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { LimitedJsonBodyError, readLimitedJsonBody } from "@/lib/generated-material-save";
import { generationDraftFingerprint, generationDraftKeySchema, generationDraftSnapshotSchema, MAX_GENERATION_DRAFT_BYTES } from "@/lib/generation-draft";
import { withSupabaseRequestTimeout } from "@/lib/supabase/request-timeout";
import type { Json } from "@/lib/database.types";

const bodySchema = z.object({ draftKey: generationDraftKeySchema, revision: z.number().int().nonnegative(), snapshot: generationDraftSnapshotSchema });
const columns = "id,draft_key,revision,updated_at";
const deleteSchema = z.object({ id: z.string().uuid(), updatedAt: z.string().datetime({ offset: true }) }).strict();

/** 목록에서 사용자가 명시적으로 삭제한 개인 초안만 마지막 수정 시각 CAS로 제거한다. */
export async function DELETE(request: Request) {
  const supabase = await createClient();
  const auth = await requireApiUser(supabase);
  if (!auth.ok) return auth.response;
  const limited = rateLimit(`generation-draft-delete:${auth.user.id}`, 30, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSec);
  try {
    const parsed = deleteSchema.safeParse(await readLimitedJsonBody(request, 2 * 1024));
    if (!parsed.success) return Response.json({ error: "삭제할 편집 초안 정보를 확인해 주세요." }, { status: 400 });
    const { data, error } = await withSupabaseRequestTimeout(supabase.from("generation_drafts").delete()
      .eq("id", parsed.data.id).eq("user_id", auth.user.id).eq("updated_at", parsed.data.updatedAt)
      .select("id").maybeSingle(), 10_000);
    if (error) throw error;
    if (!data) return Response.json({ error: "초안이 변경되었거나 이미 삭제되었습니다. 목록을 새로고침하여 최신 내용을 확인해 주세요." }, { status: 409 });
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof LimitedJsonBodyError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[generate/drafts] private snapshot delete failed", error instanceof Error ? error.message : "database failure");
    return Response.json({ error: "편집 초안을 삭제하지 못했습니다. 다시 시도해 주세요." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const auth = await requireApiUser(supabase);
  if (!auth.ok) return auth.response;
  const limited = rateLimit(`generation-draft:${auth.user.id}`, 90, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSec);
  try {
    const parsed = bodySchema.safeParse(await readLimitedJsonBody(request, MAX_GENERATION_DRAFT_BYTES));
    if (!parsed.success) return Response.json({ error: "편집 초안 형식 또는 입력 분량을 확인해 주세요." }, { status: 400 });
    const { draftKey, revision, snapshot } = parsed.data;
    const [kind, key] = draftKey.split(":");
    const ownedMaterialIds = new Set<number>();
    if (kind === "material") ownedMaterialIds.add(Number(key));
    if (snapshot.materialId !== null) ownedMaterialIds.add(snapshot.materialId);
    for (const materialId of ownedMaterialIds) {
      const { data, error } = await withSupabaseRequestTimeout(supabase.from("generated_materials").select("id").eq("id", materialId).eq("user_id", auth.user.id).maybeSingle(), 10_000);
      if (error) throw error;
      if (!data) return Response.json({ error: "본인의 자료만 편집할 수 있습니다." }, { status: 404 });
    }
    if (kind === "job") {
      const { data, error } = await withSupabaseRequestTimeout(supabase.from("generation_jobs").select("id").eq("id", key).eq("user_id", auth.user.id).maybeSingle(), 10_000);
      if (error) throw error;
      if (!data) return Response.json({ error: "생성 작업을 찾을 수 없습니다." }, { status: 404 });
    }
    if (revision === 0) {
      const { count, error } = await withSupabaseRequestTimeout(supabase.from("generation_drafts").select("id", { count: "exact", head: true }).eq("user_id", auth.user.id).eq("snapshot->>saved", "false"), 10_000);
      if (error) throw error;
      if ((count ?? 0) >= 200) return Response.json({ error: "편집 초안 보관 한도에 도달했습니다. 이전 초안을 정리해 주세요." }, { status: 409 });
    }
    const query = revision === 0
      ? supabase.from("generation_drafts").insert({ user_id: auth.user.id, draft_key: draftKey, snapshot: snapshot as unknown as Json })
      : supabase.from("generation_drafts").update({ snapshot: snapshot as unknown as Json }).eq("user_id", auth.user.id).eq("draft_key", draftKey).eq("revision", revision);
    const { data, error } = await withSupabaseRequestTimeout(query.select(columns).maybeSingle(), 10_000);
    if (error?.code === "23505" || (!error && !data)) {
      // 응답 유실 재전송이면 동일 스냅샷만 성공으로 인정한다. 다른 탭의 변경은 덮지 않는다.
      const current = await withSupabaseRequestTimeout(supabase.from("generation_drafts").select(`${columns},snapshot`).eq("user_id", auth.user.id).eq("draft_key", draftKey).maybeSingle(), 10_000);
      const currentSnapshot = generationDraftSnapshotSchema.safeParse(current.data?.snapshot);
      if (!current.error && current.data && currentSnapshot.success && generationDraftFingerprint(currentSnapshot.data) === generationDraftFingerprint(snapshot)) {
        const { id, draft_key, revision: currentRevision, updated_at } = current.data;
        return Response.json({ draft: { id, draft_key, revision: currentRevision, updated_at } }, { headers: { "Cache-Control": "no-store" } });
      }
      return Response.json({ code: "draft_revision_conflict", error: "다른 화면의 편집 초안이 먼저 저장되었습니다. 현재 편집은 이 화면에 유지됩니다.", draftId: current.data?.id }, { status: 409 });
    }
    if (error) throw error;
    return Response.json({ draft: data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof LimitedJsonBodyError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[generate/drafts] private snapshot save failed", error instanceof Error ? error.message : "database failure");
    return Response.json({ error: "편집 초안을 보관하지 못했습니다. 이 화면을 유지하고 다시 시도해 주세요." }, { status: 503 });
  }
}

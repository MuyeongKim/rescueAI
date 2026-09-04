import "server-only";
import { createClient } from "@/lib/supabase/server";
import { DEMO } from "@/lib/demo-flag";
import { generationDraftKeySchema, generationDraftSnapshotSchema, type GenerationDraft, type GenerationDraftSummary } from "@/lib/generation-draft";
import { withSupabaseRequestTimeout } from "@/lib/supabase/request-timeout";

export async function loadMyGenerationDraft(id?: string, draftKey?: string): Promise<GenerationDraft | undefined> {
  if (DEMO || (!id && !draftKey)) return undefined;
  if (id && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return undefined;
  if (draftKey && !generationDraftKeySchema.safeParse(draftKey).success) return undefined;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return undefined;
  let query = supabase.from("generation_drafts").select("id,draft_key,snapshot,revision,updated_at").eq("user_id", user.id);
  query = id ? query.eq("id", id) : query.eq("draft_key", draftKey!);
  const { data, error } = await withSupabaseRequestTimeout(query.maybeSingle(), 10_000);
  if (error || !data) return undefined;
  const parsed = generationDraftSnapshotSchema.safeParse(data.snapshot);
  if (!parsed.success) return undefined;
  return { id: data.id, draftKey: data.draft_key, revision: data.revision, updatedAt: data.updated_at, snapshot: parsed.data };
}

export async function listMyGenerationDrafts(limit = 12): Promise<GenerationDraftSummary[]> {
  if (DEMO) return [];
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  // 목록에는 최대 900 KiB 본문 대신 제목만 가져온다.
  const { data, error } = await withSupabaseRequestTimeout(supabase.from("generation_drafts")
    .select("id,draft_key,updated_at,kind:snapshot->>kind,doc_title:snapshot->doc->>title,deck_title:snapshot->deck->>title,topic:snapshot->context->>topic")
    .eq("user_id", user.id).eq("snapshot->>saved", "false")
    .order("updated_at", { ascending: false }).limit(Math.min(50, Math.max(1, limit))), 10_000);
  if (error) return [];
  return (data ?? []).flatMap((row) => {
    if (!["plan", "lesson", "slides", "notebooklm"].includes(row.kind)) return [];
    return [{ id: row.id, draftKey: row.draft_key, updatedAt: row.updated_at,
      title: row.doc_title || row.deck_title || row.topic || "제목 없는 편집 초안", kind: row.kind }];
  });
}

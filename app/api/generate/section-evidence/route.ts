import { z } from "zod";
import { requireApiUser } from "@/lib/auth";
import { DEMO } from "@/lib/demo";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { LimitedJsonBodyError, readLimitedJsonBody } from "@/lib/generated-material-save";
import { createClient } from "@/lib/supabase/server";
import { createGenerationRagReader } from "@/lib/supabase/generation-rag";
import { ragTableEnabled } from "@/lib/rag-external";
import { sameVerifiedSourceSet, verifyNativeDocumentSourceProvenance } from "@/lib/source-provenance";
import { findDocumentSectionEvidence } from "@/lib/document-section-evidence";

export const maxDuration = 30;
const requestSchema = z.object({
  category: z.string().trim().min(1).max(100),
  section: z.object({ heading: z.string().max(200), content: z.string().max(20_000) }).strip(),
  sources: z.array(z.object({
    document_id: z.number().int().safe().positive(),
    doc: z.string().trim().min(1).max(300),
    page: z.number().int().safe().positive().nullable(),
  }).strip()).max(80),
}).strip();

/** 사용자 문단에 가까운 실제 원문을 확인한다. 출처 조회는 저장·출력과 같은 제한된 reader를 사용한다. */
export async function POST(req: Request) {
  const supabase = DEMO ? null : await createClient();
  if (supabase) {
    const auth = await requireApiUser(supabase);
    if (!auth.ok) return auth.response;
    const limit = rateLimit(`generation-section-evidence:${auth.user.id}`, 30, 60_000);
    if (!limit.ok) return tooManyRequests(limit.retryAfterSec);
  }
  try {
    const parsed = requestSchema.safeParse(await readLimitedJsonBody(req, 120 * 1024));
    if (!parsed.success) return Response.json({ error: "확인할 문단과 출처 형식을 확인해 주세요." }, { status: 400 });
    const { category, section, sources } = parsed.data;
    if (!supabase || sources.length === 0) return Response.json({ items: [], scope: "related-source-excerpts" });
    const evidence = ragTableEnabled()
      ? await createGenerationRagReader().verifySourceEvidence(sources, category)
      : await verifyNativeDocumentSourceProvenance(sources, category, supabase, true);
    if (evidence.degraded) return Response.json({ error: "원문 조회가 지연되었습니다. 다시 확인해 주세요." }, { status: 503 });
    if (!sameVerifiedSourceSet(sources, evidence.sources)) return Response.json({ error: "자료에 연결된 출처가 현재 원본과 일치하지 않습니다. 출처를 갱신해 주세요." }, { status: 422 });
    return Response.json({ items: findDocumentSectionEvidence(section, evidence.evidenceChunks ?? []), scope: "related-source-excerpts" });
  } catch (error) {
    if (error instanceof LimitedJsonBodyError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "원문을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요." }, { status: 503 });
  }
}

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireApiUser } from "@/lib/auth";
import { DEMO } from "@/lib/demo";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { LimitedJsonBodyError, normalizeGeneratedMaterialContent, readLimitedJsonBody } from "@/lib/generated-material-save";
import { checkStoredMaterialGrounding } from "@/lib/generation-grounding-server";
import { claimedGeneratedSources } from "@/lib/source-provenance";
import { trustedRagVerificationReader, verifySourcesBeforeSave, verifySopBeforeSave } from "@/lib/generation-evidence-validation";

const schema = z.object({
  kind: z.enum(["plan", "lesson", "slides"]),
  title: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(100),
  topic: z.string().trim().min(1).max(100),
  audience: z.string().max(50).optional(),
  duration: z.string().max(20).optional(),
  content: z.record(z.unknown()),
});

export async function POST(req: Request) {
  const supabase = DEMO ? null : await createClient();
  if (supabase) {
    const auth = await requireApiUser(supabase);
    if (!auth.ok) return auth.response;
    const limit = rateLimit(`generate-verify:${auth.user.id}`, 30, 60_000);
    if (!limit.ok) return tooManyRequests(limit.retryAfterSec);
  }
  let verifying = false;
  try {
    const parsed = schema.safeParse(await readLimitedJsonBody(req, 1024 * 1024));
    if (!parsed.success) return Response.json({ error: "검증할 자료의 형식을 확인해 주세요." }, { status: 400 });
    const body = parsed.data;
    const normalized = normalizeGeneratedMaterialContent(body.kind, body.content);
    if (!normalized.ok) return Response.json({ error: normalized.error }, { status: 400 });
    const claimed = claimedGeneratedSources(body.content);
    if (supabase && (!claimed.ok || claimed.sources.length === 0)) return Response.json({
      code: "source_provenance_invalid", error: "현재 원본과 대조할 문서 출처가 필요합니다.",
    }, { status: 422 });
    if (!supabase) return Response.json({ ok: true, scope: "source-provenance-sop-and-technical-values", demo: true });
    verifying = true;
    const verifiedBody = { ...body, content: normalized.content };
    const reader = trustedRagVerificationReader();
    if (reader instanceof Response) return reader;
    const sourceError = await verifySourcesBeforeSave(verifiedBody, supabase, reader);
    if (sourceError) return sourceError;
    const sopError = await verifySopBeforeSave(verifiedBody, reader, { requireAvailable: true });
    if (sopError) return sopError;
    const check = await checkStoredMaterialGrounding({
      kind: body.kind, title: body.title, category: body.category,
      content: verifiedBody.content,
      request: { topic: body.topic, audience: body.audience, duration: body.duration,
        focus: typeof verifiedBody.content.focus === "string" ? verifiedBody.content.focus : undefined,
        conditions: typeof verifiedBody.content.conditions === "string" ? verifiedBody.content.conditions : undefined },
      supabase,
    });
    return check.ok ? Response.json({ ok: true, scope: "source-provenance-sop-and-technical-values" })
      : Response.json({ error: check.error, issues: check.issues ?? [] }, { status: check.status });
  } catch (error) {
    return Response.json({ error: verifying ? "원문 근거 검증을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요." : "검증 요청을 읽지 못했습니다." }, {
      status: error instanceof LimitedJsonBodyError ? error.status : verifying ? 503 : 400,
    });
  }
}

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireApiUser } from "@/lib/auth";
import { DEMO } from "@/lib/demo";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { LimitedJsonBodyError, normalizeGeneratedMaterialContent, readLimitedJsonBody } from "@/lib/generated-material-save";
import { checkStoredMaterialGrounding } from "@/lib/generation-grounding-server";

const schema = z.object({
  kind: z.enum(["plan", "lesson", "slides"]),
  title: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(100),
  topic: z.string().max(100).optional(),
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
  try {
    const parsed = schema.safeParse(await readLimitedJsonBody(req, 1024 * 1024));
    if (!parsed.success) return Response.json({ error: "검증할 자료의 형식을 확인해 주세요." }, { status: 400 });
    const body = parsed.data;
    const normalized = normalizeGeneratedMaterialContent(body.kind, body.content);
    if (!normalized.ok) return Response.json({ error: normalized.error }, { status: 400 });
    if (!supabase) return Response.json({ ok: true, scope: "technical-values", demo: true });
    const check = await checkStoredMaterialGrounding({
      kind: body.kind, title: body.title, category: body.category,
      content: normalized.content,
      request: { topic: body.topic, audience: body.audience, duration: body.duration,
        focus: typeof normalized.content.focus === "string" ? normalized.content.focus : undefined,
        conditions: typeof normalized.content.conditions === "string" ? normalized.content.conditions : undefined },
      supabase,
    });
    return check.ok ? Response.json({ ok: true, scope: "technical-values" })
      : Response.json({ error: check.error, issues: check.issues ?? [] }, { status: check.status });
  } catch (error) {
    return Response.json({ error: "검증 요청을 읽지 못했습니다." }, {
      status: error instanceof LimitedJsonBodyError ? error.status : 400,
    });
  }
}

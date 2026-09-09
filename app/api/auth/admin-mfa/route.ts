import { z } from "zod";
import { getAdminMfaStatus, requireApiAdminMfaSetup } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isSameOriginRequest } from "@/lib/same-origin";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { LimitedJsonBodyError, readLimitedJsonBody } from "@/lib/generated-material-save";
import { DEMO } from "@/lib/demo-flag";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("enroll"), name: z.string().trim().min(1).max(40) }).strict(),
  z.object({ action: z.literal("verify"), factorId: z.string().uuid(), code: z.string().regex(/^\d{6}$/) }).strict(),
  z.object({ action: z.literal("cancel"), factorId: z.string().uuid() }).strict(),
]);
const json = (data: unknown, status = 200) => Response.json(data, {
  status, headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" },
});
const failure = (error: string, status: number) => json({ error }, status);

export async function GET() {
  if (DEMO) return json({ verified: true, factors: [], demo: true });
  try {
    const supabase = await createClient();
    const auth = await requireApiAdminMfaSetup(supabase);
    if (!auth.ok) return auth.response;
    return json(await getAdminMfaStatus(supabase, auth.user.id));
  } catch { return failure("인증 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.", 503); }
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return failure("이 사이트에서 다시 시도해 주세요.", 403);
  if (DEMO) return failure("데모에서는 인증 앱을 등록하지 않습니다.", 400);
  try {
    const supabase = await createClient();
    const auth = await requireApiAdminMfaSetup(supabase);
    if (!auth.ok) return auth.response;
    const limited = rateLimit(`admin-mfa:${auth.user.id}`, 10, 5 * 60_000);
    if (!limited.ok) return tooManyRequests(limited.retryAfterSec);
    let input: z.infer<typeof schema>;
    try { input = schema.parse(await readLimitedJsonBody(request, 1024)); }
    catch (error) { return failure("인증 요청 형식과 6자리 번호를 확인해 주세요.", error instanceof LimitedJsonBodyError ? error.status : 400); }

    const state = await getAdminMfaStatus(supabase, auth.user.id);
    const verifiedFactors = state.factors.filter((factor) => factor.status === "verified");
    if (input.action === "enroll") {
      if (verifiedFactors.length > 0 && !state.verified) return failure("기존 인증 앱으로 추가 인증을 완료한 뒤 새 앱을 등록해 주세요.", 403);
      if (state.factors.length >= 3 || verifiedFactors.length >= 2) return failure("인증 앱은 기본용과 예비용으로 2개까지 등록할 수 있습니다. 미완료 등록이 있으면 먼저 취소해 주세요.", 409);
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: input.name, issuer: "RescueAI" });
      if (error || !data) return failure("인증 앱 등록을 시작하지 못했습니다. 이름이 중복되는지 확인하고 다시 시도해 주세요.", 400);
      // QR·비밀키는 현재 등록 화면으로만 전달한다. 오류 객체·세션·토큰은 응답/로그에 넣지 않는다.
      return json({ enrollment: { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret } });
    }

    const factor = state.factors.find((candidate) => candidate.id === input.factorId);
    if (!factor) return failure("현재 계정의 인증 앱을 찾을 수 없습니다. 화면을 새로고침해 주세요.", 404);
    if (input.action === "cancel") {
      if (factor.status !== "unverified") return failure("등록이 완료된 인증 앱은 이 화면에서 삭제할 수 없습니다.", 403);
      const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
      if (error) return failure("미완료 등록을 취소하지 못했습니다. 다시 시도해 주세요.", 400);
      return json({ ok: true });
    }
    // 기존 인증 수단이 있으면 AAL1에서 새 수단으로 우회 등록할 수 없다.
    if (factor.status === "unverified" && verifiedFactors.length > 0 && !state.verified) {
      return failure("먼저 등록된 인증 앱으로 추가 인증을 완료해 주세요.", 403);
    }
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code: input.code });
    if (error) return failure("인증번호가 일치하지 않거나 만료되었습니다. 인증 앱의 새 번호로 다시 시도해 주세요.", 400);
    if (!(await getAdminMfaStatus(supabase, auth.user.id)).verified) return failure("추가 인증 완료 상태를 확인하지 못했습니다. 화면을 새로고침해 주세요.", 503);
    return json({ ok: true });
  } catch { return failure("추가 인증을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.", 503); }
}

import { z } from "zod";
import { requireApiPasswordChangeUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { completeVerifiedPasswordChange } from "@/lib/supabase/password-change";
import { isSameOriginRequest } from "@/lib/same-origin";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { LimitedJsonBodyError, readLimitedJsonBody } from "@/lib/generated-material-save";
import { DEMO } from "@/lib/demo-flag";

const passwordSchema = z.object({ password: z.string().min(8).max(128) }).strict();
const failure = (error: string, status: number, code?: string) => Response.json({ error, code }, {
  status, headers: { "Cache-Control": "no-store" },
});

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return failure("이 사이트에서 다시 시도해 주세요.", 403);
  const supabase = DEMO ? undefined : await createClient();
  const auth = await requireApiPasswordChangeUser(supabase);
  if (!auth.ok) return auth.response;
  const limited = rateLimit(`password-change:${auth.user.id}`, 5, 15 * 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSec);

  let password: string;
  try {
    password = passwordSchema.parse(await readLimitedJsonBody(request, 1024)).password;
  } catch (error) {
    return failure(error instanceof LimitedJsonBodyError ? "비밀번호 변경 요청 형식을 확인해 주세요." : "새 비밀번호는 8~128자로 입력해 주세요.", error instanceof LimitedJsonBodyError ? error.status : 400);
  }
  if (!supabase) return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });

  try {
    const { data, error } = await supabase.auth.updateUser({ password });
    if (error || data.user?.id !== auth.user.id) {
      return failure("비밀번호를 변경하지 못했습니다. 기존 비밀번호와 다른 새 비밀번호를 입력하거나 다시 로그인해 주세요.", 400);
    }
  } catch {
    return failure("비밀번호 변경 결과를 확인하지 못했습니다. 잠시 후 다시 로그인해 주세요.", 503);
  }

  try {
    await completeVerifiedPasswordChange(auth.user);
  } catch {
    return failure("비밀번호는 변경되었지만 완료 상태를 저장하지 못했습니다. 새 비밀번호로 다시 로그인해도 변경 화면이 나오면 관리자에게 문의해 주세요.", 503, "password_changed_completion_failed");
  }
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

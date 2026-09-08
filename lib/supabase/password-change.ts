import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import type { AuthedUser } from "@/lib/auth";

/**
 * /api/auth/change-password 전용 writer. 인증·등록 프로필·Origin·입력·횟수 검증과
 * 같은 세션의 auth.updateUser({ password }) 성공 뒤에만 호출한다.
 * 호출자는 요청 본문의 ID를 전달할 수 없으며 가드가 확인한 사용자 ID만 전달한다.
 * 관리자 client 자체를 반환하거나 다른 컬럼·계정·세션을 변경하지 않는다.
 */
export async function completeVerifiedPasswordChange(user: AuthedUser): Promise<void> {
  const { data, error } = await createAdminClient().from("profiles")
    .update({ must_change_password: false }).eq("id", user.id)
    .select("id").abortSignal(AbortSignal.timeout(5_000)).maybeSingle();
  if (error || data?.id !== user.id) throw new Error("password_change_completion_failed");
}

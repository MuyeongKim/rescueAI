import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/database.types";
import { DEMO, demoUser, demoProfile } from "@/lib/demo";

type Profile = Database["public"]["Tables"]["profiles"]["Row"];

// 서버 컴포넌트/route handler에서 현재 사용자와 프로필을 함께 조회한다.
export async function getUserAndProfile(): Promise<{
  user: { id: string; email?: string } | null;
  profile: Profile | null;
}> {
  if (DEMO) {
    return { user: demoUser, profile: demoProfile as Profile };
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { user: null, profile: null };

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  if (profile) {
    return { user: { id: user.id, email: user.email }, profile };
  }

  // profiles 미생성(마이그레이션 전) 폴백 — 인증 계정 메타데이터로 프로필 구성.
  // 역할(role)은 app_metadata 에서만 읽는다: 서버(관리자 API)로만 수정 가능해 위변조 불가.
  // (user_metadata 는 사용자가 직접 바꿀 수 있으므로 권한 판단에 쓰지 않는다.)
  const appRole = (user.app_metadata as { role?: string } | null)?.role;
  const fallback: Profile = {
    id: user.id,
    email: user.email ?? null,
    full_name:
      (user.user_metadata as { full_name?: string } | null)?.full_name ?? null,
    role: appRole === "admin" ? "admin" : "user",
    division: null,
    created_at: user.created_at ?? "",
  };
  return { user: { id: user.id, email: user.email }, profile: fallback };
}

export function isAdmin(profile: Profile | null): boolean {
  return profile?.role === "admin";
}

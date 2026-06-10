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

  return { user: { id: user.id, email: user.email }, profile: profile ?? null };
}

export function isAdmin(profile: Profile | null): boolean {
  return profile?.role === "admin";
}

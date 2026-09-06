import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/database.types";
import { DEMO, demoUser, demoProfile } from "@/lib/demo";

type Profile = Database["public"]["Tables"]["profiles"]["Row"];
type ServerClient = Awaited<ReturnType<typeof createClient>>;

export type AuthedUser = { id: string; email?: string };

/**
 * 현재 사용자와 프로필을 조회한다. **부작용 없음(리다이렉트하지 않는다).**
 * 페이지/레이아웃에서는 requireUserAndProfile() 을, route handler 에서는 이 함수나
 * requireApiUser()/requireApiAdmin() 을 쓴다.
 */
export async function getUserAndProfile(): Promise<{
  user: AuthedUser | null;
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
    rank: null,
    team: null,
    digital_id: null,
    must_change_password: false,
    created_at: user.created_at ?? "",
  };
  return { user: { id: user.id, email: user.email }, profile: fallback };
}

/**
 * 페이지/레이아웃(RSC)용 — 조회에 더해 첫 로그인 비번 변경을 강제한다.
 * 초기 비번은 디지털식별번호라 바꾸기 전에는 아무것도 못 하게 막아야 한다.
 * /change-password 페이지는 이 함수를 호출하지 않으므로 루프가 생기지 않는다.
 */
export async function requireUserAndProfile(): Promise<{
  user: AuthedUser | null;
  profile: Profile | null;
}> {
  const result = await getUserAndProfile();
  if (result.profile?.must_change_password) redirect("/change-password");
  return result;
}

export function isAdmin(profile: Profile | null): boolean {
  return profile?.role === "admin";
}

export type ApiAuthResult =
  | { ok: true; user: AuthedUser; userMetadata?: Record<string, unknown> }
  | { ok: false; response: Response };

const MUST_CHANGE_PASSWORD_RESPONSE = () =>
  new Response("초기 비밀번호를 변경한 뒤 이용할 수 있습니다.", { status: 403 });

/**
 * route handler 용 인증 — 세션 확인 + 초기 비밀번호 미변경 차단.
 *
 * 페이지는 레이아웃(requireUserAndProfile)이 /change-password 로 보내지만 API 는 그 경로를
 * 타지 않는다. 그래서 초기 비번(디지털식별번호)만 알면 비번을 바꾸지 않고도 API 로 데이터에
 * 접근할 수 있었다. 여기서 함께 막는다.
 *
 * 이미 만든 supabase 클라이언트가 있으면 넘겨서 재사용한다(쿠키 파싱 중복 방지).
 */
export async function requireApiUser(client?: ServerClient): Promise<ApiAuthResult> {
  if (DEMO) return { ok: true, user: demoUser };

  const supabase = client ?? (await createClient());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: new Response("Unauthorized", { status: 401 }) };

  const { data: profile } = await supabase
    .from("profiles")
    .select("must_change_password")
    .eq("id", user.id)
    .maybeSingle();
  if (profile?.must_change_password) {
    return { ok: false, response: MUST_CHANGE_PASSWORD_RESPONSE() };
  }

  // 사용자 설정 읽기용이며 역할·접근권한 판단에는 사용하지 않는다.
  return { ok: true, user: { id: user.id, email: user.email }, userMetadata: user.user_metadata };
}

/** route handler 용 관리자 인증 — 세션 + role='admin' + 초기 비번 변경 완료. */
export async function requireApiAdmin(): Promise<ApiAuthResult> {
  const { user, profile } = await getUserAndProfile();
  if (!user || !isAdmin(profile)) {
    return { ok: false, response: new Response("Forbidden", { status: 403 }) };
  }
  if (profile?.must_change_password) {
    return { ok: false, response: MUST_CHANGE_PASSWORD_RESPONSE() };
  }
  return { ok: true, user };
}

import { createAdminClient } from "@/lib/supabase/admin";
import { requireApiAdmin } from "@/lib/auth";
import { DEMO } from "@/lib/demo";

// 사용자 권한(role) 변경. 관리자 검증 후 service role로 수행.
export async function POST(req: Request) {
  if (DEMO) return Response.json({ ok: true });

  const auth = await requireApiAdmin();
  if (!auth.ok) return auth.response;

  let body: { userId?: string; role?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const { userId, role } = body;
  if (!userId || (role !== "admin" && role !== "user")) {
    return new Response("userId와 role(admin|user)이 필요합니다.", { status: 400 });
  }
  // 자기 자신의 권한 강등 방지(관리자 0명 사고 차단)
  if (userId === auth.user.id) {
    return new Response("본인 권한은 변경할 수 없습니다.", { status: 400 });
  }

  const admin = createAdminClient();
  const { error } = await admin.from("profiles").update({ role }).eq("id", userId);
  if (error) {
    console.error("[admin/users] role 변경 실패:", error.message);
    return new Response("변경 실패", { status: 500 });
  }
  return Response.json({ ok: true });
}

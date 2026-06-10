import { createAdminClient } from "@/lib/supabase/admin";
import { getUserAndProfile, isAdmin } from "@/lib/auth";
import { DEMO } from "@/lib/demo";

// 공지 작성/삭제. 관리자 검증 후 service role로 수행(notices RLS는 읽기 전용).
export async function POST(req: Request) {
  if (DEMO) return Response.json({ ok: true });

  const { user, profile } = await getUserAndProfile();
  if (!user || !isAdmin(profile)) {
    return new Response("Forbidden", { status: 403 });
  }

  let body: { title?: string; content?: string; pinned?: boolean };
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const title = body.title?.trim();
  const content = body.content?.trim();
  if (!title || !content) {
    return new Response("title과 content가 필요합니다.", { status: 400 });
  }

  const admin = createAdminClient();
  const { error } = await admin.from("notices").insert({
    title,
    content,
    pinned: !!body.pinned,
    created_by: user.id,
  });
  if (error) {
    console.error("[admin/notices] insert 실패:", error.message);
    return new Response("저장 실패", { status: 500 });
  }
  return Response.json({ ok: true });
}

export async function DELETE(req: Request) {
  if (DEMO) return Response.json({ ok: true });

  const { user, profile } = await getUserAndProfile();
  if (!user || !isAdmin(profile)) {
    return new Response("Forbidden", { status: 403 });
  }

  let body: { id?: number };
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  if (typeof body.id !== "number") {
    return new Response("id(number)가 필요합니다.", { status: 400 });
  }

  const admin = createAdminClient();
  const { error } = await admin.from("notices").delete().eq("id", body.id);
  if (error) {
    console.error("[admin/notices] delete 실패:", error.message);
    return new Response("삭제 실패", { status: 500 });
  }
  return Response.json({ ok: true });
}

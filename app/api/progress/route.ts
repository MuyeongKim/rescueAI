import { createClient } from "@/lib/supabase/server";
import { DEMO } from "@/lib/demo";

// 레슨(자료) 학습 완료 토글. RLS로 본인 진도만.
export async function POST(req: Request) {
  if (DEMO) {
    const b = await req.json().catch(() => ({}));
    return Response.json({ ok: true, completed: !!b.completed });
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  let body: { documentId?: number; completed?: boolean };
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const { documentId, completed } = body;
  if (typeof documentId !== "number") {
    return new Response("documentId(number)가 필요합니다.", { status: 400 });
  }

  if (completed) {
    const { error } = await supabase
      .from("lesson_progress")
      .upsert(
        { user_id: user.id, document_id: documentId },
        { onConflict: "user_id,document_id" }
      );
    if (error) {
      console.error("[progress] upsert 실패:", error.message);
      return new Response("저장 실패", { status: 500 });
    }
  } else {
    const { error } = await supabase
      .from("lesson_progress")
      .delete()
      .eq("user_id", user.id)
      .eq("document_id", documentId);
    if (error) {
      console.error("[progress] delete 실패:", error.message);
      return new Response("저장 실패", { status: 500 });
    }
  }

  return Response.json({ ok: true, completed: !!completed });
}

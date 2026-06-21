import { createClient } from "@/lib/supabase/server";
import { DEMO } from "@/lib/demo";
import type { GenType } from "@/lib/generate";

const KINDS: GenType[] = ["plan", "lesson", "slides", "notebooklm"];

type SaveBody = {
  id?: number; // 있으면 재편집 저장(해당 행 업데이트)
  kind?: GenType;
  category?: string | null;
  audience?: string | null;
  duration?: string | null;
  topic?: string | null;
  title?: string;
  content?: unknown;
};

// 생성물 저장 — 본인 세션으로 insert(신규) 또는 update(재편집). RLS 가 본인 행만 허용/검증.
// 서비스 롤 미사용.
export async function POST(req: Request) {
  let body: SaveBody = {};
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const kind = body.kind;
  const title = body.title?.trim();
  if (!kind || !KINDS.includes(kind) || !title || body.content == null) {
    return new Response("잘못된 요청입니다.", { status: 400 });
  }

  // 데모 모드: DB 없이 저장 성공으로 처리(UI 흐름 확인용)
  if (DEMO) return Response.json({ id: 0, demo: true });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const fields = {
    kind,
    category: body.category ?? null,
    audience: body.audience ?? null,
    duration: body.duration ?? null,
    topic: body.topic?.slice(0, 100) ?? null,
    title: title.slice(0, 200),
    content: body.content,
  };

  // 재편집 저장: id 가 있으면 해당 행 업데이트(RLS 로 본인 것만).
  if (typeof body.id === "number" && Number.isInteger(body.id)) {
    const { error } = await supabase
      .from("generated_materials")
      .update(fields)
      .eq("id", body.id);
    if (error) {
      console.error("[generate/save] update 실패:", error.message);
      return Response.json({ error: "저장 중 오류가 발생했습니다." }, { status: 500 });
    }
    return Response.json({ id: body.id });
  }

  const { data, error } = await supabase
    .from("generated_materials")
    .insert({ user_id: user.id, ...fields })
    .select("id")
    .single();

  if (error) {
    console.error("[generate/save] insert 실패:", error.message);
    return Response.json({ error: "저장 중 오류가 발생했습니다." }, { status: 500 });
  }
  return Response.json({ id: data.id });
}

// 저장본 삭제 — RLS 로 본인 것만 삭제된다.
export async function DELETE(req: Request) {
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return new Response("잘못된 요청입니다.", { status: 400 });
  }
  if (DEMO) return Response.json({ ok: true, demo: true });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { error } = await supabase.from("generated_materials").delete().eq("id", id);
  if (error) {
    console.error("[generate/save] delete 실패:", error.message);
    return Response.json({ error: "삭제 중 오류가 발생했습니다." }, { status: 500 });
  }
  return Response.json({ ok: true });
}

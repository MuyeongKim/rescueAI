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
  // content 크기 상한(약 500KB) — 비정상적으로 큰 payload 저장 차단
  if (JSON.stringify(body.content).length > 500_000) {
    return new Response("저장할 내용이 너무 큽니다.", { status: 413 });
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
    const { data, error } = await supabase
      .from("generated_materials")
      .update(fields)
      .eq("id", body.id)
      .select("id");
    if (error) {
      console.error("[generate/save] update 실패:", error.message);
      return Response.json({ error: "저장 중 오류가 발생했습니다." }, { status: 500 });
    }
    // RLS 로 0행 매칭(남의 것·없는 id)이면 성공으로 오인하지 않게 404
    if (!data || data.length === 0) {
      return Response.json({ error: "저장할 자료를 찾을 수 없습니다." }, { status: 404 });
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

// 공유 토글 — 본인 자료를 다른 대원에게 공개/비공개(RLS 로 본인 것만).
// 공유 시 작성자 이름을 비정규화 저장(profiles 는 본인만 읽혀 목록에서 이름을 못 가져오므로).
export async function PATCH(req: Request) {
  let body: { id?: number; shared?: boolean };
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  if (typeof body.id !== "number" || typeof body.shared !== "boolean") {
    return new Response("id(number)와 shared(boolean)가 필요합니다.", { status: 400 });
  }
  if (DEMO) return Response.json({ ok: true, demo: true });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const patch: { shared: boolean; author_name?: string } = { shared: body.shared };
  if (body.shared) {
    const { data: prof } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", user.id)
      .maybeSingle();
    patch.author_name = prof?.full_name ?? user.email?.split("@")[0] ?? "구조대원";
  }

  const { data, error } = await supabase
    .from("generated_materials")
    .update(patch)
    .eq("id", body.id)
    .select("id");
  if (error) {
    console.error("[generate/save] 공유 토글 실패:", error.message);
    return Response.json({ error: "공유 설정에 실패했습니다." }, { status: 500 });
  }
  if (!data || data.length === 0) {
    return Response.json({ error: "자료를 찾을 수 없습니다." }, { status: 404 });
  }
  return Response.json({ ok: true, shared: body.shared });
}

import { createAdminClient } from "@/lib/supabase/admin";
import { requireApiAdmin } from "@/lib/auth";
import { summarizeArticle } from "@/lib/news-ai";
import { DEMO } from "@/lib/demo";

// 구조 동향(뉴스) 큐레이션 (관리자 전용). 관리자 검증 후 service role로 수행.
//  POST {action:"summarize", title, text}  → AI 요약/분류 결과 반환(폼 보조)
//  POST {action:"create", ...필드}          → news 행 생성(수동, auto=false)
//  POST {action:"update", id, ...필드}       → 수정
//  POST {action:"toggle", id, field, value} → pinned/hidden 토글
//  DELETE {id}                              → 삭제
export async function POST(req: Request) {
  if (DEMO) return Response.json({ ok: true });
  const auth = await requireApiAdmin();
  if (!auth.ok) return auth.response;
  const user = auth.user;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  const admin = createAdminClient();

  if (body.action === "summarize") {
    const title = String(body.title ?? "").trim();
    if (!title) return new Response("제목이 필요합니다.", { status: 400 });
    const result = await summarizeArticle({
      title,
      text: body.text ? String(body.text) : undefined,
      source: body.source ? String(body.source) : undefined,
    });
    if (!result) return new Response("AI 요약 실패", { status: 500 });
    return Response.json(result);
  }

  if (body.action === "toggle") {
    const id = Number(body.id);
    const field = String(body.field);
    if (!id || (field !== "pinned" && field !== "hidden")) {
      return new Response("id·field(pinned|hidden) 필요", { status: 400 });
    }
    const patch =
      field === "pinned" ? { pinned: !!body.value } : { hidden: !!body.value };
    const { error } = await admin.from("news").update(patch).eq("id", id);
    if (error) return new Response("변경 실패", { status: 500 });
    return Response.json({ ok: true });
  }

  // create / update 공통 필드
  const fields = {
    title: String(body.title ?? "").trim(),
    summary: body.summary ? String(body.summary) : null,
    source: body.source ? String(body.source) : null,
    url: body.url ? String(body.url) : null,
    region: body.region ? String(body.region) : null,
    category: body.category ? String(body.category) : null,
    published_on: body.publishedOn ? String(body.publishedOn) : null,
    pinned: !!body.pinned,
  };
  if (!fields.title) return new Response("제목이 필요합니다.", { status: 400 });

  if (body.action === "update") {
    const id = Number(body.id);
    if (!id) return new Response("id가 필요합니다.", { status: 400 });
    const { error } = await admin.from("news").update(fields).eq("id", id);
    if (error) {
      console.error("[admin/news] update 실패:", error.message);
      return new Response("수정 실패", { status: 500 });
    }
    return Response.json({ ok: true });
  }

  if (body.action === "create") {
    const { data, error } = await admin
      .from("news")
      .insert({ ...fields, auto: false, created_by: user.id })
      .select("id")
      .single();
    if (error) {
      console.error("[admin/news] create 실패:", error.message);
      return new Response("등록 실패", { status: 500 });
    }
    return Response.json({ id: data.id });
  }

  return new Response("알 수 없는 action", { status: 400 });
}

export async function DELETE(req: Request) {
  if (DEMO) return Response.json({ ok: true });
  const auth = await requireApiAdmin();
  if (!auth.ok) return auth.response;

  let body: { id?: number };
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  if (!body.id) return new Response("id가 필요합니다.", { status: 400 });

  const admin = createAdminClient();
  const { error } = await admin.from("news").delete().eq("id", body.id);
  if (error) return new Response("삭제 실패", { status: 500 });
  return Response.json({ ok: true });
}

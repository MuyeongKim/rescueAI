import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUserAndProfile, isAdmin } from "@/lib/auth";
import { DEMO } from "@/lib/demo";

// 자료실 원본 PDF 업로드/삭제 (관리자 전용). 비공개 'documents' 버킷에 서명 URL로 직접 업로드.
//  POST {action:"sign", filename, contentType}  → 서명 업로드 URL 발급(브라우저가 직접 업로드)
//  POST {action:"create", title, category, difficulty?, publishDate?, path, originalFilename}
//                                               → documents 행 생성(file_url=스토리지 경로)
//  DELETE {id}                                  → documents 행 + 스토리지 파일 삭제
const BUCKET = "documents";

async function requireAdmin() {
  const { user, profile } = await getUserAndProfile();
  if (!user || !isAdmin(profile)) return null;
  return user;
}

function safeName(name: string): string {
  // 경로 안전 문자만, 한글 등은 유지하되 슬래시·공백 정리
  return (name || "file.pdf").replace(/[/\\]/g, "_").replace(/\s+/g, "_").slice(0, 120);
}

export async function POST(req: Request) {
  if (DEMO) return new Response("데모 모드에서는 사용할 수 없습니다.", { status: 400 });
  if (!(await requireAdmin())) return new Response("Forbidden", { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const admin = createAdminClient();

  // ① 서명 업로드 URL 발급
  if (body.action === "sign") {
    const filename = safeName(String(body.filename ?? "file.pdf"));
    const contentType = String(body.contentType ?? "");
    if (contentType !== "application/pdf") {
      return new Response("PDF 파일만 업로드할 수 있습니다.", { status: 400 });
    }
    const path = `${randomUUID()}-${filename}`;
    const { data, error } = await admin.storage
      .from(BUCKET)
      .createSignedUploadUrl(path);
    if (error || !data) {
      console.error("[admin/documents] 서명 URL 발급 실패:", error?.message);
      return new Response("업로드 URL 발급 실패", { status: 500 });
    }
    return Response.json({ path: data.path, token: data.token });
  }

  // ② 업로드 완료 후 documents 행 생성
  if (body.action === "create") {
    const title = String(body.title ?? "").trim();
    const path = String(body.path ?? "").trim();
    if (!title || !path) {
      return new Response("제목과 파일이 필요합니다.", { status: 400 });
    }
    const category = body.category ? String(body.category) : null;
    const difficulty = body.difficulty ? String(body.difficulty) : null;
    const publishDate = body.publishDate ? String(body.publishDate) : null;
    const originalFilename = body.originalFilename
      ? String(body.originalFilename)
      : null;

    const { data, error } = await admin
      .from("documents")
      .insert({
        title,
        category,
        difficulty,
        publish_date: publishDate,
        original_filename: originalFilename,
        file_url: path, // 스토리지 경로(비공개) — 열람 시 서명 URL로 변환
        source_type: "pdf",
        status: "processed",
      })
      .select("id")
      .single();
    if (error || !data) {
      console.error("[admin/documents] 자료 생성 실패:", error?.message);
      return new Response("자료 등록 실패", { status: 500 });
    }
    return Response.json({ id: data.id });
  }

  return new Response("알 수 없는 action", { status: 400 });
}

export async function DELETE(req: Request) {
  if (DEMO) return new Response("데모 모드에서는 사용할 수 없습니다.", { status: 400 });
  if (!(await requireAdmin())) return new Response("Forbidden", { status: 403 });

  let body: { id?: number };
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  if (body.id == null) return new Response("id가 필요합니다.", { status: 400 });

  const admin = createAdminClient();
  const { data: doc } = await admin
    .from("documents")
    .select("file_url")
    .eq("id", body.id)
    .maybeSingle();

  // 스토리지 파일 먼저 제거(경로면). http URL(레거시)은 건너뜀.
  if (doc?.file_url && !/^https?:\/\//.test(doc.file_url)) {
    await admin.storage.from(BUCKET).remove([doc.file_url]);
  }
  const { error } = await admin.from("documents").delete().eq("id", body.id);
  if (error) {
    console.error("[admin/documents] 삭제 실패:", error.message);
    return new Response("삭제 실패", { status: 500 });
  }
  return Response.json({ ok: true });
}

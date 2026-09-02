import { requireApiUser } from "@/lib/auth";
import { DEMO } from "@/lib/demo";
import { createClient } from "@/lib/supabase/server";

const DOCUMENTS_BUCKET = "documents";
const SIGNED_URL_TTL_SECONDS = 300;

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (DEMO) {
    return Response.json(
      { error: "데모 자료에는 원본 PDF가 연결되어 있지 않습니다." },
      { status: 404, headers: { "Cache-Control": "no-store" } }
    );
  }

  const { id } = await params;
  const documentId = Number(id);
  if (!Number.isSafeInteger(documentId) || documentId <= 0) {
    return Response.json(
      { error: "올바른 자료 번호가 아닙니다." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  const supabase = await createClient();
  const auth = await requireApiUser(supabase);
  if (!auth.ok) return auth.response;

  const { data: document, error: documentError } = await supabase
    .from("documents")
    .select("id, title, source_type, file_url, status")
    .eq("id", documentId)
    .maybeSingle();

  if (documentError) {
    console.error("[documents/source] 자료 조회 실패:", documentError.message);
    return Response.json(
      { error: "원본 자료를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요." },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
  if (
    !document?.file_url ||
    document.status !== "processed" ||
    document.source_type !== "pdf"
  ) {
    return Response.json(
      { error: "이 자료에는 열람 가능한 원본 PDF가 없습니다." },
      { status: 404, headers: { "Cache-Control": "no-store" } }
    );
  }

  if (/^https?:\/\//i.test(document.file_url)) {
    return Response.json(
      { error: "외부 링크 원본은 PPTX 시각자료로 사용할 수 없습니다." },
      { status: 422, headers: { "Cache-Control": "private, no-store" } }
    );
  }

  const { data, error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .createSignedUrl(document.file_url, SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    console.error("[documents/source] 서명 URL 발급 실패:", error?.message);
    return Response.json(
      { error: "원본 PDF를 준비하지 못했습니다. 관리자에게 자료 연결 상태를 알려 주세요." },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }

  return Response.json(
    {
      url: data.signedUrl,
      title: document.title,
      expiresIn: SIGNED_URL_TTL_SECONDS,
    },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}

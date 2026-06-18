import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DocViewerClient } from "@/components/docs/DocViewerClient";
import { DEMO, demoDocuments } from "@/lib/demo";

// 비공개 버킷 경로(file_url)를 시간제한 서명 URL로 변환. http(레거시)면 그대로, 없으면 null.
async function resolveFileUrl(fileUrl: string | null): Promise<string | null> {
  if (!fileUrl) return null;
  if (/^https?:\/\//.test(fileUrl)) return fileUrl;
  const admin = createAdminClient();
  const { data } = await admin.storage
    .from("documents")
    .createSignedUrl(fileUrl, 3600); // 1시간 유효
  return data?.signedUrl ?? null;
}

export const dynamic = "force-dynamic";

export default async function DocViewerPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { page?: string };
}) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) notFound();

  const initialPage = searchParams.page
    ? Math.max(1, parseInt(searchParams.page, 10) || 1)
    : 1;

  if (DEMO) {
    const d = demoDocuments.find((x) => x.id === id);
    if (!d) notFound();
    return (
      <DocViewerClient
        title={d.title}
        category={d.category}
        fileUrl={null}
        initialPage={initialPage}
      />
    );
  }

  const supabase = await createClient();
  const { data: doc } = await supabase
    .from("documents")
    .select("id, title, file_url, category, original_filename")
    .eq("id", id)
    .maybeSingle();

  if (!doc) notFound();

  const fileUrl = await resolveFileUrl(doc.file_url);

  return (
    <DocViewerClient
      title={doc.title}
      category={doc.category}
      fileUrl={fileUrl}
      initialPage={initialPage}
    />
  );
}

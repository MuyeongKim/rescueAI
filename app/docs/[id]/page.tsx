import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DocViewerClient } from "@/components/docs/DocViewerClient";
import { DEMO, demoDocuments } from "@/lib/demo";

export const dynamic = "force-dynamic";

export default async function DocViewerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const [{ id: rawId }, resolvedSearchParams] = await Promise.all([params, searchParams]);
  const id = Number(rawId);
  if (!Number.isFinite(id)) notFound();

  const initialPage = resolvedSearchParams.page
    ? Math.max(1, parseInt(resolvedSearchParams.page, 10) || 1)
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

  let fileUrl: string | null = doc.file_url;
  if (fileUrl && !/^https?:\/\//.test(fileUrl)) {
    const { data } = await supabase.storage
      .from("documents")
      .createSignedUrl(fileUrl, 3600);
    fileUrl = data?.signedUrl ?? null;
  }

  return (
    <DocViewerClient
      title={doc.title}
      category={doc.category}
      fileUrl={fileUrl}
      initialPage={initialPage}
    />
  );
}

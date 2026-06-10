import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DocViewerClient } from "@/components/docs/DocViewerClient";
import { DEMO, demoDocuments, isDemoCompleted } from "@/lib/demo";

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
        documentId={d.id}
        title={d.title}
        category={d.category}
        fileUrl={null}
        initialPage={initialPage}
        completed={isDemoCompleted(d.id)}
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

  // 학습 완료 여부 (레슨 진도)
  const {
    data: { user },
  } = await supabase.auth.getUser();
  let completed = false;
  if (user) {
    const { data: p } = await supabase
      .from("lesson_progress")
      .select("id")
      .eq("user_id", user.id)
      .eq("document_id", id)
      .maybeSingle();
    completed = !!p;
  }

  return (
    <DocViewerClient
      documentId={doc.id}
      title={doc.title}
      category={doc.category}
      fileUrl={doc.file_url}
      initialPage={initialPage}
      completed={completed}
    />
  );
}

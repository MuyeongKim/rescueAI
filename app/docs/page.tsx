import { createClient } from "@/lib/supabase/server";
import { BookOpenCheck } from "lucide-react";
import { DocsBrowser } from "@/components/docs/DocsBrowser";
import { OperationalHeader } from "@/components/layout/OperationalHeader";
import { DEMO, demoDocuments } from "@/lib/demo";

export const dynamic = "force-dynamic";

export default async function DocsPage() {
  let documents:
    | {
        id: number;
        title: string;
        category: string | null;
        equipment: string[] | null;
        difficulty: string | null;
        file_url: string | null;
        publish_date: string | null;
        source_type: string;
      }[]
    | null = null;

  if (DEMO) {
    documents = demoDocuments.map((d) => ({ ...d, file_url: null }));
  } else {
    const supabase = await createClient();
    const res = await supabase
      .from("documents")
      .select(
        "id, title, category, equipment, difficulty, file_url, publish_date, source_type"
      )
      .order("created_at", { ascending: false });
    documents = res.data;
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-4 py-6 sm:px-6 lg:px-8">
      <OperationalHeader
        eyebrow="교육자료 · 원본 근거"
        title="자료실"
        description="원본 교육자료를 분야·난이도로 분류하고 제목으로 검색할 수 있습니다."
        icon={BookOpenCheck}
        status={`${documents?.length ?? 0}건 등록`}
      />
      <DocsBrowser documents={documents ?? []} />
    </div>
  );
}

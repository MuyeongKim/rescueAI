import { createClient } from "@/lib/supabase/server";
import { DocsBrowser } from "@/components/docs/DocsBrowser";
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
    <div className="mx-auto max-w-5xl px-3 py-5 sm:px-4">
      <div className="mb-4">
        <h1 className="text-xl font-semibold">교육자료</h1>
        <p className="text-sm text-muted-foreground">
          원본 교육자료 참고 서가입니다. 분야·난이도로 거르거나 제목으로
          검색하세요. 과정·진도 관리는 학습 탭에서 합니다.
        </p>
      </div>
      <DocsBrowser documents={documents ?? []} />
    </div>
  );
}

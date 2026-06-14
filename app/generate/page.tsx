import { Wand2 } from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { DEMO, demoDocuments } from "@/lib/demo";
import { ragTableEnabled, listRag2026Categories } from "@/lib/rag2026";
import { COURSE_CATEGORIES } from "@/lib/courses";
import { availableModels } from "@/lib/llm";
import { GenerateForm } from "@/components/generate/GenerateForm";

export const dynamic = "force-dynamic";

// 인덱싱된 자료가 있는 분야와 분야별 자료 제목을 모은다.
// 자료 제목은 NotebookLM 프롬프트의 "업로드할 자료" 안내에 쓰인다.
async function loadDocsByCategory(): Promise<Record<string, string[]>> {
  // RAG_TABLE=rag_2026: 기존 임베딩 테이블의 분야·원본 파일 목록 사용
  if (!DEMO && ragTableEnabled()) return listRag2026Categories();

  let rows: { title: string; category: string | null }[];
  if (DEMO) {
    rows = demoDocuments.map((d) => ({ title: d.title, category: d.category }));
  } else {
    const supabase = await createClient();
    const { data } = await supabase.from("documents").select("title, category");
    rows = data ?? [];
  }

  const byCat = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.category) continue;
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category)!.push(r.title);
  }
  // 정의된 카테고리 우선 정렬
  const ordered = [
    ...COURSE_CATEGORIES.filter((c) => byCat.has(c)),
    ...Array.from(byCat.keys()).filter(
      (c) => !COURSE_CATEGORIES.includes(c as (typeof COURSE_CATEGORIES)[number])
    ),
  ];
  return Object.fromEntries(ordered.map((c) => [c, byCat.get(c)!]));
}

export default async function GeneratePage() {
  const docsByCategory = await loadDocsByCategory();
  const categories = Object.keys(docsByCategory);
  const models = availableModels();

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-3 py-5 sm:px-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Wand2 className="h-5 w-5 text-primary" /> AI 자료제작
        </h1>
        <p className="text-sm text-muted-foreground">
          클릭 몇 번으로 훈련계획 문서·교안·교육 슬라이드를 AI가 만들어 드립니다.
          NotebookLM용 프롬프트도 뽑아갈 수 있고, 모두 인덱싱된 교육자료(벡터DB)를
          근거로 생성합니다.
        </p>
      </div>

      {categories.length === 0 ? (
        <p className="rounded-lg border py-12 text-center text-sm text-muted-foreground">
          아직 인덱싱된 자료가 없습니다. 자료를 올리면 분야가 자동으로 나타납니다.
        </p>
      ) : (
        <GenerateForm docsByCategory={docsByCategory} models={models} />
      )}
    </div>
  );
}

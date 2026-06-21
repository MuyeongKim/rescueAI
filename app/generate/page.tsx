import Link from "next/link";
import { ChevronRight, FolderOpen, Wand2 } from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { DEMO, demoDocuments } from "@/lib/demo";
import { ragTableEnabled, listRag2026Categories } from "@/lib/rag2026";
import { COURSE_CATEGORIES } from "@/lib/courses";
import { availableModels } from "@/lib/llm";
import type { SavedMaterial } from "@/lib/generate";
import { listMyMaterials } from "@/lib/generated-materials";
import { GenerateForm } from "@/components/generate/GenerateForm";
import { SavedList } from "@/components/generate/SavedList";

export const dynamic = "force-dynamic";

// 저장본 재편집(?m=<id>) — RLS 로 본인 행만 반환된다.
async function loadMaterial(id?: string): Promise<SavedMaterial | undefined> {
  if (DEMO || !id) return undefined;
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  const supabase = await createClient();
  const { data } = await supabase
    .from("generated_materials")
    .select("id, kind, category, audience, duration, topic, title, content, created_at")
    .eq("id", n)
    .maybeSingle();
  return (data as unknown as SavedMaterial) ?? undefined;
}

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

export default async function GeneratePage({
  searchParams,
}: {
  searchParams: { m?: string };
}) {
  const docsByCategory = await loadDocsByCategory();
  const categories = Object.keys(docsByCategory);
  const models = availableModels();
  const initialMaterial = await loadMaterial(searchParams?.m);
  // 재편집 중이 아닐 때만 최근 저장 자료 섹션을 보여준다.
  const recentSaved = initialMaterial ? [] : await listMyMaterials(5);

  return (
    <div className="mx-auto max-w-3xl space-y-3 px-3 py-4 sm:px-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Wand2 className="h-6 w-6 text-primary" /> AI 자료제작
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          인덱싱된 교육자료를 근거로 훈련계획·교안·슬라이드를 만들어 드립니다.
        </p>
      </div>

      {categories.length === 0 && !initialMaterial ? (
        <p className="rounded-lg border py-12 text-center text-sm text-muted-foreground">
          아직 인덱싱된 자료가 없습니다. 자료를 올리면 분야가 자동으로 나타납니다.
        </p>
      ) : (
        <GenerateForm
          docsByCategory={docsByCategory}
          models={models}
          initialMaterial={initialMaterial}
        />
      )}

      {recentSaved.length > 0 && (
        <section className="space-y-3 pt-2">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <FolderOpen className="h-4 w-4 text-primary" /> 저장한 자료
            </h2>
            <Link
              href="/generate/saved"
              className="flex items-center gap-0.5 text-sm font-medium text-primary hover:underline"
            >
              전체 보기 <ChevronRight className="h-4 w-4" />
            </Link>
          </div>
          <SavedList initial={recentSaved} />
        </section>
      )}
    </div>
  );
}

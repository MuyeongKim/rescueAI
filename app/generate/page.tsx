import Link from "next/link";
import { ChevronRight, FolderOpen, Users, Wand2 } from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { DEMO, demoDocuments } from "@/lib/demo";
import { ragTableEnabled, listExternalRagCategories } from "@/lib/rag-external";
import { COURSE_CATEGORIES } from "@/lib/courses";
import { availableModels } from "@/lib/llm";
import type { SavedMaterial } from "@/lib/generate";
import { listMyMaterials } from "@/lib/generated-materials";
import { GenerateForm } from "@/components/generate/GenerateForm";
import { SavedList } from "@/components/generate/SavedList";
import { OperationalHeader } from "@/components/layout/OperationalHeader";

export const dynamic = "force-dynamic";

// 저장본 재편집(?m=<id>) — RLS에 더해 인증 user_id를 명시해 본인 행만 조회한다.
async function loadMaterial(id?: string): Promise<SavedMaterial | undefined> {
  if (DEMO || !id) return undefined;
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return undefined;

  const { data } = await supabase
    .from("generated_materials")
    .select("id, kind, category, audience, duration, topic, title, content, revision, created_at")
    .eq("id", n)
    .eq("user_id", user.id)
    .maybeSingle();
  return (data as unknown as SavedMaterial) ?? undefined;
}

// 인덱싱된 자료가 있는 분야와 분야별 자료 제목을 모은다.
// 분야 목록은 생성 범위를 제한하고, 자료 제목은 기존 NotebookLM 저장본 재편집 호환에만 쓴다.
async function loadDocsByCategory(): Promise<Record<string, string[]>> {
  // RAG_TABLE=rag_rescue: 기존 임베딩 테이블의 분야·원본 파일 목록 사용
  if (!DEMO && ragTableEnabled()) return listExternalRagCategories();

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
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-6 sm:px-6">
      <div>
        <OperationalHeader
          eyebrow="교육훈련 · 자료 제작"
          title="AI 자료제작"
          description="인덱싱된 교육자료를 근거로 훈련계획·교안·슬라이드를 만듭니다."
          icon={Wand2}
          status={categories.length > 0 ? `${categories.length}개 분야 연결` : "자료 연결 대기"}
          statusTone={categories.length > 0 ? "success" : "warning"}
        />
        <Link
          href="/generate/shared"
          className="mt-3 inline-flex min-h-11 items-center gap-1.5 border border-slate-300 bg-white px-3 text-sm font-semibold text-primary transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
        >
          <Users className="h-4 w-4" /> 동료가 만든 자료 보기
          <ChevronRight className="h-4 w-4" />
        </Link>
      </div>

      {categories.length === 0 && !initialMaterial ? (
        <p className="border border-l-4 border-l-primary bg-card py-12 text-center text-sm text-muted-foreground">
          아직 인덱싱된 자료가 없습니다. 자료를 올리면 분야가 자동으로 나타납니다.
        </p>
      ) : (
        <GenerateForm
          key={initialMaterial ? `material-${initialMaterial.id}` : "new"}
          docsByCategory={docsByCategory}
          models={models}
          initialMaterial={initialMaterial}
        />
      )}

      {recentSaved.length > 0 && (
        <section className="space-y-3 border-t-2 border-t-slate-900 pt-3 dark:border-t-slate-200">
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

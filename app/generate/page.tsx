import Link from "next/link";
import { ChevronDown, ChevronRight, FolderOpen, Users, Wand2 } from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { DEMO, demoDocuments } from "@/lib/demo";
import { ragTableEnabled, listExternalRagCategories } from "@/lib/rag-external";
import { COURSE_CATEGORIES } from "@/lib/courses";
import { availableModels } from "@/lib/llm";
import type { SavedMaterial } from "@/lib/generate";
import type { PublicGenerationJob } from "@/lib/generation-job";
import {
  GENERATION_JOB_PUBLIC_COLUMNS,
  toPublicGenerationJob,
} from "@/lib/generation-job-store";
import { listMyMaterials } from "@/lib/generated-materials";
import { GenerateForm } from "@/components/generate/GenerateForm";
import { SavedList } from "@/components/generate/SavedList";
import { OperationalHeader } from "@/components/layout/OperationalHeader";
import { listMyGenerationDrafts, loadMyGenerationDraft } from "@/lib/generation-drafts-server";
import { listMyGenerationJobs } from "@/lib/generation-recovery";
import { GenerationRecoveryList } from "@/components/generate/GenerationRecoveryList";

export const dynamic = "force-dynamic";

function validGenerationJobId(value?: string): string | undefined {
  return value && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
}

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

// 영속 생성 작업 다시 열기(?j=<uuid>) — RLS만 믿고 넓게 조회하지 않고 인증 소유자도 명시한다.
async function loadGenerationJob(id?: string): Promise<PublicGenerationJob | undefined> {
  const jobId = validGenerationJobId(id);
  if (DEMO || !jobId) {
    return undefined;
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return undefined;

  const { data } = await supabase
    .from("generation_jobs")
    .select(GENERATION_JOB_PUBLIC_COLUMNS)
    .eq("id", jobId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!data) return undefined;

  try {
    return toPublicGenerationJob(data);
  } catch {
    // 손상되었거나 이전 계약의 행은 생성 화면 전체를 깨뜨리지 않는다.
    return undefined;
  }
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
  searchParams: Promise<{ m?: string; j?: string; d?: string }>;
}) {
  const resolvedSearchParams = await searchParams;
  const docsByCategory = await loadDocsByCategory();
  const categories = Object.keys(docsByCategory);
  const models = availableModels();
  const requestedJobId = DEMO ? undefined : validGenerationJobId(resolvedSearchParams.j);
  const [initialMaterial, requestedJob, jobs, drafts, initialDraft] = await Promise.all([
    loadMaterial(resolvedSearchParams.m),
    loadGenerationJob(resolvedSearchParams.j),
    listMyGenerationJobs(),
    listMyGenerationDrafts(),
    loadMyGenerationDraft(resolvedSearchParams.d, !resolvedSearchParams.d
      ? requestedJobId ? `job:${requestedJobId}` : resolvedSearchParams.m ? `material:${resolvedSearchParams.m}` : undefined
      : undefined),
  ]);
  const latestActiveJob = !resolvedSearchParams.m && !requestedJobId && !resolvedSearchParams.d
    ? jobs.find((job) => !["completed", "needs_attention", "failed"].includes(job.status)) : undefined;
  const initialJob = requestedJob ?? (latestActiveJob ? await loadGenerationJob(latestActiveJob.id) : undefined);
  // 두 쿼리가 함께 들어오면 영속 작업 주소를 우선해 서로 다른 결과가 한 화면에 섞이지 않게 한다.
  const editableMaterial = requestedJobId || (initialDraft && !initialDraft.snapshot.saved) ? undefined : initialMaterial;
  // 재편집 중이 아닐 때만 최근 저장 자료 섹션을 보여준다.
  const recentSaved = editableMaterial || initialDraft || initialJob || requestedJobId ? [] : await listMyMaterials(5);

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

      {resolvedSearchParams.d && !initialDraft && (
        <p role="alert" className="rounded-md border p-3 text-base">
          편집 초안을 찾을 수 없습니다. 본인 계정인지 확인해 주세요.
          {(jobs.length > 0 || drafts.length > 0) && " 아래의 ‘이어서 작업하기’를 펼쳐 보관된 작업을 다시 열 수 있습니다."}
        </p>
      )}
      {categories.length === 0 && !editableMaterial && !initialDraft && !initialJob && !requestedJobId ? (
        <p className="border border-l-4 border-l-primary bg-card py-12 text-center text-sm text-muted-foreground">
          아직 인덱싱된 자료가 없습니다. 자료를 올리면 분야가 자동으로 나타납니다.
        </p>
      ) : (
        <GenerateForm
          key={
            initialDraft ? `draft-${initialDraft.id}` : initialJob || requestedJobId
              ? `job-${initialJob?.id ?? requestedJobId}`
              : editableMaterial
                ? `material-${editableMaterial.id}`
                : "new"
          }
          docsByCategory={docsByCategory}
          models={models}
          initialMaterial={editableMaterial}
          initialDraft={initialDraft}
          initialJob={initialJob}
          pendingJobId={initialJob ? undefined : requestedJobId}
          durableGenerationEnabled={!DEMO}
        />
      )}

      <GenerationRecoveryList jobs={jobs} drafts={drafts} collapsible />

      {recentSaved.length > 0 && (
        <details className="group/saved rounded-lg border bg-card" aria-labelledby="generation-saved-heading">
          <summary className="min-h-14 cursor-pointer list-none rounded-lg px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <h2 id="generation-saved-heading" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-semibold">
              <FolderOpen aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
              <span>저장한 자료</span>
              <span className="text-sm font-normal text-muted-foreground">최근 {recentSaved.length}개</span>
              <span aria-hidden="true" className="ml-auto flex items-center gap-1 text-sm font-medium text-muted-foreground">
                <span className="group-open/saved:hidden">펼치기</span>
                <span className="hidden group-open/saved:inline">접기</span>
                <ChevronDown className="h-4 w-4 group-open/saved:rotate-180" />
              </span>
            </h2>
          </summary>
          <div className="space-y-3 border-t px-4 pb-4 pt-3">
            <div className="flex justify-end">
              <Link
                href="/generate/saved"
                className="inline-flex min-h-12 items-center gap-0.5 rounded-sm text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                전체 보기 <ChevronRight aria-hidden="true" className="h-4 w-4" />
              </Link>
            </div>
            <SavedList initial={recentSaved} />
          </div>
        </details>
      )}
    </div>
  );
}

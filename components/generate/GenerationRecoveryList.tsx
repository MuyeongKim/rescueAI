import Link from "next/link";
import type { GenerationDraftSummary } from "@/lib/generation-draft";
import type { GenerationJobSummary } from "@/lib/generation-recovery";
import { DeleteGenerationDraftButton } from "@/components/generate/DeleteGenerationDraftButton";

const statusLabels: Record<string, string> = {
  queued: "접수됨", retrieving: "근거 조회 중", drafting: "제작 중", reviewing: "점검 중",
  repairing: "보완 중", completed: "제작 완료", needs_attention: "추가 보완 필요", failed: "다시 시도 필요",
};
export function GenerationRecoveryList({ jobs, drafts }: { jobs: GenerationJobSummary[]; drafts: GenerationDraftSummary[] }) {
  if (jobs.length === 0 && drafts.length === 0) return null;
  return <section className="space-y-3 rounded-lg border bg-card p-4" aria-labelledby="generation-recovery-heading">
    <h2 id="generation-recovery-heading" className="text-lg font-semibold">이어서 작업하기</h2>
    <p className="text-sm text-muted-foreground">다른 화면으로 이동해도 제작 작업과 자동보관된 개인 편집 초안을 여기서 다시 열 수 있습니다.</p>
    <ul className="divide-y">
      {drafts.map((draft) => <li key={draft.id} className="flex items-center gap-3">
        <Link className="flex min-h-16 min-w-0 flex-1 flex-wrap items-center justify-between gap-2 py-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={`/generate?d=${draft.id}`}>
          <span className="min-w-0 break-words font-medium">{draft.title}</span><span className="text-sm font-semibold text-primary">편집 초안 이어서 열기 →</span>
        </Link>
        <DeleteGenerationDraftButton id={draft.id} updatedAt={draft.updatedAt} title={draft.title} />
      </li>)}
      {jobs.map((job) => <li key={job.id}>
        <Link className="flex min-h-16 flex-wrap items-center justify-between gap-2 py-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={`/generate?j=${job.id}`}>
          <span className="min-w-0 break-words font-medium">{job.topic}</span><span className="text-sm font-semibold text-primary">{statusLabels[job.status]} · 열기 →</span>
        </Link>
      </li>)}
    </ul>
  </section>;
}

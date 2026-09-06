import Link from "next/link";
import { ChevronDown, History } from "lucide-react";
import type { GenerationDraftSummary } from "@/lib/generation-draft";
import type { GenerationJobSummary } from "@/lib/generation-recovery";
import { DeleteGenerationDraftButton } from "@/components/generate/DeleteGenerationDraftButton";

const statusLabels: Record<string, string> = {
  queued: "접수됨", retrieving: "근거 조회 중", drafting: "제작 중", reviewing: "점검 중",
  awaiting_review: "구성 확인 대기", cancelled: "중단됨",
  repairing: "보완 중", completed: "제작 완료", needs_attention: "추가 보완 필요", failed: "다시 시도 필요",
};
export function GenerationRecoveryList({ jobs, drafts, collapsible = false }: {
  jobs: GenerationJobSummary[];
  drafts: GenerationDraftSummary[];
  collapsible?: boolean;
}) {
  if (jobs.length === 0 && drafts.length === 0) return null;
  const content = <>
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
  </>;

  if (collapsible) {
    return (
      <details className="group/recovery rounded-lg border bg-card" aria-labelledby="generation-recovery-heading">
        <summary className="min-h-14 cursor-pointer list-none rounded-lg px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <h2 id="generation-recovery-heading" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-semibold">
            <History aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
            <span>이어서 작업하기</span>
            <span className="text-sm font-normal text-muted-foreground">{drafts.length + jobs.length}개</span>
            <span aria-hidden="true" className="ml-auto flex items-center gap-1 text-sm font-medium text-muted-foreground">
              <span className="group-open/recovery:hidden">펼치기</span>
              <span className="hidden group-open/recovery:inline">접기</span>
              <ChevronDown className="h-4 w-4 group-open/recovery:rotate-180" />
            </span>
          </h2>
        </summary>
        <div className="space-y-3 border-t px-4 pb-4 pt-3">{content}</div>
      </details>
    );
  }

  return <section className="space-y-3 rounded-lg border bg-card p-4" aria-labelledby="generation-recovery-heading">
    <h2 id="generation-recovery-heading" className="text-lg font-semibold">이어서 작업하기</h2>
    {content}
  </section>;
}

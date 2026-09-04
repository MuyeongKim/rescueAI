import type { GeneratedDocSource } from "@/lib/generate";

export function GeneratedSourceLink({ source }: { source: GeneratedDocSource }) {
  const label = `${source.doc}${source.page != null ? ` p.${source.page}` : ""}`;
  if (source.document_id <= 0) return <span>{label} <span className="text-sm text-muted-foreground">(원본 연결 대기)</span></span>;
  const href = `/docs/${source.document_id}${source.page && source.page > 0 ? `?page=${source.page}` : ""}`;
  return <a href={href} target="_blank" rel="noopener noreferrer"
    className="inline-flex min-h-12 max-w-full items-center break-words text-base font-medium text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    aria-label={`${label} 원본 새 창에서 보기`}>{label}<span aria-hidden="true" className="ml-1 shrink-0">↗</span></a>;
}

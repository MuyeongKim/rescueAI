import type { GeneratedDocSource } from "@/lib/generate";

/** 서버가 원문에서 직접 회수한 구절. 의미적 사실 검증 결과를 뜻하지 않는다. */
export type DocumentSectionEvidence = {
  source: GeneratedDocSource;
  excerpt: string;
  matchKind?: "text-overlap" | "source-page";
};

export type DocumentSectionEvidenceState = {
  status: "idle" | "loading" | "ready" | "error";
  items?: DocumentSectionEvidence[];
  error?: string;
};

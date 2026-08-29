// 자료제작 생성 컨텍스트 조회 — 전체 생성(/api/generate)과 부분 재생성(/api/generate/section)의 단일 출처.
// 서버 전용(supabase/server·admin 의존). 클라이언트에서 import 하지 말 것.
import { createClient } from "@/lib/supabase/server";
import {
  ragTableEnabled,
  fetchExternalRagContext,
  fetchExternalSopContext,
} from "@/lib/rag-external";
import {
  generatedSourceLabel,
  splitGeneratedSourcesForDisplay,
  type GeneratedDocSource,
} from "@/lib/generate";
import type { SopEvidence } from "@/lib/sop-evidence";

export type GenerationContext = {
  contextText: string;
  sources: GeneratedDocSource[];
  bindingSources: GeneratedDocSource[];
  degraded: boolean;
  sopEvidence: SopEvidence;
};

// 분야 자료의 청크를 모아 생성 컨텍스트 + 출처 목록을 만든다.
// topic 이 있으면 주제 관련 청크를 우선 검색한다(rag_rescue 경로).
export async function fetchCategoryContext(
  category: string,
  limit = 40,
  topic?: string,
): Promise<GenerationContext> {
  // RAG_TABLE=rag_rescue: 외부에서 임베딩해 둔 기존 테이블 사용
  if (ragTableEnabled()) {
    const query = topic?.trim() || `${category} 분야 핵심 훈련`;
    const [general, sop] = await Promise.all([
      fetchExternalRagContext(category, limit, query),
      fetchExternalSopContext(category, query, 4),
    ]);

    const merged = splitGeneratedSourcesForDisplay(
      [
        // 화면의 다섯 개 출처 안에도 확인된 SOP·현장지침이 최소 하나 보이게 한다.
        ...(sop.sources[0] ? [sop.sources[0]] : []),
        ...general.sources,
        ...sop.sources.slice(1),
      ],
      5,
    );
    const binding = splitGeneratedSourcesForDisplay(
      [...general.bindingSources, ...sop.bindingSources],
      Number.MAX_SAFE_INTEGER,
    );
    const contextText = sop.contextText
      ? `${general.contextText}\n\n=== 관련 SOP·현장지침 근거 ===\n${sop.contextText}`
      : general.contextText;

    return {
      contextText,
      sources: merged.sources,
      bindingSources: binding.bindingSources,
      degraded: general.degraded || sop.degraded,
      sopEvidence: sop.evidence,
    };
  }

  const supabase = await createClient();
  const { data: docs } = await supabase
    .from("documents")
    .select("id, title")
    .eq("category", category)
    .eq("status", "processed")
    .limit(50);
  if (!docs || docs.length === 0) {
    return {
      contextText: "",
      sources: [],
      bindingSources: [],
      degraded: false,
      sopEvidence: { status: "not_found", sourceLabels: [] },
    };
  }

  const titleById = new Map<number, string>(docs.map((d) => [d.id, d.title]));
  const { data: chunks } = await supabase
    .from("chunks")
    .select("content, page_num, document_id")
    .in(
      "document_id",
      docs.map((d) => d.id),
    )
    .limit(limit);
  if (!chunks || chunks.length === 0) {
    return {
      contextText: "",
      sources: [],
      bindingSources: [],
      degraded: false,
      sopEvidence: { status: "not_found", sourceLabels: [] },
    };
  }

  const contextText = chunks
    .map((c) => {
      const source: GeneratedDocSource = {
        document_id: c.document_id ?? -1,
        doc: titleById.get(c.document_id ?? -1) ?? "자료",
        page: c.page_num,
      };
      return `${generatedSourceLabel(source)}\n${c.content}`;
    })
    .join("\n\n---\n\n");

  const sourceCandidates: GeneratedDocSource[] = [];
  for (const c of chunks) {
    if (c.document_id == null) continue;
    sourceCandidates.push({
      document_id: c.document_id,
      doc: titleById.get(c.document_id) ?? "자료",
      page: c.page_num,
    });
  }
  const { sources, bindingSources } = splitGeneratedSourcesForDisplay(
    sourceCandidates,
    5,
  );
  return {
    contextText,
    sources,
    bindingSources,
    degraded: false,
    sopEvidence: { status: "not_found", sourceLabels: [] },
  };
}

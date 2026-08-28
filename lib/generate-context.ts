// 자료제작 생성 컨텍스트 조회 — 전체 생성(/api/generate)과 부분 재생성(/api/generate/section)의 단일 출처.
// 서버 전용(supabase/server·admin 의존). 클라이언트에서 import 하지 말 것.
import { createClient } from "@/lib/supabase/server";
import { ragTableEnabled, fetchExternalRagContext } from "@/lib/rag-external";
import type { GeneratedDocSource } from "@/lib/generate";

// 분야 자료의 청크를 모아 생성 컨텍스트 + 출처 목록을 만든다.
// topic 이 있으면 주제 관련 청크를 우선 검색한다(rag_rescue 경로).
export async function fetchCategoryContext(
  category: string,
  limit = 40,
  topic?: string
): Promise<{ contextText: string; sources: GeneratedDocSource[]; degraded: boolean }> {
  // RAG_TABLE=rag_rescue: 외부에서 임베딩해 둔 기존 테이블 사용
  if (ragTableEnabled()) return fetchExternalRagContext(category, limit, topic);

  const supabase = await createClient();
  const { data: docs } = await supabase
    .from("documents")
    .select("id, title")
    .eq("category", category)
    .limit(50);
  if (!docs || docs.length === 0) {
    return { contextText: "", sources: [], degraded: false };
  }

  const titleById = new Map<number, string>(docs.map((d) => [d.id, d.title]));
  const { data: chunks } = await supabase
    .from("chunks")
    .select("content, page_num, document_id")
    .in(
      "document_id",
      docs.map((d) => d.id)
    )
    .limit(limit);
  if (!chunks || chunks.length === 0) {
    return { contextText: "", sources: [], degraded: false };
  }

  const contextText = chunks
    .map(
      (c) =>
        `[${titleById.get(c.document_id ?? -1) ?? "자료"} p.${c.page_num ?? "-"}]\n${c.content}`
    )
    .join("\n\n---\n\n");

  const seen = new Set<string>();
  const sources: GeneratedDocSource[] = [];
  for (const c of chunks) {
    if (c.document_id == null) continue;
    const key = `${c.document_id}::${c.page_num ?? "-"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      document_id: c.document_id,
      doc: titleById.get(c.document_id) ?? "자료",
      page: c.page_num,
    });
    if (sources.length >= 5) break;
  }
  return { contextText, sources, degraded: false };
}

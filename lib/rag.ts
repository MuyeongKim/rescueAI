import { createClient } from "@/lib/supabase/server";
import { getQueryEmbedding, toPgVector } from "@/lib/embeddings";
import { ragTableEnabled, searchExternalRag, expandQuery } from "@/lib/rag-external";
import type { DocSource } from "@/lib/database.types";

// 근거가 없을 때의 표준 답변 문구 (환각 차단). 평가/테스트에서 참조.
export const NOT_FOUND_MESSAGE =
  "관련 매뉴얼에서 확인되지 않습니다. 구조 매뉴얼 담당자에게 문의하세요.";

export const DEFAULT_TOP_K = 5;
export const MAX_SOURCES = 3;

type HybridRow = {
  chunk_id: number;
  document_id: number;
  doc_title: string;
  content: string;
  page_num: number | null;
  rrf_score: number;
};

export type SearchResult = {
  contextText: string;
  sources: DocSource[];
  matched: number;
};

// 하이브리드 검색 → 컨텍스트 문자열 + 출처(중복 제거 최대 3개)
export async function searchContext(
  query: string,
  category?: string | null,
  topK: number = DEFAULT_TOP_K
): Promise<SearchResult> {
  // 쿼리 확장: 짧은 검색어가 제목·목차만 매칭하는 문제를 막기 위해 임베딩용 질의를 넓히고
  // 본문 매칭용 키워드를 함께 얻는다. (확장 실패/비활성 시 원문 query 로 폴백)
  const { embedText, keywords } = await expandQuery(query);
  const embedding = await getQueryEmbedding(embedText);

  // RAG_TABLE=rag_rescue: 외부에서 임베딩해 둔 기존 테이블로 검색 (홈서버 BGE 임베딩)
  // 하이브리드(벡터+키워드 RRF) + LLM 재순위를 위해 원문 query·확장 키워드도 함께 넘긴다.
  if (ragTableEnabled()) {
    return searchExternalRag(query, embedding, topK, category, keywords);
  }

  const supabase = await createClient();

  const { data, error } = await supabase.rpc("hybrid_search", {
    query_text: query,
    query_embedding: toPgVector(embedding),
    match_count: topK,
    filter_category: category && category.length > 0 ? category : null,
  });

  if (error) {
    console.error("[rag] hybrid_search error:", error.message);
    return { contextText: "", sources: [], matched: 0 };
  }

  const rows = (data ?? []) as HybridRow[];
  if (rows.length === 0) {
    return { contextText: "", sources: [], matched: 0 };
  }

  // 각 청크 앞에 [문서명 p.N] 라벨 (§8.1-3, §9.2)
  const contextText = rows
    .map((r) => `[${r.doc_title} p.${r.page_num ?? "-"}]\n${r.content}`)
    .join("\n\n---\n\n");

  // (document_id, page) 기준 중복 제거 후 상위 MAX_SOURCES개 (§9.3)
  const seen = new Set<string>();
  const sources: DocSource[] = [];
  for (const r of rows) {
    const key = `${r.document_id}::${r.page_num ?? "-"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      document_id: r.document_id,
      doc: r.doc_title,
      page: r.page_num,
      content: r.content.slice(0, 400),
    });
    if (sources.length >= MAX_SOURCES) break;
  }

  return { contextText, sources, matched: rows.length };
}

// §9.2 시스템 프롬프트 — 환각 가드레일의 단일 출처(single source of truth)
export function buildSystemPrompt(contextText: string): string {
  const reference =
    contextText.trim().length > 0
      ? contextText
      : "(관련 자료가 검색되지 않았습니다.)";

  return `당신은 전북특별자치도 소방본부 구조대원을 지원하는 AI 어시스턴트입니다.
아래 '참고 자료'(구조 매뉴얼·SOP·장비 자료)에 근거해, 현장에서 바로 쓸 수 있게 답하세요.

[규칙]
1. '참고 자료'에 있는 내용만 근거로 답하세요. 자료에 없는 수치·절차·장비명을 지어내지 마세요.
2. 근거가 전혀 없으면 추측하지 말고 정확히 이렇게만 답하세요:
   "${NOT_FOUND_MESSAGE}"
3. 자료에 일부만 있으면 있는 내용까지만 답하고, 부족한 부분은 "자료에서 확인되지 않음"이라고 명시하세요.
4. 부상자 생사·중증도 등 의학적 판단이나 법적 판단은 하지 말고,
   "현장 지휘관 또는 119 의료지도에 문의하세요" 라고 안내하세요.
5. 한국어로 간결하게, 핵심·결론부터. 절차·순서는 번호(1.2.3.)로 단계를 구분하세요.

[참고 자료]
${reference}`;
}

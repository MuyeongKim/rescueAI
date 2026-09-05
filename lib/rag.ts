import { createClient } from "@/lib/supabase/server";
import { getQueryEmbedding, toPgVector } from "@/lib/embeddings";
import {
  assertExternalEmbeddingContract,
  expandQuery,
  ragTableEnabled,
  searchExternalRag,
} from "@/lib/rag-external";
import type { DocSource } from "@/lib/database.types";

type SearchSupabaseClient = Awaited<ReturnType<typeof createClient>>;

export type SearchContextOptions = {
  // 요청 없는 통합평가/CLI에서만 명시적으로 주입한다. 생략하면 기존 쿠키 세션과 RLS를 사용한다.
  supabase?: SearchSupabaseClient;
};

// 근거가 없을 때의 표준 답변 문구 (환각 차단). 평가/테스트에서 참조.
export const NOT_FOUND_MESSAGE =
  "관련 매뉴얼에서 확인되지 않습니다. 구조 매뉴얼 담당자에게 문의하세요.";

// 튜터는 단답보다 원리·절차·안전사항까지 설명하므로 관련 청크를 넉넉히 제공한다.
// 외부 RAG와 기본 hybrid_search 모두 같은 기본값을 사용한다.
export const DEFAULT_TOP_K = 8;

type HybridRow = {
  chunk_id: number;
  document_id: number;
  doc_title: string;
  content: string;
  page_num: number | null;
  rrf_score: number;
};

export type RetrievalCoverage = {
  requested: string[];
  // 최종 컨텍스트에 주제·상황 단서가 부족한 항목. 코퍼스 전체의 부재 판정은 아니다.
  missing: string[];
  supplementalQueries: number;
};

export type SearchResult = {
  contextText: string;
  sources: DocSource[];
  matched: number;
  degraded?: boolean;
  // 질문에서 검출한 독립 조건. 해당 조건의 근거가 실제로 확보됐다는 의미는 아니다.
  independentEvidenceTopics?: string[];
  retrievalCoverage?: RetrievalCoverage;
};

// 하이브리드 검색 → 컨텍스트 문자열 + 제공한 문서/페이지 전체(중복 제거)
export async function searchContext(
  query: string,
  category?: string | null,
  topK: number = DEFAULT_TOP_K,
  options: SearchContextOptions = {}
): Promise<SearchResult> {
  // 쿼리 확장: 짧은 검색어가 제목·목차만 매칭하는 문제를 막기 위해 임베딩용 질의를 넓히고
  // 본문 매칭용 키워드를 함께 얻는다. (확장 실패/비활성 시 원문 query 로 폴백)
  const { embedText, keywords } = await expandQuery(query);

  // RAG_TABLE=rag_rescue: 외부에서 임베딩해 둔 운영 테이블로 검색(제공자 계약은 DB에서 검증)
  // 하이브리드(벡터+키워드 RRF) + LLM 재순위를 위해 원문 query·확장 키워드도 함께 넘긴다.
  if (ragTableEnabled()) {
    let embedding: number[] | null = null;
    let degraded = false;
    try {
      await assertExternalEmbeddingContract(options.supabase);
      embedding = await getQueryEmbedding(embedText);
    } catch (error) {
      // 다른 임베딩 공간으로 폴백하지 않는다. 키워드 검색은 계속 제공한다.
      degraded = true;
      console.error(
        "[rag] 벡터 검색 비활성화, 키워드 검색으로 진행:",
        error instanceof Error ? error.message : error
      );
    }
    const result = await searchExternalRag(
      query,
      embedding,
      topK,
      category,
      keywords,
      options.supabase
    );
    return { ...result, degraded: degraded || result.degraded };
  }

  const embedding = await getQueryEmbedding(embedText);
  const supabase = options.supabase ?? (await createClient());

  const { data, error } = await supabase.rpc("hybrid_search", {
    query_text: query,
    query_embedding: toPgVector(embedding),
    match_count: topK,
    filter_category: category && category.length > 0 ? category : null,
  });

  if (error) {
    console.error("[rag] hybrid_search error:", error.message);
    return { contextText: "", sources: [], matched: 0, degraded: true };
  }

  const rows = (data ?? []) as HybridRow[];
  if (rows.length === 0) {
    return { contextText: "", sources: [], matched: 0 };
  }

  // 각 청크 앞에 [문서명 p.N] 라벨 (§8.1-3, §9.2)
  const contextText = rows
    .map((r) => `[${r.doc_title} p.${r.page_num ?? "-"}]\n${r.content}`)
    .join("\n\n---\n\n");

  // 컨텍스트 뒤쪽 페이지도 사용자가 확인할 수 있도록 출처를 별도로 자르지 않는다.
  const byPage = new Map<string, DocSource>();
  const sources: DocSource[] = [];
  for (const r of rows) {
    const key = `${r.document_id}::${r.page_num ?? "-"}`;
    const existing = byPage.get(key);
    if (existing) {
      if (!existing.content.includes(r.content)) existing.content += `\n\n${r.content}`;
      continue;
    }
    const source: DocSource = {
      document_id: r.document_id,
      doc: r.doc_title,
      page: r.page_num,
      content: r.content,
    };
    byPage.set(key, source);
    sources.push(source);
  }

  return { contextText, sources, matched: rows.length };
}

// §9.2 시스템 프롬프트 — 환각 가드레일의 단일 출처(single source of truth)
export function buildSystemPrompt(
  contextText: string,
  answerGuidance = "",
  independentEvidenceTopics: readonly string[] = [],
  retrievalCoverage?: RetrievalCoverage
): string {
  const reference =
    contextText.trim().length > 0
      ? contextText
      : "(관련 자료가 검색되지 않았습니다.)";
  const separateTopics = [...new Set(independentEvidenceTopics.map((topic) => topic.trim()).filter(Boolean))];
  const isCompoundSituation = separateTopics.length >= 2;
  const responseStructure = isCompoundSituation
    ? `7. 여러 조건이 결합된 질문이므로 다음 형식으로 답하세요. 절차를 요청했어도 하나의 구조 작업 순서로 구성하지 마세요.
   첫 문장에서 질문의 모든 조건을 함께 다룬 통합 절차가 참고 자료에서 확인되는지 밝히세요. 확인되지 않으면 '이 복합 상황의 통합 절차는 자료에서 확인되지 않습니다'라고 명시한 뒤 개별 근거의 범위를 설명하세요.
   - 확인된 범위: 아래 개별 주제마다 실제 참고 자료가 뒷받침하는 내용만 분리하여 설명
   - 적용 차이: 자료의 대상·전제·예외와 질문 상황의 차이, 직접 적용할 수 있는지 확인이 필요한 이유
   - 추가 확인이 필요한 범위: 조건이 결합된 상황에서 자료로 확인되지 않는 내용
   개별 자료의 내용을 단계 1·단계 2 등의 연속 행동 순서로 배열하거나 서로 연결하는 절차를 만들지 마세요.
   개별 주제의 설명은 주제마다 2~3문장으로 자료가 다루는 원칙과 적용 범위를 요약하는 데 한정하세요. 처치·장비 조작의 세부 동작을 나열하면 질문 상황에 대한 실행 지시로 읽힐 수 있으므로 나열하지 마세요. 질문 상황에 적용이 확인되지 않은 결속·하중 이전·절단·분리·이송 동작을 수행 지시로 제시하지 마세요.
   참고 자료에 명시되지 않은 전제를 '지상 환자를 전제로 한다'처럼 만들어 내지 마세요. 원문에서 제거의 예외를 설명했다고 절단이나 다른 조작까지 허용된다고 바꾸지 마세요.`
    : `7. 기본 답변 구조는 다음과 같습니다. 질문 성격상 불필요한 항목은 억지로 만들지 말고 자연스럽게 생략하세요.
   - 핵심 답변: 먼저 결론과 요점을 2~4문장으로 설명
   - 세부 설명: 이유·원리·적용 조건을 설명하고, 절차가 있으면 번호(1. 2. 3.)로 구분
   - 현장 확인사항: 준비물·점검 항목·실수하기 쉬운 부분을 참고 자료 범위에서 정리
   - 안전 유의사항: 위험요소와 중단·보고·추가 확인이 필요한 상황을 참고 자료 범위에서 명시`;
  const effectiveGuidance = isCompoundSituation
    ? `[답변 유형: 복합 상황의 근거 범위 안내형]
질문에서 구분한 개별 주제: ${separateTopics.join(" / ")}
위 주제 목록은 검색된 근거가 있다는 보증이 아닙니다. 실제 참고 자료를 확인한 뒤 근거가 있는 주제만 설명하세요.
개별 주제의 근거와 모든 조건을 함께 다룬 근거를 구분하고, 규칙 7의 형식으로 답하세요.
전용 절차가 없다는 단서를 붙인 뒤 통합 행동절차를 제시하는 방식도 금지합니다.`
    : answerGuidance;

  return `당신은 전북특별자치도 소방본부 구조대원을 지원하는 AI 어시스턴트입니다.
아래 '참고 자료'(구조 매뉴얼·SOP·장비 자료)에 근거해, ${isCompoundSituation ? "자료가 확인하는 범위와 질문 상황의 적용 차이를 교육·검토할 수 있게" : "현장에서 바로 쓸 수 있게"} 답하세요.

[규칙]
1. '참고 자료'에 있는 내용만 근거로 답하세요. 자료에 없는 수치·절차·장비명을 지어내지 마세요.
2. 근거가 전혀 없으면 추측하지 말고 정확히 이렇게만 답하세요:
   "${NOT_FOUND_MESSAGE}"
3. 자료에 일부만 있으면 있는 내용까지만 답하고, 부족한 부분은 "자료에서 확인되지 않음"이라고 명시하세요.
   여러 조건이 결합된 질문은 개별 조건의 근거와 모든 조건이 동시에 성립하는 상황의 근거를 구분하세요.
   개별 조건의 자료만 있으면 '확인된 범위'와 '추가 확인이 필요한 범위'를 먼저 밝히고,
   각 자료의 적용 대상·전제·예외를 함께 설명하세요. 일부 근거가 있는데 규칙 2의 표준 문구로 전체 답변을 대체하지 마세요.
   서로 다른 상황의 절차를 임의로 이어 붙여 질문 전체에 적용되는 행동 순서로 만들지 마세요.
   질문의 다른 조건 때문에 적용 여부가 불확실한 절차는 수행하도록 권하지 말고, 확인이 필요한 근거로만 제시하세요.
4. 부상자 생사·중증도 등 의학적 판단이나 법적 판단은 하지 말고,
   "현장 지휘관 또는 119 의료지도에 문의하세요" 라고 안내하세요.
5. 한국어로 핵심·결론부터 답하되, 단답으로 끝내지 말고 질문 해결에 필요한 근거와 세부 내용을 충분히 설명하세요.
${isCompoundSituation
    ? "6. 개별 자료의 적용 범위를 설명하되, 다른 조건의 환자·대상에 관한 시간·수치·장비 조작을 질문 상황의 기준처럼 나열하지 마세요. 각 주제는 원문에서 확인된 요점만 간결하게 서술하고, 현재 상황에서 무엇을 하라는 지시와 구분하세요."
    : "6. 참고 자료에 있는 동작·조건·수치·장비명·주의사항은 생략하거나 뭉뚱그리지 말고 구체적으로 적으세요."}
${responseStructure}
8. 답변 본문(핵심 답변·세부 설명·절차·현장 확인사항·안전 유의사항)에는
   [문서명 p.3] 같은 출처 라벨이나 문서명·페이지를 직접 쓰지 마세요.
   시스템은 답변 작성에 제공한 참고 자료를 답변 맨 아래의 '근거 자료' 영역에 중복 없이 한 번만 자동 표시합니다.
   이 목록은 각 문장의 정확성이나 실제 인용 여부를 별도로 검증한 결과가 아닙니다.
   따라서 별도의 출처 목록도 작성하지 말고, 참고 자료에 없는 문서명·페이지는 만들지 마세요.
9. 답변을 풍부하게 만들기 위해 일반 상식이나 추측을 덧붙이지 마세요. 내용이 부족하면 부족한 범위를 명확히 밝히세요.

${effectiveGuidance ? `[질문별 답변 구성]\n${effectiveGuidance}\n` : ""}

${retrievalCoverage ? `[검색 범위 점검]\n질문에서 확인할 항목: ${retrievalCoverage.requested.join(" / ")}\n최종 참고 자료에서 검색 단서가 부족한 항목: ${retrievalCoverage.missing.join(" / ") || "없음"}\n이 점검은 단어·주제 단서 기준이며 적용 가능성이나 사실성 검증이 아닙니다. 부족하다고 표시된 항목은 원문으로 직접 확인할 수 있을 때만 설명하고, 확인할 수 없으면 해당 항목을 명시해 추가 확인 범위로 남기세요. 자료가 없다는 코퍼스 전체의 판정으로 바꾸지 마세요. 모든 개별 항목의 단서가 있어도 결합 상황의 전용 절차가 확인됐다는 뜻은 아닙니다.\n` : ""}

[참고 자료]
${reference}`;
}

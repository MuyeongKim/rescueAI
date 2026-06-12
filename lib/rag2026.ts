// 기존 rag_2026 테이블(외부에서 임베딩해 적재한 LangChain 형식) 연동 어댑터.
// RAG_TABLE=rag_2026 환경변수가 설정되면 lib/rag.ts·/api/generate 가 이 모듈을 사용한다.
//
// rag_2026 스키마: { id uuid, content text, metadata jsonb, embedding vector(1024) }
// metadata 예: { source: "2026년 복무관리 계획.pdf", category: "복무규정",
//               "Header 2": "...", year, upload_date, parser }
// 검색 RPC: match_rag_2026(query_embedding, match_count, match_threshold?, filter jsonb)
import { createClient } from "@/lib/supabase/server";
import { toPgVector } from "@/lib/embeddings";
import type { DocSource } from "@/lib/database.types";
import type { SearchResult } from "@/lib/rag";
import type { GeneratedDocSource } from "@/lib/generate";

export function ragTableEnabled(): boolean {
  return process.env.RAG_TABLE === "rag_2026";
}

type RagRow = {
  id: string;
  content: string;
  metadata: {
    source?: string;
    category?: string;
    ["Header 2"]?: string;
    [k: string]: unknown;
  } | null;
  similarity?: number;
};

function labelOf(meta: RagRow["metadata"]): string {
  const src = (meta?.source ?? "자료").replace(/\.(pdf|hwpx?|pptx?|docx?)$/i, "");
  const header = meta?.["Header 2"];
  return header && header !== src ? `${src} — ${header}` : src;
}

// 벡터 검색 → 챗봇/생성용 컨텍스트 + 출처 (lib/rag.ts SearchResult 형식)
export async function searchRag2026(
  embedding: number[],
  topK: number,
  category?: string | null
): Promise<SearchResult> {
  const supabase = await createClient();
  // rag_2026 은 수작성 Database 타입에 없는 외부 테이블 — 형식 검사를 우회한다.
  const { data, error } = await (supabase.rpc as CallableFunction)(
    "match_rag_2026",
    {
      query_embedding: toPgVector(embedding),
      match_count: topK,
      // 관련 없는 청크 차단 + RPC 기본 임계값에 의존하지 않도록 명시
      match_threshold: 0.2,
      filter: category ? { category } : {},
    }
  );

  if (error) {
    console.error("[rag2026] match_rag_2026 error:", error.message);
    return { contextText: "", sources: [], matched: 0 };
  }

  const rows = (data ?? []) as RagRow[];
  if (rows.length === 0) return { contextText: "", sources: [], matched: 0 };

  const contextText = rows
    .map((r) => `[${labelOf(r.metadata)}]\n${r.content}`)
    .join("\n\n---\n\n");

  // 출처는 파일(source) 단위로 중복 제거, 최대 3개. 원문 뷰어가 없으므로 document_id=0.
  const seen = new Set<string>();
  const sources: DocSource[] = [];
  for (const r of rows) {
    const key = r.metadata?.source ?? "자료";
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      document_id: 0,
      doc: labelOf(r.metadata),
      page: null,
      content: r.content.slice(0, 400),
    });
    if (sources.length >= 3) break;
  }

  return { contextText, sources, matched: rows.length };
}

// 분야 자료를 모아 생성(AI 자료제작) 컨텍스트를 만든다 (벡터 검색 없이 카테고리 일괄).
export async function fetchRag2026Context(
  category: string,
  limit = 40
): Promise<{ contextText: string; sources: GeneratedDocSource[] }> {
  const supabase = await createClient();
  const { data, error } = await (supabase.from as CallableFunction)("rag_2026")
    .select("content, metadata")
    .eq("metadata->>category", category)
    .limit(limit);

  if (error) {
    console.error("[rag2026] fetch context error:", error.message);
    return { contextText: "", sources: [] };
  }
  const rows = (data ?? []) as RagRow[];
  if (rows.length === 0) return { contextText: "", sources: [] };

  const contextText = rows
    .map((r) => `[${labelOf(r.metadata)}]\n${r.content}`)
    .join("\n\n---\n\n");

  const seen = new Set<string>();
  const sources: GeneratedDocSource[] = [];
  for (const r of rows) {
    const key = r.metadata?.source ?? "자료";
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ document_id: 0, doc: labelOf(r.metadata), page: null });
    if (sources.length >= 5) break;
  }
  return { contextText, sources };
}

// 분야 → 원본 파일명 목록 (AI 자료제작 선택지·NotebookLM 자료 목록용)
export async function listRag2026Categories(): Promise<Record<string, string[]>> {
  const supabase = await createClient();
  const { data, error } = await (supabase.from as CallableFunction)("rag_2026")
    .select("category:metadata->>category, source:metadata->>source")
    .limit(10000);

  if (error) {
    console.error("[rag2026] list categories error:", error.message);
    return {};
  }

  const byCat = new Map<string, Set<string>>();
  for (const r of (data ?? []) as { category: string | null; source: string | null }[]) {
    if (!r.category) continue;
    if (!byCat.has(r.category)) byCat.set(r.category, new Set());
    if (r.source) byCat.get(r.category)!.add(r.source);
  }
  return Object.fromEntries(
    Array.from(byCat.entries()).map(([c, s]) => [c, Array.from(s).sort()])
  );
}

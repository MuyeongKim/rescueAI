// 기존 rag_2026 테이블(외부에서 임베딩해 적재한 LangChain 형식) 연동 어댑터.
// RAG_TABLE=rag_2026 환경변수가 설정되면 lib/rag.ts·/api/generate 가 이 모듈을 사용한다.
//
// rag_2026 스키마: { id uuid, content text, metadata jsonb, embedding vector(1024) }
// metadata 예: { source: "...", category: "SOP"(원본·n8n용), edu_category: "현장대응(SOP)"(구조
//               교육 관점 재분류 — 이 앱이 분야로 사용), "Header 2": "...", year, upload_date }
// 분야 필드는 edu_category 를 사용한다(기존 category 는 보존). 미적용 데이터 폴백은 category.
// 검색 RPC: match_rag_2026(query_embedding, match_count, match_threshold?, filter jsonb)
const CATEGORY_FIELD = "edu_category";
import { generateObject } from "ai";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { toPgVector } from "@/lib/embeddings";
import { getChatModel } from "@/lib/llm";
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
    category?: string; // 원본 분류(보존)
    edu_category?: string; // 구조 교육 관점 재분류(이 앱의 분야)
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

// 청크 본문 정제: docling 이미지 마커·목차 점선·과잉 공백 제거 (LLM 입력 노이즈 감소)
function cleanContent(c: string): string {
  return c
    .replace(/<!--\s*image\s*-->/gi, "")
    .replace(/[·∙․.]{4,}/g, " ") // 목차 leader 점선
    .replace(/\s+/g, " ")
    .trim();
}

// 노이즈 청크 판별: 목차/개정이력 헤더, 정제 후 껍데기(제목만) → 검색 결과에서 제외
const NOISE_HEADERS = new Set(["Contents", "목차", "개정이력서"]);
function isNoise(cleaned: string, header?: string): boolean {
  const h = (header ?? "").replace(/\s+/g, "").trim();
  if (NOISE_HEADERS.has(h)) return true;
  if (cleaned.length < 40) return true; // 제목만 있고 본문 없는 청크
  return false;
}

// 후보 행들을 정제·노이즈제외 후 상위 N개만 추려 (LLM 컨텍스트용) 의미 청크로 반환
function refine(rows: RagRow[], keep: number): { meta: RagRow["metadata"]; text: string }[] {
  const out: { meta: RagRow["metadata"]; text: string }[] = [];
  for (const r of rows) {
    const text = cleanContent(r.content);
    if (isNoise(text, r.metadata?.["Header 2"])) continue;
    out.push({ meta: r.metadata, text });
    if (out.length >= keep) break;
  }
  return out;
}

// RRF(Reciprocal Rank Fusion): 여러 순위 리스트를 id 기준으로 융합. score=Σ 1/(k+rank).
function rrfFuse(lists: RagRow[][], k = 60): RagRow[] {
  const score = new Map<string, number>();
  const byId = new Map<string, RagRow>();
  for (const list of lists) {
    list.forEach((row, idx) => {
      if (!row?.id) return;
      byId.set(row.id, row);
      score.set(row.id, (score.get(row.id) ?? 0) + 1 / (k + idx + 1));
    });
  }
  return Array.from(score.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => byId.get(id)!);
}

// 키워드 질의 구성: 공백·구두점으로 나눠 2자+ 토큰만 OR 로 묶어 full-text 재현율 확보.
function buildKeywordQuery(query: string): string {
  const tokens = query
    .split(/[\s,.()[\]{}:;"'`/\\?!~·…\-—]+/)
    .filter((t) => t.length >= 2)
    .slice(0, 8);
  return tokens.join(" or ");
}

const rerankSchema = z.object({ ranked: z.array(z.number()) });

// LLM 재순위: 융합 후보 중 질문 관련도 높은 순으로 keep 개 선택. 실패 시 융합 순서 유지(안전).
async function llmRerank(
  query: string,
  items: { meta: RagRow["metadata"]; text: string }[],
  keep: number
): Promise<{ meta: RagRow["metadata"]; text: string }[]> {
  if (process.env.RERANK === "0" || items.length <= keep) return items.slice(0, keep);
  try {
    const listed = items
      .map((it, i) => `[${i}] ${labelOf(it.meta)}\n${it.text.slice(0, 350)}`)
      .join("\n\n");
    const { object } = await generateObject({
      model: getChatModel(),
      schema: rerankSchema,
      prompt: `질문에 답하는 데 가장 관련 깊은 자료를 골라, 관련도 높은 순서로 최대 ${keep}개의 번호만 JSON 배열로 반환하세요.\n\n질문: ${query}\n\n자료:\n${listed}\n\n예: {"ranked":[3,0,5]}`,
      temperature: 0,
      // 재순위는 단순 작업 — Gemini 사고(thinking) 끄면 지연 크게 감소 (타 제공자는 무시됨)
      providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } },
    });
    const seen = new Set<number>();
    const picked: { meta: RagRow["metadata"]; text: string }[] = [];
    for (const idx of object.ranked) {
      if (Number.isInteger(idx) && idx >= 0 && idx < items.length && !seen.has(idx)) {
        seen.add(idx);
        picked.push(items[idx]);
      }
      if (picked.length >= keep) break;
    }
    // 모자라면 융합 순서로 채움
    for (let i = 0; i < items.length && picked.length < keep; i++) {
      if (!seen.has(i)) picked.push(items[i]);
    }
    return picked;
  } catch (e) {
    console.error("[rag2026] 재순위 실패, 융합 순서 유지:", e);
    return items.slice(0, keep);
  }
}

// 하이브리드 검색(벡터+키워드 RRF) + LLM 재순위 → 컨텍스트 + 출처 (lib/rag.ts SearchResult)
export async function searchRag2026(
  query: string,
  embedding: number[],
  topK: number,
  category?: string | null
): Promise<SearchResult> {
  const supabase = createAdminClient();
  // 노이즈가 섞여도 의미 청크가 충분히 남도록 후보를 넉넉히 받는다.
  const candidateCount = Math.max(24, topK * 4);
  const kwQuery = buildKeywordQuery(query);

  // ① 벡터 검색(RPC) + ② 키워드 full-text(websearch/simple) 병렬
  const [vecRes, kwRes] = await Promise.all([
    (supabase.rpc as CallableFunction)("match_rag_2026", {
      query_embedding: toPgVector(embedding),
      match_count: candidateCount,
      match_threshold: 0.3, // 약한 벡터 매칭 차단(정상 0.5+)
      filter: category ? { [CATEGORY_FIELD]: category } : {},
    }),
    (async () => {
      if (!kwQuery) return { data: [], error: null };
      let q = (supabase.from as CallableFunction)("rag_2026")
        .select("id, content, metadata")
        .textSearch("content", kwQuery, { type: "websearch", config: "simple" })
        .limit(candidateCount);
      if (category) q = q.eq(`metadata->>${CATEGORY_FIELD}`, category);
      return q;
    })(),
  ]);

  if (vecRes.error) console.error("[rag2026] vector error:", vecRes.error.message);
  if (kwRes.error) console.error("[rag2026] keyword error:", kwRes.error.message);

  const vecRows = (vecRes.data ?? []) as RagRow[];
  const kwRows = (kwRes.data ?? []) as RagRow[];

  // ③ RRF 융합 → ④ 정제·노이즈 제외(후보 12) → ⑤ LLM 재순위(상위 8)
  const fused = rrfFuse([vecRows, kwRows]);
  if (fused.length === 0) return { contextText: "", sources: [], matched: 0 };
  const refined = refine(fused, 12);
  if (refined.length === 0) return { contextText: "", sources: [], matched: 0 };
  const top = await llmRerank(query, refined, 8);

  const contextText = top
    .map((r) => `[${labelOf(r.meta)}]\n${r.text}`)
    .join("\n\n---\n\n");

  // 출처는 파일(source) 단위 중복 제거, 최대 3개. 원문 뷰어 없어 document_id=0.
  const seen = new Set<string>();
  const sources: DocSource[] = [];
  for (const r of top) {
    const key = r.meta?.source ?? "자료";
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      document_id: 0,
      doc: labelOf(r.meta),
      page: null,
      content: r.text.slice(0, 400),
    });
    if (sources.length >= 3) break;
  }

  return { contextText, sources, matched: top.length };
}

// 분야 자료를 모아 생성(AI 자료제작) 컨텍스트를 만든다 (벡터 검색 없이 카테고리 일괄).
export async function fetchRag2026Context(
  category: string,
  limit = 40
): Promise<{ contextText: string; sources: GeneratedDocSource[] }> {
  const supabase = createAdminClient();
  // 노이즈 제외 후에도 limit 만큼 남도록 후보를 2배로 받는다.
  const { data, error } = await (supabase.from as CallableFunction)("rag_2026")
    .select("content, metadata")
    .eq(`metadata->>${CATEGORY_FIELD}`, category)
    .limit(limit * 2);

  if (error) {
    console.error("[rag2026] fetch context error:", error.message);
    return { contextText: "", sources: [] };
  }
  const rows = (data ?? []) as RagRow[];
  // 정제·노이즈제외 (생성 컨텍스트도 깨끗한 본문만). limit 만큼 의미 청크 확보.
  const refined = refine(rows, limit);
  if (refined.length === 0) return { contextText: "", sources: [] };

  const contextText = refined
    .map((r) => `[${labelOf(r.meta)}]\n${r.text}`)
    .join("\n\n---\n\n");

  const seen = new Set<string>();
  const sources: GeneratedDocSource[] = [];
  for (const r of refined) {
    const key = r.meta?.source ?? "자료";
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ document_id: 0, doc: labelOf(r.meta), page: null });
    if (sources.length >= 5) break;
  }
  return { contextText, sources };
}

// 분야 → 원본 파일명 목록 (AI 자료제작 선택지·NotebookLM 자료 목록용)
// Supabase REST는 요청당 최대 1000행이라, 전체 분야를 빠짐없이 모으려면 페이지네이션 필요.
export async function listRag2026Categories(): Promise<Record<string, string[]>> {
  const supabase = createAdminClient();
  const PAGE = 1000;
  const byCat = new Map<string, Set<string>>();

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await (supabase.from as CallableFunction)("rag_2026")
      .select(`category:metadata->>${CATEGORY_FIELD}, source:metadata->>source`)
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("[rag2026] list categories error:", error.message);
      break;
    }
    const rows = (data ?? []) as { category: string | null; source: string | null }[];
    for (const r of rows) {
      if (!r.category) continue;
      if (!byCat.has(r.category)) byCat.set(r.category, new Set());
      if (r.source) byCat.get(r.category)!.add(r.source);
    }
    if (rows.length < PAGE) break; // 마지막 페이지
  }

  return Object.fromEntries(
    Array.from(byCat.entries()).map(([c, s]) => [c, Array.from(s).sort()])
  );
}

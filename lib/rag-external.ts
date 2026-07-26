// 외부에서 임베딩해 적재한 LangChain 형식 벡터 테이블(예: rag_rescue) 연동 어댑터.
// RAG_TABLE 환경변수가 설정되면 lib/rag.ts·/api/generate 가 이 모듈을 사용한다.
//
// 스키마: { id uuid, content text, metadata jsonb, embedding vector(1024) }
// metadata 예: { source: "...", category: "SOP"(원본·n8n용), edu_category: "현장대응(SOP)"(구조
//               교육 관점 재분류 — 이 앱이 분야로 사용), "Header 2": "...", year, upload_date }
// 분야 필드는 edu_category 를 사용한다(기존 category 는 보존). 미적용 데이터 폴백은 category.
// 검색 RPC: match_<RAG_TABLE>(query_embedding, match_count, match_threshold?, filter jsonb)
const CATEGORY_FIELD = "edu_category";
import { generateObject } from "ai";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  getConfiguredEmbeddingContract,
  getQueryEmbedding,
  toPgVector,
} from "@/lib/embeddings";
import { getChatModel } from "@/lib/llm";
import type { DocSource } from "@/lib/database.types";
import type { SearchResult } from "@/lib/rag";
import type { GeneratedDocSource } from "@/lib/generate";

// 테이블·검색함수 이름은 RAG_TABLE 단일 출처에서 파생(이름 변경 시 env+SQL만 고치면 됨).
// 검색 RPC 규칙: match_<테이블명> (예: rag_rescue → match_rag_rescue).
const RAG_TABLE = process.env.RAG_TABLE || "rag_rescue";
const MATCH_FN = `match_${RAG_TABLE}`;

export function ragTableEnabled(): boolean {
  return !!process.env.RAG_TABLE;
}

let contractCache: { key: string; validUntil: number } | null = null;

export async function assertExternalEmbeddingContract(): Promise<void> {
  const expected = getConfiguredEmbeddingContract();
  const cacheKey = [
    RAG_TABLE,
    expected.provider,
    expected.model,
    expected.dimensions,
    expected.version,
  ].join(":");
  if (contractCache?.key === cacheKey && contractCache.validUntil > Date.now()) return;

  const supabase = await createClient();
  const { data, error } = await (supabase.from as CallableFunction)("rag_embedding_config")
    .select("provider, model, dimensions, version")
    .eq("table_name", RAG_TABLE)
    .limit(1);
  if (error) {
    throw new Error(`임베딩 계약 조회 실패: ${error.message}`);
  }

  const actual = (data ?? [])[0] as
    | { provider: string; model: string; dimensions: number; version: string }
    | undefined;
  if (!actual) {
    throw new Error(`${RAG_TABLE}의 임베딩 계약이 등록되지 않았습니다.`);
  }
  const mismatches = (
    [
      ["provider", expected.provider, actual.provider],
      ["model", expected.model, actual.model],
      ["dimensions", expected.dimensions, actual.dimensions],
      ["version", expected.version, actual.version],
    ] as const
  ).filter(([, wanted, found]) => wanted !== found);
  if (mismatches.length > 0) {
    throw new Error(
      `임베딩 계약 불일치: ${mismatches
        .map(([field, wanted, found]) => `${field}=${String(wanted)}(앱)/${String(found)}(DB)`)
        .join(", ")}`
    );
  }
  contractCache = { key: cacheKey, validUntil: Date.now() + 60_000 };
}

type RagRow = {
  id: string;
  content: string;
  metadata: {
    source?: string;
    category?: string; // 원본 분류(보존)
    edu_category?: string; // 구조 교육 관점 재분류(이 앱의 분야)
    ["Header 2"]?: string;
    document_id?: number | string;
    page_num?: number | string;
    [k: string]: unknown;
  } | null;
  similarity?: number;
};

function numberMetadata(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function documentIdOf(meta: RagRow["metadata"]): number {
  return numberMetadata(meta?.document_id) ?? 0;
}

function pageOf(meta: RagRow["metadata"]): number | null {
  return numberMetadata(meta?.page_num);
}

function documentLabelOf(meta: RagRow["metadata"]): string {
  const src = (meta?.source ?? "자료").replace(/\.(pdf|hwpx?|pptx?|docx?)$/i, "");
  const header = meta?.["Header 2"];
  return header && header !== src ? `${src} — ${header}` : src;
}

function labelOf(meta: RagRow["metadata"]): string {
  const label = documentLabelOf(meta);
  const page = pageOf(meta);
  return page == null ? label : `${label} p.${page}`;
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

// 목차/색인 청크 판별: "SOP NNN … 페이지" 항목이 여러 번 반복되는 표.
// 쿼리어(SOP·항목명)가 본문보다 목차에 밀집해 검색 상위를 점령하는 문제를 막는다.
// 헤더가 'Contents'가 아니어도(예: "재난현장 표준작전절차 SOP") 본문 절차 청크를 밀어내므로 제거.
function isTocLike(cleaned: string): boolean {
  // "SOP 325", "SOP | 107" 처럼 코드번호가 붙은 항목 수
  const numbered = (cleaned.match(/SOP\s*\|?\s*\d{2,3}/g) ?? []).length;
  if (numbered >= 3) return true;
  // 색인 불릿(∙․) + SOP 가 반복되는 줄
  const bullets = (cleaned.match(/[∙·][․·]?\s*SOP/g) ?? []).length;
  if (bullets >= 3) return true;
  return false;
}

function isNoise(cleaned: string, header?: string): boolean {
  const h = (header ?? "").replace(/\s+/g, "").trim();
  if (NOISE_HEADERS.has(h)) return true;
  if (cleaned.length < 40) return true; // 제목만 있고 본문 없는 청크
  if (isTocLike(cleaned)) return true; // 목차/색인 표
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

// 키워드 질의 구성: 공백·구두점으로 나눠 2자+ 토큰 + 확장 키워드를 OR 로 묶어 재현율 확보.
// extra: 쿼리 확장 LLM이 뽑은 핵심어(복합어 분해·약어 풀이 포함). 본문 매칭률을 높인다.
function buildKeywordQuery(query: string, extra: string[] = []): string {
  const tokens = query.split(/[\s,.()[\]{}:;"'`/\\?!~·…\-—]+/);
  const all = [...tokens, ...extra]
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  return Array.from(new Set(all)).slice(0, 12).join(" or ");
}

// 쿼리 확장: 짧은 검색어("소방드론 SOP")는 제목·목차만 매칭돼 본문 절차가 밀려난다.
// 검색 전에 LLM으로 (a) 임베딩용 자연어 질의와 (b) 본문 매칭용 키워드(복합어 분해·약어 풀이)를
// 만들어 재현율을 끌어올린다. QUERY_EXPANSION=0 이거나 실패 시 원문 그대로 사용(안전).
const expandSchema = z.object({
  paraphrase: z.string(),
  keywords: z.array(z.string()),
});

export async function expandQuery(
  query: string
): Promise<{ embedText: string; keywords: string[] }> {
  if (process.env.QUERY_EXPANSION === "0") return { embedText: query, keywords: [] };
  try {
    const { object } = await generateObject({
      model: getChatModel(),
      schema: expandSchema,
      prompt: `소방·구조 매뉴얼(SOP·장비) 벡터 검색을 위해 아래 검색어를 확장하세요.
- paraphrase: 검색 의도를 살린 한 문장의 자연어 질의. 약어는 풀어쓰고(SOP→표준작전절차), 복합어 의도를 드러내세요.
- keywords: 본문 매칭용 핵심어 5~8개. 복합어는 구성어로도 분해(예: "소방드론"→"드론"), 약어는 풀어쓴 말도 포함.

검색어: ${query}

예: {"paraphrase":"소방 드론의 재난현장 표준작전절차와 운용 안전 수칙","keywords":["드론","소방드론","비행","운용","안전","상황분석"]}`,
      temperature: 0,
      providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } },
    });
    const para = object.paraphrase?.trim();
    return {
      embedText: para ? `${query} ${para}` : query,
      keywords: Array.isArray(object.keywords) ? object.keywords : [],
    };
  } catch (e) {
    console.error("[rag-external] 쿼리 확장 실패, 원문 사용:", e);
    return { embedText: query, keywords: [] };
  }
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
    console.error("[rag-external] 재순위 실패, 융합 순서 유지:", e);
    return items.slice(0, keep);
  }
}

// 하이브리드 후보 검색: ① 벡터(RPC) + ② 키워드 full-text 병렬 → ③ RRF 융합.
// 챗봇(searchExternalRag)과 자료제작(fetchExternalRagContext)이 동일 검색을 공유하는 단일 출처.
async function hybridCandidates(
  supabase: Awaited<ReturnType<typeof createClient>>,
  embedding: number[] | null,
  keywordQuery: string,
  category: string | null | undefined,
  candidateCount: number
): Promise<{ rows: RagRow[]; degraded: boolean }> {
  const [vecRes, kwRes] = await Promise.all([
    embedding
      ? (supabase.rpc as CallableFunction)(MATCH_FN, {
          query_embedding: toPgVector(embedding),
          match_count: candidateCount,
          match_threshold: 0.3, // 약한 벡터 매칭 차단(정상 0.5+)
          filter: category ? { [CATEGORY_FIELD]: category } : {},
        })
      : Promise.resolve({ data: [], error: null }),
    (async () => {
      if (!keywordQuery) return { data: [], error: null };
      let q = (supabase.from as CallableFunction)(RAG_TABLE)
        .select("id, content, metadata")
        .eq("is_active", true)
        .textSearch("content", keywordQuery, { type: "websearch", config: "simple" })
        .limit(candidateCount);
      if (category) q = q.eq(`metadata->>${CATEGORY_FIELD}`, category);
      return q;
    })(),
  ]);

  if (vecRes.error) console.error("[rag-external] vector error:", vecRes.error.message);
  if (kwRes.error) console.error("[rag-external] keyword error:", kwRes.error.message);

  const vecRows = (vecRes.data ?? []) as RagRow[];
  const kwRows = (kwRes.data ?? []) as RagRow[];
  return {
    rows: rrfFuse([vecRows, kwRows]),
    degraded: Boolean(vecRes.error || kwRes.error),
  };
}

// 정제된 청크들을 생성용 컨텍스트 문자열 + 출처(파일 단위 중복 제거)로 조립한다.
function buildContextFromRefined(
  refined: { meta: RagRow["metadata"]; text: string }[],
  maxSources: number
): { contextText: string; sources: GeneratedDocSource[] } {
  const contextText = refined
    .map((r) => `[${labelOf(r.meta)}]\n${r.text}`)
    .join("\n\n---\n\n");

  const seen = new Set<string>();
  const sources: GeneratedDocSource[] = [];
  for (const r of refined) {
    const documentId = documentIdOf(r.meta);
    const page = pageOf(r.meta);
    const key = `${documentId || r.meta?.source || "자료"}::${page ?? "-"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ document_id: documentId, doc: documentLabelOf(r.meta), page });
    if (sources.length >= maxSources) break;
  }
  return { contextText, sources };
}

// 하이브리드 검색(벡터+키워드 RRF) + LLM 재순위 → 컨텍스트 + 출처 (lib/rag.ts SearchResult)
export async function searchExternalRag(
  query: string,
  embedding: number[] | null,
  topK: number,
  category?: string | null,
  keywordTerms: string[] = []
): Promise<SearchResult> {
  const supabase = await createClient();
  // 노이즈(목차·총론)가 섞여도 본문 청크가 충분히 남도록 후보를 넉넉히 받는다.
  const candidateCount = Math.max(40, topK * 6);
  const kwQuery = buildKeywordQuery(query, keywordTerms);

  // ①② 하이브리드 후보 → ③ RRF 융합 → ④ 정제·노이즈 제외(후보 12) → ⑤ LLM 재순위(상위 8)
  const candidates = await hybridCandidates(
    supabase,
    embedding,
    kwQuery,
    category,
    candidateCount
  );
  const fused = candidates.rows;
  if (fused.length === 0) {
    return { contextText: "", sources: [], matched: 0, degraded: candidates.degraded };
  }
  const refined = refine(fused, 12);
  if (refined.length === 0) {
    return { contextText: "", sources: [], matched: 0, degraded: candidates.degraded };
  }
  const top = await llmRerank(query, refined, 8);

  const contextText = top
    .map((r) => `[${labelOf(r.meta)}]\n${r.text}`)
    .join("\n\n---\n\n");

  // 출처는 문서/페이지 단위 중복 제거, 최대 3개. 자료실 문서가 있으면 원문 링크를 연결한다.
  const seen = new Set<string>();
  const sources: DocSource[] = [];
  for (const r of top) {
    const documentId = documentIdOf(r.meta);
    const page = pageOf(r.meta);
    const key = `${documentId || r.meta?.source || "자료"}::${page ?? "-"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      document_id: documentId,
      doc: documentLabelOf(r.meta),
      page,
      content: r.text.slice(0, 400),
    });
    if (sources.length >= 3) break;
  }

  return { contextText, sources, matched: top.length, degraded: candidates.degraded };
}

// 자료제작용 청크 수 — 문서/슬라이드는 챗봇 답변보다 넓은 커버리지가 필요(챗봇 8 vs 생성 24).
const GEN_KEEP = 24;

// 분야 자료를 모아 생성(AI 자료제작) 컨텍스트를 만든다.
// topic 이 있으면 챗봇과 동일한 하이브리드 검색으로 "주제 관련" 청크를 우선 모으고,
// 없거나(분야 전반) 검색 결과가 비면 분야 전체 청크로 폴백한다.
export async function fetchExternalRagContext(
  category: string,
  limit = 40,
  topic?: string
): Promise<{ contextText: string; sources: GeneratedDocSource[] }> {
  const supabase = await createClient();
  const topicTrimmed = topic?.trim();

  // ① 주제 기반: "분야 + 주제"를 임베딩해 하이브리드 검색 → 정제 → 컨텍스트 조립
  if (topicTrimmed) {
    try {
      await assertExternalEmbeddingContract();
      const embedding = await getQueryEmbedding(`${category} ${topicTrimmed}`);
      const kwQuery = buildKeywordQuery(topicTrimmed);
      const candidates = await hybridCandidates(
        supabase,
        embedding,
        kwQuery,
        category,
        Math.max(60, GEN_KEEP * 2)
      );
      const refined = refine(candidates.rows, GEN_KEEP);
      if (refined.length > 0) return buildContextFromRefined(refined, 5);
      // 주제 검색 결과가 없으면 분야 전체로 폴백
    } catch (e) {
      console.error("[rag-external] 주제 기반 검색 실패, 분야 전체로 폴백:", e);
    }
  }

  // ② 분야 전체(폴백/주제 미지정): 노이즈 제외 후에도 limit 만큼 남도록 후보를 2배로 받는다.
  const { data, error } = await (supabase.from as CallableFunction)(RAG_TABLE)
    .select("content, metadata")
    .eq("is_active", true)
    .eq(`metadata->>${CATEGORY_FIELD}`, category)
    .limit(limit * 2);

  if (error) {
    console.error("[rag-external] fetch context error:", error.message);
    return { contextText: "", sources: [] };
  }
  const rows = (data ?? []) as RagRow[];
  // 정제·노이즈제외 (생성 컨텍스트도 깨끗한 본문만). limit 만큼 의미 청크 확보.
  const refined = refine(rows, limit);
  if (refined.length === 0) return { contextText: "", sources: [] };
  return buildContextFromRefined(refined, 5);
}

// 분야 → 원본 파일명 목록 (AI 자료제작 선택지·NotebookLM 자료 목록용)
// Supabase REST는 요청당 최대 1000행이라, 전체 분야를 빠짐없이 모으려면 페이지네이션 필요.
export async function listExternalRagCategories(): Promise<Record<string, string[]>> {
  const supabase = await createClient();
  const PAGE = 1000;
  const byCat = new Map<string, Set<string>>();

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await (supabase.from as CallableFunction)(RAG_TABLE)
      .select(`category:metadata->>${CATEGORY_FIELD}, source:metadata->>source`)
      .eq("is_active", true)
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("[rag-external] list categories error:", error.message);
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

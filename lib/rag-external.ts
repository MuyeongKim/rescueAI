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
import {
  splitGeneratedSourcesForDisplay,
  type GeneratedDocSource,
} from "@/lib/generate";
import type { SopEvidence } from "@/lib/sop-evidence";
import { withSupabaseRequestTimeout } from "@/lib/supabase/request-timeout";

// 테이블·검색함수 이름은 RAG_TABLE 단일 출처에서 파생(이름 변경 시 env+SQL만 고치면 됨).
// 검색 RPC 규칙: match_<테이블명> (예: rag_rescue → match_rag_rescue).
const RAG_TABLE = process.env.RAG_TABLE || "rag_rescue";
const MATCH_FN = `match_${RAG_TABLE}`;
const RAG_AUXILIARY_MODEL_MAX_MS = 45_000;
const RAG_DB_REQUEST_MAX_MS = 45_000;
const SOP_DOCUMENT_TYPES = ["sop", "operational_guidance"] as const;
export const COMMON_SOP_CATEGORY = "현장지휘·공통";

/** 요청 분야의 절차 자료에 전 분야 공통 SOP를 보조 범위로 더한다. */
export function sopCategoryScope(category: string): string[] {
  const requested = category.trim().slice(0, 100);
  if (!requested) return [];
  return requested === COMMON_SOP_CATEGORY
    ? [COMMON_SOP_CATEGORY]
    : [requested, COMMON_SOP_CATEGORY];
}

// Route/Server Component에서는 쿠키 기반 클라이언트를 기본 사용한다. 요청 컨텍스트가 없는
// 평가 러너는 service-role 클라이언트를 명시적으로 주입할 수 있으며, 자동 승격은 하지 않는다.
export type ExternalRagSupabaseClient = Awaited<ReturnType<typeof createClient>>;

const withRagDbTimeout = <T,>(request: T): T =>
  withSupabaseRequestTimeout(request, RAG_DB_REQUEST_MAX_MS);

export function ragTableEnabled(): boolean {
  return !!process.env.RAG_TABLE;
}

let contractCache: { key: string; validUntil: number } | null = null;

export async function assertExternalEmbeddingContract(
  suppliedClient?: ExternalRagSupabaseClient
): Promise<void> {
  const expected = getConfiguredEmbeddingContract();
  const cacheKey = [
    RAG_TABLE,
    expected.provider,
    expected.model,
    expected.dimensions,
    expected.version,
  ].join(":");
  if (contractCache?.key === cacheKey && contractCache.validUntil > Date.now()) return;

  const supabase = suppliedClient ?? (await createClient());
  const { data, error } = await withRagDbTimeout(
    (supabase.from as CallableFunction)("rag_embedding_config")
      .select("provider, model, dimensions, version")
      .eq("table_name", RAG_TABLE)
      .limit(1)
  );
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
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function documentIdOf(meta: RagRow["metadata"]): number {
  return numberMetadata(meta?.document_id) ?? 0;
}

function pageOf(meta: RagRow["metadata"]): number | null {
  return numberMetadata(meta?.page_num);
}

function documentLabelOf(meta: RagRow["metadata"]): string {
  const src = normalizeSourceLabel(
    (meta?.source ?? "자료").replace(/\.(pdf|hwpx?|pptx?|docx?)$/i, "")
  );
  const header = meta?.["Header 2"]
    ? normalizeSourceLabel(meta["Header 2"])
    : undefined;
  return header && header !== src ? `${src} — ${header}` : src;
}

function labelOf(meta: RagRow["metadata"]): string {
  const label = documentLabelOf(meta);
  const page = pageOf(meta);
  return page == null ? label : `${label} p.${page}`;
}

export type VerifiedExternalRagSources = {
  sources: GeneratedDocSource[];
  degraded: boolean;
};

const PROVENANCE_PAIR_BATCH_SIZE = 20;
const PROVENANCE_ROWS_PER_PAIR_LIMIT = 16;

function externalProvenancePairFilter(
  sources: readonly Pick<GeneratedDocSource, "document_id" | "page">[]
): string {
  return sources
    .map((source) =>
      source.page === null
        ? `and(metadata->>document_id.eq.${source.document_id},metadata->>page_num.is.null)`
        : `and(metadata->>document_id.eq.${source.document_id},metadata->>page_num.eq.${source.page})`
    )
    .join(",");
}

function provenancePairBatches(
  sources: readonly GeneratedDocSource[]
): GeneratedDocSource[][] {
  const pairs = new Map<string, GeneratedDocSource>();
  for (const source of sources) {
    const key = `${source.document_id}:${source.page ?? "null"}`;
    if (!pairs.has(key)) pairs.set(key, source);
  }
  const uniquePairs = Array.from(pairs.values());
  const batches: GeneratedDocSource[][] = [];
  for (let index = 0; index < uniquePairs.length; index += PROVENANCE_PAIR_BATCH_SIZE) {
    batches.push(uniquePairs.slice(index, index + PROVENANCE_PAIR_BATCH_SIZE));
  }
  return batches;
}

/**
 * 저장 생성물의 문서 ID·페이지·표시 라벨을 현재 활성 RAG 메타데이터에 다시 대조한다.
 * 클라이언트가 content.sources를 바꿔도 요청 분야의 실제 RAG 행과 정확히 일치하지 않으면
 * 신뢰 출처로 돌려주지 않는다. 단, 현장지휘·공통 자료는 SOP·현장지침 유형만 허용한다.
 * page=null은 실제 메타데이터도 NULL인 경우에만 인정한다.
 */
export async function verifyExternalRagSourceProvenance(
  candidates: readonly GeneratedDocSource[],
  expectedCategory: string,
  suppliedClient?: ExternalRagSupabaseClient
): Promise<VerifiedExternalRagSources> {
  const category = expectedCategory.trim().slice(0, 100);
  if (!category) return { sources: [], degraded: false };
  const unique = new Map<string, GeneratedDocSource>();
  for (const candidate of candidates) {
    if (
      !Number.isSafeInteger(candidate.document_id) ||
      candidate.document_id <= 0 ||
      (candidate.page !== null &&
        (!Number.isSafeInteger(candidate.page) || (candidate.page ?? 0) <= 0)) ||
      !candidate.doc.trim()
    ) {
      continue;
    }
    const safe = {
      document_id: candidate.document_id,
      doc: candidate.doc.trim().slice(0, 300),
      page: candidate.page,
    } satisfies GeneratedDocSource;
    unique.set(JSON.stringify([safe.document_id, safe.page, safe.doc]), safe);
    if (unique.size >= 80) break;
  }
  const requested = Array.from(unique.values());
  if (requested.length === 0) return { sources: [], degraded: false };

  try {
    const supabase = suppliedClient ?? (await createClient());
    const scopes = [
      { category, sopOnly: false },
      ...(category === COMMON_SOP_CATEGORY
        ? []
        : [{ category: COMMON_SOP_CATEGORY, sopOnly: true }]),
    ];
    const query = (
      scope: (typeof scopes)[number],
      batch: readonly GeneratedDocSource[]
    ) => {
      let request = (supabase.from as CallableFunction)(RAG_TABLE)
        .select("id, metadata")
        .eq("is_active", true)
        .eq(`metadata->>${CATEGORY_FIELD}`, scope.category)
        // document_id와 page_num을 독립 IN으로 조회하면 요청하지 않은 조합까지 섞인다.
        // 정확한 쌍만 OR로 묶고 URL 길이를 제한하기 위해 20개씩 나눈다.
        .or(externalProvenancePairFilter(batch));
      if (scope.sopOnly) {
        request = request.in("metadata->>document_type", [...SOP_DOCUMENT_TYPES]);
      }
      return withRagDbTimeout(
        request.limit(
          Math.min(
            1000,
            Math.max(64, batch.length * PROVENANCE_ROWS_PER_PAIR_LIMIT)
          )
        )
      );
    };
    const requests: Array<
      PromiseLike<{
        data: unknown;
        error: { message?: string } | null;
      }>
    > = [];
    const batches = provenancePairBatches(requested);
    const requestLimits: number[] = [];
    for (const scope of scopes) {
      for (const batch of batches) {
        requestLimits.push(
          Math.min(
            1000,
            Math.max(64, batch.length * PROVENANCE_ROWS_PER_PAIR_LIMIT)
          )
        );
        requests.push(query(scope, batch));
      }
    }
    const results = await Promise.all(requests);
    const queryError = results.find((result) => result.error)?.error;
    if (queryError) {
      console.error("[rag-external] 저장 출처 검증 실패:", queryError.message);
      return { sources: [], degraded: true };
    }
    // 응답 상한에 닿으면 일부 요청 페이지가 잘렸을 수 있으므로 안전하게 재시도를 요구한다.
    if (results.some((result, index) =>
      Array.isArray(result.data) && result.data.length >= requestLimits[index]
    )) {
      return { sources: [], degraded: true };
    }
    const rows = results.flatMap(
      (result) => (result.data ?? []) as Array<Pick<RagRow, "id" | "metadata">>
    );

    const actual = new Set(
      rows.map((row) => {
        const documentId = documentIdOf(row.metadata);
        const page = pageOf(row.metadata);
        return JSON.stringify([documentId, page, documentLabelOf(row.metadata)]);
      })
    );
    return {
      sources: requested.filter((source) =>
        actual.has(JSON.stringify([source.document_id, source.page, source.doc]))
      ),
      degraded: false,
    };
  } catch (error) {
    console.error(
      "[rag-external] 저장 출처 검증 요청 실패:",
      error instanceof Error ? error.message : error
    );
    return { sources: [], degraded: true };
  }
}

// 청크 본문 정제: docling 이미지 마커·목차 점선·과잉 공백 제거 (LLM 입력 노이즈 감소)
function cleanContent(c: string, contextHint = ""): string {
  return normalizeKnownOcrErrors(c, contextHint)
    .replace(/<!--\s*image\s*-->/gi, "")
    .replace(/[·∙․.]{4,}/g, " ") // 목차 leader 점선
    .replace(/\s+/g, " ")
    .trim();
}

// 현재 구조 교육자료 OCR에서 반복 확인된 오인식을 검색 컨텍스트에 넣기 전에 바로잡는다.
// 원문 파일·DB를 바꾸지 않고 LLM이 절차명과 역할을 잘못 해석하는 것만 막는다.
export function normalizeKnownOcrErrors(text: string, contextHint = ""): string {
  let normalized = text
    .replace(/헬넷/g, "헬멧")
    .replace(
      /지위관(?=(?:에게|은|는|이|가|을|를|의|으로|에서)?(?:\s|[,.]|$))/g,
      "지휘관"
    )
    .replace(/재세적/g, "재세척")
    .replace(/제독렌트/g, "제독텐트")
    .replace(/((?:오염도|시간|압력|농도)\s*)축정/g, "$1측정")
    .replace(/축정(?=\s*(?:장비|기|값|결과))/g, "측정")
    .replace(/인체사위/g, "인체샤워")
    .replace(/사위실/g, "샤워실");

  // '달의', '2인 7조'는 정상 문장에도 존재할 수 있으므로 보호복 문맥과
  // 실제 OCR에서 확인된 주변 표현이 함께 있을 때만 교정한다.
  const protectiveSuitContext = /(?:화학\s*)?보호(?:복|의)|착탈의|제독/.test(
    `${normalized} ${contextHint}`
  );
  if (!protectiveSuitContext) return normalized;

  normalized = normalized
    .replace(
      /2인\s*7조(?=[^.\n]{0,100}(?:화학\s*)?보호(?:복|의)[^.\n]{0,40}달의)/g,
      "2인 1조"
    )
    .replace(
      /\(\s*2인\s*7조\s*\)(?=[^.\n]{0,100}(?:상의|하의)\s*[>→])/g,
      "(2인 1조)"
    )
    .replace(/2인\s*7조(?=\s*(?:상의|하의)\s*[>→])/g, "2인 1조")
    .replace(/((?:화학\s*)?보호(?:복|의)\s*)달의/g, "$1탈의")
    .replace(/(순으로\s*)달의/g, "$1탈의")
    .replace(/(^|[\s(])달의(?=\s*(?:순서|절차|단계|후|전|시|\)))/g, "$1탈의");
  return normalized;
}

// 출처 라벨은 바깥쪽 [ ] 한 쌍만 사용한다. OCR 메타데이터의 HTML 엔티티와
// 내부 대괄호를 정규화해 모델이 복사한 라벨과 품질 검사 허용 목록이 어긋나지 않게 한다.
function normalizeSourceLabel(text: string): string {
  return normalizeKnownOcrErrors(text, text)
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
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
type RefinedRagRow = { id: string; meta: RagRow["metadata"]; text: string };

function refine(rows: RagRow[], keep: number): RefinedRagRow[] {
  const out: RefinedRagRow[] = [];
  for (const r of rows) {
    const text = cleanContent(r.content, r.metadata?.["Header 2"] ?? "");
    if (isNoise(text, r.metadata?.["Header 2"])) continue;
    out.push({ id: r.id, meta: r.metadata, text });
    if (out.length >= keep) break;
  }
  return out;
}

// 관련도 순서(각 문서에서 처음 등장한 순서)는 유지하면서 문서별로 한 청크씩 번갈아 고른다.
// 단일 문서뿐인 분야는 원래 순서대로 limit까지 채워져 자료량이 줄지 않는다.
export function selectSourceDiverse<T>(
  items: readonly T[],
  limit: number,
  sourceKeyOf: (item: T) => string
): T[] {
  const take = Math.max(0, Math.floor(limit));
  if (take === 0 || items.length === 0) return [];

  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = sourceKeyOf(item);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }

  const selected: T[] = [];
  let position = 0;
  while (selected.length < take) {
    let added = false;
    for (const bucket of Array.from(buckets.values())) {
      const item = bucket[position];
      if (item === undefined) continue;
      selected.push(item);
      added = true;
      if (selected.length >= take) break;
    }
    if (!added) break;
    position += 1;
  }
  return selected;
}

// 여러 하위질의 결과에서 한 건씩 번갈아 뽑는다. 한 하위주제의 결과가 많아도
// 다른 하위주제(예: 점검·탈의·제독)의 첫 근거가 밀리지 않으며 id 중복은 제거한다.
export function interleaveUnique<T>(
  lists: readonly (readonly T[])[],
  limit: number,
  keyOf: (item: T) => string
): T[] {
  const take = Math.max(0, Math.floor(limit));
  if (take === 0) return [];

  const selected: T[] = [];
  const seen = new Set<string>();
  const cursors = lists.map(() => 0);
  while (selected.length < take) {
    let added = false;
    for (let listIndex = 0; listIndex < lists.length; listIndex += 1) {
      const list = lists[listIndex];
      while (cursors[listIndex] < list.length) {
        const item = list[cursors[listIndex]];
        cursors[listIndex] += 1;
        const key = keyOf(item);
        if (seen.has(key)) continue;
        seen.add(key);
        selected.push(item);
        added = true;
        break;
      }
      if (selected.length >= take) break;
    }
    if (!added) break;
  }
  return selected;
}

function documentSourceKey(meta: RagRow["metadata"]): string {
  const documentId = documentIdOf(meta);
  if (documentId > 0) return `document:${documentId}`;
  const source = meta?.source?.trim();
  return `source:${source || "자료"}`;
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

export type TopicSearchPlan = {
  id: string;
  mode: "recall" | "precise";
  queries: string[];
  terms: string[];
  subject: string;
  facetTerms: string[];
  protect: boolean;
  allowFacetOnly: boolean;
  scopeTerms: string[];
};

type FacetDefinition = {
  id: string;
  triggers: RegExp;
  queryTerms: string[][];
  recallTerms: string[];
  queryWithoutSubject?: boolean;
  allowFacetOnly?: boolean;
  scopeTerms?: string[];
};

const FACET_DISPLAY_LABELS: Record<string, string> = {
  "qualification-items": "평가 종목",
  "qualification-process": "평가 진행",
  "qualification-equipment": "준비물·장비",
  "qualification-scoring": "감점·실격",
  "chemical-identification": "물질 확인",
  "chemical-ppe": "보호장비",
  "chemical-zoning": "위험구역·통제",
  "chemical-control": "누출원 차단",
  "chemical-decontamination": "제독·오염통제",
  "training-roles": "팀 편성·역할",
  "training-equipment": "훈련 장비",
  "training-procedure": "훈련 행동절차",
  "training-safety": "안전통제",
  "training-evaluation": "훈련 평가",
  "procedure-steps": "단계별 행동절차",
  "procedure-safety": "안전·중단 기준",
  precheck: "사전점검",
  donning: "착용",
  doffing: "탈의",
  decontamination: "제독",
  "leak-control": "누출 대응",
  emergency: "이상 시 조치",
};

type HybridCandidateResult = {
  rows: RagRow[];
  degraded: boolean;
  protectedIds: string[];
  protectedFacets: Record<string, string[]>;
};

// 전체 OR 질의까지 포함한 실제 Supabase textSearch 호출 수 상한.
// 5~6명 동시 시범운영에서도 한 질문이 과도한 병렬 요청을 만들지 않게 고정한다.
export const MAX_KEYWORD_SEARCH_QUERIES = 12;

// 절차형 질문의 공통 단계. 화학보호복뿐 아니라 공기호흡기·로프·펌프·잠수장비에도
// 같은 분해 규칙을 적용하고, OCR 별칭은 실제 적재 자료에서 확인된 최소 범위만 둔다.
const PROCEDURE_FACETS: readonly FacetDefinition[] = [
  // 자격·실기평가를 포괄적으로 물어도 개요 한 쪽만 답하지 않도록, 실제 사용자가
  // 확인하는 평가 종목·진행·준비물·감점/실격을 독립 근거 슬롯으로 회수한다.
  {
    id: "qualification-items",
    triggers: /인명구조사|자격(?:시험|평가)?|실기평가|평가표/,
    queryTerms: [["평가", "항목"], ["평가", "종목"]],
    recallTerms: ["평가항목", "평가종목", "종목"],
  },
  {
    id: "qualification-process",
    triggers: /인명구조사|자격(?:시험|평가)?|실기평가|평가표/,
    queryTerms: [["평가", "방법"]],
    recallTerms: ["평가방법", "진행방법", "진행"],
  },
  {
    id: "qualification-equipment",
    triggers: /인명구조사|자격(?:시험|평가)?|실기평가|평가표/,
    queryTerms: [["준비물"]],
    recallTerms: ["준비물", "장비", "복장"],
  },
  {
    id: "qualification-scoring",
    triggers: /인명구조사|자격(?:시험|평가)?|실기평가|평가표/,
    queryTerms: [["감점"], ["실격"]],
    recallTerms: ["감점", "실격", "배점", "합격"],
  },
  // 화학물질 누출 질문은 '차단' 한 페이지만 찾지 않고 물질확인→보호→구역통제→
  // 차단→제독의 현장 흐름을 각각 검색한다. 특정 물질명이 있을 때만 켜 과확장을 막는다.
  {
    id: "chemical-identification",
    triggers: /암모니아|염소|황화수소|화학물질|유해물질/,
    queryTerms: [["물질", "특성"]],
    recallTerms: ["물질확인", "물질식별", "물질특성", "측정"],
  },
  {
    id: "chemical-ppe",
    triggers: /암모니아|염소|황화수소|화학물질|유해물질/,
    queryTerms: [["보호장비"]],
    recallTerms: ["개인보호장비", "보호복", "공기호흡기", "보호장비"],
    queryWithoutSubject: true,
    allowFacetOnly: true,
    scopeTerms: ["화학", "유해물질", "오염", "누출"],
  },
  {
    id: "chemical-zoning",
    triggers: /암모니아|염소|황화수소|화학물질|유해물질/,
    queryTerms: [["통제구역"], ["위험구역"]],
    recallTerms: ["통제구역", "위험구역", "Hot zone", "Warm zone", "Cold zone"],
    // 통제구역은 특정 물질 페이지가 아니라 화학사고 공통 절차에 설명되는 경우가 많다.
    queryWithoutSubject: true,
    allowFacetOnly: true,
    scopeTerms: ["화학", "유해물질", "오염", "누출"],
  },
  {
    id: "chemical-control",
    triggers: /암모니아|염소|황화수소|화학물질|유해물질/,
    queryTerms: [["누출", "차단"], ["중화"]],
    recallTerms: ["누출원", "차단", "봉쇄", "밸브", "중화"],
  },
  {
    id: "chemical-decontamination",
    triggers: /암모니아|염소|황화수소|화학물질|유해물질/,
    queryTerms: [["제독"]],
    recallTerms: ["제독", "오염통제", "오염도", "2차오염"],
  },
  // 넓은 훈련 주제도 역할·장비·행동·안전·평가를 각각 확보해, 자료 한두 페이지를
  // 요약하는 수준이 아니라 실제 훈련안을 설명할 수 있는 근거 묶음으로 만든다.
  {
    id: "training-roles",
    triggers: /훈련|교육|숙달|교안/,
    queryTerms: [["역할"]],
    recallTerms: ["역할", "임무", "지휘", "팀"],
  },
  {
    id: "training-equipment",
    triggers: /훈련|교육|숙달|교안/,
    queryTerms: [["장비"]],
    recallTerms: ["준비물", "장비", "점검"],
  },
  {
    id: "training-procedure",
    triggers: /훈련|교육|숙달|교안/,
    queryTerms: [["절차"]],
    recallTerms: ["행동절차", "절차", "단계"],
  },
  {
    id: "training-safety",
    triggers: /훈련|교육|숙달|교안/,
    queryTerms: [["안전"]],
    recallTerms: ["안전", "위험", "중단", "통제"],
  },
  {
    id: "training-evaluation",
    triggers: /훈련|교육|숙달|교안/,
    queryTerms: [["평가"]],
    recallTerms: ["평가", "숙달", "확인", "종료"],
  },
  {
    id: "selection",
    triggers: /등급|레벨|선정|선택|적용범위/,
    queryTerms: [["등급"]],
    recallTerms: ["등급", "레벨", "선정", "선택"],
  },
  {
    id: "precheck",
    triggers: /점검|검사|확인|사전|준비|착용\s*전/,
    queryTerms: [["점검"]],
    recallTerms: ["점검", "검사", "확인"],
  },
  {
    id: "donning",
    triggers: /착탈의|착의|착용/,
    queryTerms: [["착용"]],
    recallTerms: ["착용", "착의"],
  },
  {
    id: "doffing",
    triggers: /착탈의|탈의|벗기|벗는/,
    // '달의'는 현재 화학사고 실무가이드 OCR에서 반복 확인된 '탈의' 오인식이다.
    queryTerms: [["탈의"], ["달의"]],
    recallTerms: ["탈의", "달의"],
  },
  {
    id: "decontamination",
    triggers: /오염\s*통제|제독|오염도|2차\s*오염/,
    queryTerms: [["제독"], ["오염도"]],
    recallTerms: ["오염통제", "제독", "오염도", "2차오염"],
  },
  {
    id: "leak-control",
    // '차단'만으로 켜면 차량 전원 차단·화재 확산 방지까지 화학 누출로 오인하므로
    // 누출 계열 표현이 실제 질의나 확장어에 있을 때만 하위 절차를 펼친다.
    triggers: /누출|누설|유출/,
    queryTerms: [["누출"], ["누설"], ["유출"], ["차단"], ["중화"]],
    recallTerms: ["누출", "누설", "유출", "누출원", "차단", "봉쇄", "확산", "중화"],
  },
  {
    id: "emergency",
    triggers: /중단|철수|비상|이상|파손|누설|고갈|보고/,
    queryTerms: [["이상", "보고"], ["파손"]],
    recallTerms: ["중단", "철수", "비상", "이상", "파손", "누설", "보고"],
  },
  // 도메인별 세부 계획을 먼저 채운 뒤 남는 검색 예산에서 일반 절차·안전 근거를 보완한다.
  {
    id: "procedure-steps",
    triggers: /방법|절차|순서|어떻게|착용|탈의|운용|사용/,
    queryTerms: [["절차"]],
    recallTerms: ["준비", "절차", "순서", "완료"],
  },
  {
    id: "procedure-safety",
    triggers: /방법|절차|순서|어떻게|착용|탈의|운용|사용/,
    queryTerms: [["안전"]],
    recallTerms: ["안전", "주의", "이상", "중단", "보고"],
  },
] as const;

const SUBJECT_STOP_WORDS = new Set([
  "관련",
  "관한",
  "대해",
  "대한",
  "내용",
  "사항",
  "상세",
  "세부",
  "설명",
  "알려줘",
  "정보",
  "시",
  "전",
  "후",
]);
const GENERIC_SUBJECTS = new Set([
  "개요",
  "관련",
  "교육",
  "구조",
  "매뉴얼",
  "방법",
  "분야",
  "사고",
  "안전",
  "운용",
  "자료",
  "작업",
  "장비",
  "절차",
  "점검",
  "준비물",
  "평가",
  "표준작전절차",
  "현장",
  "훈련",
]);
const SOP_TOPIC_STOP_WORDS = new Set([
  ...Array.from(GENERIC_SUBJECTS),
  "대비",
  "대응",
  "관련",
  "상위",
  "주제",
  "산악",
  "수난",
  "화재",
  "구급",
  "산악사고",
  "수난사고",
  "화재사고",
  "구조활동",
  "현장활동",
]);

function normalizeSearchText(text: string): string {
  return text
    .slice(0, 100)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[·,;\/|()[\]{}:!?~…—-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripKoreanParticle(token: string): string {
  return token.replace(/(?:으로|에서|에게|부터|까지|과|와|을|를|은|는|이|가|의)$/, "");
}

function inferTopicSubject(topic: string): string {
  const normalized = normalizeSearchText(topic);
  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length === 0) return "";

  const actionIndex = tokens.findIndex((token) =>
    PROCEDURE_FACETS.some((facet) => facet.triggers.test(token))
  );
  const subjectCandidates = (actionIndex > 0 ? tokens.slice(0, actionIndex) : tokens)
    .map(stripKoreanParticle);
  const subjectIndex = subjectCandidates.findIndex(
    (token) => token.length >= 2 && !SUBJECT_STOP_WORDS.has(token)
  );
  const subjectToken = subjectCandidates[subjectIndex];
  // 수식어·행동 표현까지 subject에 붙이면 실제 청크에 없는 과구체 문구가 되어 전부 D로
  // 탈락한다. 다만 자격의 1급·2급은 문서와 평가표를 가르는 핵심 식별자이므로 바로 뒤의
  // 등급만 보존한다(예: "인명구조사 2급").
  if (!subjectToken) return "";
  const grade = subjectCandidates
    .slice(subjectIndex + 1, subjectIndex + 3)
    .find((token) => /^(?:전문|특급|[1-9]급)$/.test(token));
  return grade ? `${subjectToken} ${grade}` : subjectToken;
}

function facetSearchSubject(subject: string): string {
  const normalized = normalizeSearchText(subject);
  if (!normalized.includes(" ") && normalized.endsWith("사고")) {
    const root = normalized.slice(0, -2);
    if (root.length >= 2) return root;
  }
  return normalized;
}

function compactSearchText(text: string, contextHint = ""): string {
  return normalizeKnownOcrErrors(text, contextHint)
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]+/g, "");
}

function isSpecificTopicSubject(subject: string): boolean {
  const normalized = normalizeSearchText(subject).toLowerCase();
  const compact = compactSearchText(normalized);
  return (
    compact.length >= 4 &&
    !GENERIC_SUBJECTS.has(normalized) &&
    !GENERIC_SUBJECTS.has(compact)
  );
}

function textMatchesSubject(text: string, subject: string, contextHint = ""): boolean {
  const target = compactSearchText(text, contextHint);
  const normalizedSubject = normalizeSearchText(subject).toLowerCase();
  const compactSubject = compactSearchText(normalizedSubject);
  if (!target || !compactSubject) return false;
  if (target.includes(compactSubject)) return true;

  const subjectTokens = normalizedSubject
    .split(" ")
    .map(stripKoreanParticle)
    .map((token) => compactSearchText(token))
    .filter((token) => token.length >= 2 && !GENERIC_SUBJECTS.has(token));
  if (
    subjectTokens.length > 1 &&
    subjectTokens.every((token) => target.includes(token))
  ) {
    return true;
  }

  // 소방 분야 문서 본문은 합성어의 기관 수식어를 생략하는 경우가 많다
  // (예: 소방드론 → 드론). 짧은 어근이 일반어가 아닐 때만 제한적으로 허용한다.
  const domainRoot =
    subjectTokens.length === 1 && subjectTokens[0].startsWith("소방")
      ? subjectTokens[0].slice(2)
      : "";
  if (
    domainRoot.length >= 2 &&
    !GENERIC_SUBJECTS.has(domainRoot) &&
    target.includes(domainRoot)
  ) {
    return true;
  }

  // 산악사고·화학사고처럼 문서 제목에서는 '사고'가 생략되고 분야명만 쓰이는 경우를
  // 허용한다. 두 글자 이상의 단일 분야 어근에만 적용해 일반 '사고' 과매칭을 막는다.
  const incidentRoot =
    subjectTokens.length === 1 && subjectTokens[0].endsWith("사고")
      ? subjectTokens[0].slice(0, -2)
      : "";
  if (
    incidentRoot.length >= 2 &&
    !GENERIC_SUBJECTS.has(incidentRoot) &&
    target.includes(incidentRoot)
  ) {
    return true;
  }

  // OCR 청크 경계에서 복합 장비명의 앞부분이 잘린 경우에도 핵심 명칭을 살린다.
  // 5자 이상의 단일 복합어만 뒤 3자를 사용해 짧은 일반어 과매칭을 피한다.
  return subjectTokens.length === 1 &&
    subjectTokens[0].length >= 5 &&
    target.includes(subjectTokens[0].slice(-3));
}

function textMatchesFacet(text: string, facetTerms: readonly string[], contextHint = ""): boolean {
  if (facetTerms.length === 0) return false;
  const target = compactSearchText(text, contextHint);
  return facetTerms.some((term) => {
    const compactTerm = compactSearchText(term);
    return compactTerm.length >= 2 && target.includes(compactTerm);
  });
}

export type TopicSubjectAffinity = "legacy" | "A" | "B" | "C" | "D";

// A: 제목에 주제 + 현재 절차 근거, B: 제목에 현재 절차 + 본문에 주제,
// C: 본문에만 주제와 현재 절차, D: 주제 근거가 약함.
// 짧거나 일반적인 주제는 오판을 피하기 위해 기존 순위를 그대로 사용한다.
export function classifyTopicSubjectAffinity(
  subject: string,
  facetTerms: readonly string[],
  header: string,
  content: string,
  source = ""
): TopicSubjectAffinity {
  if (!isSpecificTopicSubject(subject)) return "legacy";

  // 파일명이 질문 주제와 정확히 맞는 문서는 Page 3 같은 일반 헤더여도 주제 문서로 인정한다.
  // 단, 절차 facet 자체는 해당 페이지 본문이나 헤더에 있어야 A가 되므로 파일명만으로
  // 관련 없는 페이지가 보호되는 일은 없다.
  const headerHasSubject = textMatchesSubject(`${source} ${header}`, subject, content);
  const bodyHasSubject = textMatchesSubject(content, subject, header);
  const headerHasFacet = textMatchesFacet(header, facetTerms, content);
  const bodyHasFacet = textMatchesFacet(content, facetTerms, header);
  if (headerHasSubject && (facetTerms.length === 0 || headerHasFacet || bodyHasFacet)) {
    return "A";
  }
  if (!bodyHasSubject) return "D";
  if (headerHasFacet) return "B";
  if (facetTerms.length === 0 || bodyHasFacet) return "C";
  return "D";
}

function classifyRowForSearchPlan(
  plan: TopicSearchPlan,
  row: RagRow
): TopicSubjectAffinity {
  const affinity = classifyTopicSubjectAffinity(
    plan.subject,
    plan.facetTerms,
    row.metadata?.["Header 2"] ?? "",
    row.content,
    row.metadata?.source ?? ""
  );
  if (affinity !== "D" || !plan.allowFacetOnly) return affinity;

  const pageText = `${row.metadata?.["Header 2"] ?? ""} ${row.content}`;
  const scopeText = `${row.metadata?.source ?? ""} ${pageText}`;
  return textMatchesFacet(pageText, plan.facetTerms) &&
    textMatchesFacet(scopeText, plan.scopeTerms)
    ? "B"
    : "D";
}

function preciseKeywordQuery(terms: string[]): string {
  return Array.from(
    new Set(
      terms
        .flatMap((term) => normalizeSearchText(term).split(" "))
        .map((term) => term.trim().replace(/누출시$/, "누출"))
        .filter((term) => term.length >= 2 && !SUBJECT_STOP_WORDS.has(term))
    )
  )
    .slice(0, 5)
    .join(" ");
}

// 전체 OR 검색(재현율)과 질문에 실제로 나타난 하위주제별 AND 검색(정밀도)을 함께 만든다.
// 계획 개수가 아니라 실제 query 문자열 수를 제한해 DB 부하를 고정한다.
export function buildTopicSearchPlans(
  topic: string,
  extraKeywords: string[] = []
): TopicSearchPlan[] {
  const normalized = normalizeSearchText(topic);
  if (!normalized) return [];

  const safeExtraKeywords = extraKeywords
    .slice(0, 8)
    .map(normalizeSearchText)
    .filter(Boolean);
  const subject = inferTopicSubject(normalized);
  const detectionText = `${normalized} ${safeExtraKeywords.join(" ")}`.trim();
  const broadAliases = PROCEDURE_FACETS.filter((facet) => facet.triggers.test(detectionText))
    .flatMap((facet) => facet.recallTerms);
  const broadTerms = Array.from(
    new Set([normalized, ...safeExtraKeywords, ...broadAliases])
  );
  const broad = buildKeywordQuery(normalized, [...safeExtraKeywords, ...broadAliases]);
  const plans: TopicSearchPlan[] = broad
    ? [
        {
          id: "recall",
          mode: "recall",
          queries: [broad],
          terms: broadTerms,
          subject,
          facetTerms: [],
          protect: false,
          allowFacetOnly: false,
          scopeTerms: [],
        },
      ]
    : [];
  let queryCount = plans.reduce((sum, plan) => sum + plan.queries.length, 0);

  for (const facet of PROCEDURE_FACETS) {
    if (queryCount >= MAX_KEYWORD_SEARCH_QUERIES) break;
    const explicitFacet = facet.triggers.test(normalized);
    if (!explicitFacet && !facet.triggers.test(detectionText)) continue;
    const queries = Array.from(
      new Set(
        facet.queryTerms
          .map((terms) =>
            preciseKeywordQuery([
              ...(facet.queryWithoutSubject ? [] : [facetSearchSubject(subject)]),
              ...terms,
            ])
          )
          .filter(Boolean)
      )
    ).slice(0, MAX_KEYWORD_SEARCH_QUERIES - queryCount);
    if (queries.length === 0) continue;
    plans.push({
      id: facet.id,
      mode: "precise",
      queries,
      terms: Array.from(new Set([subject, ...facet.recallTerms])).filter(Boolean),
      subject,
      facetTerms: [...facet.recallTerms],
      // LLM 확장어로만 생긴 보조 facet은 회수에는 쓰되 최종 슬롯을 강제로 잠그지 않는다.
      protect: explicitFacet,
      allowFacetOnly: facet.allowFacetOnly ?? false,
      scopeTerms: facet.scopeTerms ?? [],
    });
    queryCount += queries.length;
  }

  // 절차 단서가 없는 짧은 주제도 OR 검색 한 번으로 끝나지 않게 원문 AND 검색을 보탠다.
  if (plans.length === 1) {
    const precise = preciseKeywordQuery([normalized]);
    if (
      precise &&
      precise !== broad &&
      queryCount < MAX_KEYWORD_SEARCH_QUERIES
    ) {
      plans.push({
        id: "topic",
        mode: "precise",
        queries: [precise],
        terms: [normalized],
        subject,
        facetTerms: [],
        protect: true,
        allowFacetOnly: false,
        scopeTerms: [],
      });
    }
  }
  return plans;
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
      abortSignal: AbortSignal.timeout(RAG_AUXILIARY_MODEL_MAX_MS),
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
  items: RefinedRagRow[],
  keep: number
): Promise<RefinedRagRow[]> {
  if (keep <= 0) return [];
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
      abortSignal: AbortSignal.timeout(RAG_AUXILIARY_MODEL_MAX_MS),
    });
    const seen = new Set<number>();
    const picked: RefinedRagRow[] = [];
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

function keywordMatchScore(row: RagRow, terms: string[]): number {
  const headerText = row.metadata?.["Header 2"] ?? "";
  const content = normalizeKnownOcrErrors(row.content, headerText).toLowerCase();
  const header = normalizeKnownOcrErrors(headerText, row.content).toLowerCase();
  const normalizedTerms = Array.from(
    new Set(
      terms
        .flatMap((term) => normalizeSearchText(term).toLowerCase().split(" "))
        .filter((term) => term.length >= 2 && term !== "관련")
    )
  );

  let score = 0;
  for (const term of normalizedTerms) {
    if (header.includes(term)) score += 12;
    const occurrences = content.split(term).length - 1;
    score += Math.min(occurrences, 4) * 2;
  }
  const phrase = normalizedTerms.join(" ");
  if (phrase.length >= 4 && header.includes(phrase)) score += 20;
  if (phrase.length >= 4 && content.includes(phrase)) score += 8;
  return score;
}

function rankKeywordRows(rows: RagRow[], terms: string[]): RagRow[] {
  return rows
    .map((row, index) => ({ row, index, score: keywordMatchScore(row, terms) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ row }) => row);
}

function meaningfulSopTopicTerms(topic: string): string[] {
  return Array.from(
    new Set(
      normalizeSearchText(topic)
        .split(" ")
        .map((term) => stripKoreanParticle(term.trim()))
        .map((term) => {
          const suffix = ["관련", "대비", "대응", "교육", "훈련", "방법", "절차"].find(
            (candidate) => term.endsWith(candidate) && term.length - candidate.length >= 2
          );
          return suffix ? term.slice(0, -suffix.length) : term;
        })
        .filter((term) => term.length >= 2 && !SOP_TOPIC_STOP_WORDS.has(term))
    )
  ).slice(0, 12);
}

function rowSupportsSopTopic(row: RagRow, terms: readonly string[]): boolean {
  if (terms.length === 0) return false;
  const pageText = compactSearchText(
    `${row.metadata?.["Header 2"] ?? ""} ${row.content}`
  );
  const sourceText = compactSearchText(row.metadata?.source ?? "");
  const normalizedTerms = terms
    .map((term) => compactSearchText(term))
    .filter((term) => term.length >= 2);
  const pageSupported = normalizedTerms.filter((term) => pageText.includes(term));
  const allSupported = normalizedTerms.filter(
    (term) => pageText.includes(term) || sourceText.includes(term)
  );

  // 파일명은 문서 범위를 알려 줄 뿐 해당 페이지의 절차 근거가 아니다. 파일명에 주제가
  // 들어 있어도 제목/본문에서 핵심어가 하나도 확인되지 않으면 그 페이지를 SOP로 채택하지 않는다.
  return (
    pageSupported.length >= 1 &&
    allSupported.length >= Math.min(2, normalizedTerms.length)
  );
}

async function keywordRowsForPlan(
  supabase: Awaited<ReturnType<typeof createClient>>,
  plan: TopicSearchPlan,
  category: string | null | undefined,
  queryLimit: number
): Promise<{ rows: RagRow[]; degraded: boolean }> {
  // 광역 OR 검색은 충분한 재현율을 확보하고, 주제별 AND 검색은 좁은 결과만 받아
  // 동시 사용자 환경에서 전송 행 수와 메모리 사용을 줄인다.
  const requestLimit = plan.mode === "recall" ? queryLimit : Math.min(queryLimit, 24);
  const results = await Promise.all(
    plan.queries.map(async (keywordQuery) => {
      try {
        let request = (supabase.from as CallableFunction)(RAG_TABLE)
          .select("id, content, metadata")
          .eq("is_active", true)
          .textSearch("content", keywordQuery, { type: "websearch", config: "simple" })
          .limit(requestLimit);
        if (category) request = request.eq(`metadata->>${CATEGORY_FIELD}`, category);
        const { data, error } = await withRagDbTimeout(request);
        if (error) {
          console.error("[rag-external] keyword error:", error.message);
          return { rows: [] as RagRow[], degraded: true };
        }
        return {
          rows: rankKeywordRows((data ?? []) as RagRow[], plan.terms),
          degraded: false,
        };
      } catch (error) {
        console.error(
          "[rag-external] keyword request failed:",
          error instanceof Error ? error.message : error
        );
        return { rows: [] as RagRow[], degraded: true };
      }
    })
  );

  return {
    rows: interleaveUnique(
      results.map((result) => result.rows),
      queryLimit,
      (row) => row.id
    ),
    degraded: results.some((result) => result.degraded),
  };
}

type InferredSearchScope = {
  category: string | null;
  primarySource: string | null;
};

// 분야를 고르지 않은 질문은 정밀 키워드 결과에서 분야와 주 문서를 먼저 찾는다.
// 문서명이 주제와 정확히 맞으면 그 문서 안에서 벡터 검색하고, 제목 일치가 약하면 분야만
// 적용한다. 한 페이지의 우연한 본문 일치로 문서를 고정하지 않는다.
function inferSearchScopeFromKeywordRows(
  plans: readonly TopicSearchPlan[],
  keywordLists: readonly RagRow[][]
): InferredSearchScope {
  const scores = new Map<
    string,
    { score: number; sourceMatches: number; rowIds: Set<string> }
  >();
  const sourceScores = new Map<string, { score: number; rowIds: Set<string> }>();

  plans.forEach((plan, index) => {
    if (plan.mode !== "precise" || !isSpecificTopicSubject(plan.subject)) return;
    for (const row of keywordLists[index] ?? []) {
      const category = row.metadata?.[CATEGORY_FIELD];
      if (typeof category !== "string" || !category.trim()) continue;

      const sourceMatches = textMatchesSubject(
        row.metadata?.source ?? "",
        plan.subject,
        row.metadata?.["Header 2"] ?? ""
      );
      const pageMatches = textMatchesSubject(
        `${row.metadata?.["Header 2"] ?? ""} ${row.content}`,
        plan.subject,
        row.metadata?.source ?? ""
      );
      if (!sourceMatches && !pageMatches) continue;

      const source = row.metadata?.source?.trim();
      if (source && sourceMatches) {
        const sourceScore = sourceScores.get(source) ?? { score: 0, rowIds: new Set<string>() };
        if (!sourceScore.rowIds.has(row.id)) {
          sourceScore.rowIds.add(row.id);
          sourceScore.score += 1;
        }
        sourceScores.set(source, sourceScore);
      }

      const key = category.trim();
      const current = scores.get(key) ?? {
        score: 0,
        sourceMatches: 0,
        rowIds: new Set<string>(),
      };
      if (!current.rowIds.has(row.id)) {
        current.rowIds.add(row.id);
        current.score += sourceMatches ? 6 : 1;
        if (sourceMatches) current.sourceMatches += 1;
      }
      scores.set(key, current);
    }
  });

  const ranked = Array.from(scores.entries()).sort(
    (a, b) =>
      b[1].score - a[1].score ||
      b[1].sourceMatches - a[1].sourceMatches ||
      b[1].rowIds.size - a[1].rowIds.size
  );
  const best = ranked[0];
  let category: string | null = null;
  // 파일명 자체가 주제와 맞거나, 서로 다른 두 청크가 같은 분야를 지지할 때만 자동 적용한다.
  // 한 페이지의 우연한 본문 일치로 분야를 좁히는 오판은 피한다.
  if (
    best &&
    (best[1].sourceMatches > 0 || best[1].rowIds.size >= 2) &&
    (!ranked[1] || ranked[1][1].score !== best[1].score)
  ) {
    category = best[0];
  }

  const rankedSources = Array.from(sourceScores.entries()).sort(
    (a, b) => b[1].score - a[1].score || b[1].rowIds.size - a[1].rowIds.size
  );
  const bestSource = rankedSources[0];
  const primarySource =
    bestSource &&
    (!rankedSources[1] || rankedSources[1][1].score !== bestSource[1].score)
      ? bestSource[0]
      : null;
  return { category, primarySource };
}

// 하이브리드 후보 검색:
// ① 벡터 1회 + ② 전체 OR/하위주제 AND 키워드 검색 병렬
// ③ 하위주제별 우선 병합 + ④ RRF 보강.
// 챗봇(searchExternalRag)과 자료제작(fetchExternalRagContext)이 동일 검색을 공유하는 단일 출처.
async function hybridCandidates(
  supabase: Awaited<ReturnType<typeof createClient>>,
  embedding: number[] | null,
  plans: TopicSearchPlan[],
  category: string | null | undefined,
  candidateCount: number
): Promise<HybridCandidateResult> {
  const queryLimit = Math.max(48, Math.min(candidateCount, 80));
  const vectorRows = async (
    resolvedCategory: string | null | undefined,
    primarySource: string | null = null
  ) => {
    if (!embedding) return { rows: [] as RagRow[], degraded: false };
    try {
      const { data, error } = await withRagDbTimeout(
        (supabase.rpc as CallableFunction)(MATCH_FN, {
          query_embedding: toPgVector(embedding),
          match_count: candidateCount,
          match_threshold: 0.3, // 약한 벡터 매칭 차단(정상 0.5+)
          filter: {
            ...(resolvedCategory ? { [CATEGORY_FIELD]: resolvedCategory } : {}),
            ...(primarySource ? { source: primarySource } : {}),
          },
        })
      );
      if (error) {
        console.error("[rag-external] vector error:", error.message);
        return { rows: [] as RagRow[], degraded: true };
      }
      return { rows: (data ?? []) as RagRow[], degraded: false };
    } catch (error) {
      console.error(
        "[rag-external] vector request failed:",
        error instanceof Error ? error.message : error
      );
      return { rows: [] as RagRow[], degraded: true };
    }
  };

  let vecResult: { rows: RagRow[]; degraded: boolean };
  let keywordResults: { rows: RagRow[]; degraded: boolean }[];
  if (category?.trim()) {
    [vecResult, ...keywordResults] = await Promise.all([
      vectorRows(category),
      ...plans.map((plan) => keywordRowsForPlan(supabase, plan, category, queryLimit)),
    ]);
  } else {
    // 자동 모드에서는 빠른 FTS 결과로 분야를 정한 뒤 벡터 검색을 보낸다. 정확한 문서명이
    // 있는 질문이 filter={} 전역 검색 시간 초과로 키워드 전용으로 강등되는 것을 막는다.
    keywordResults = await Promise.all(
      plans.map((plan) => keywordRowsForPlan(supabase, plan, null, queryLimit))
    );
    const inferredScope = inferSearchScopeFromKeywordRows(
      plans,
      keywordResults.map((result) => result.rows)
    );
    if (inferredScope.primarySource || inferredScope.category) {
      keywordResults = keywordResults.map((result) => ({
        ...result,
        rows: [...result.rows].sort((a, b) => {
          const scopeScore = (row: RagRow): number =>
            (inferredScope.primarySource &&
            row.metadata?.source === inferredScope.primarySource
              ? 2
              : 0) +
            (inferredScope.category &&
            row.metadata?.[CATEGORY_FIELD] === inferredScope.category
              ? 1
              : 0);
          return scopeScore(b) - scopeScore(a);
        }),
      }));
    }
    vecResult = await vectorRows(inferredScope.category, inferredScope.primarySource);
  }

  const keywordLists = keywordResults.map((result) => result.rows);
  const precisePlans = plans.filter((plan) => plan.mode === "precise");
  const affinityEnabled = precisePlans.some((plan) => isSpecificTopicSubject(plan.subject));
  const precisePlanRows = plans
    .map((plan, index) => ({ plan, rows: keywordLists[index] ?? [] }))
    .filter(({ plan, rows }) => plan.mode === "precise" && rows.length > 0)
    .map(({ plan, rows }) => {
      const usableIds = new Set(refine(rows, rows.length).map((row) => row.id));
      return { plan, rows: rows.filter((row) => usableIds.has(row.id)) };
    })
    .filter(({ rows }) => rows.length > 0);
  const affinityPlanRows = precisePlanRows.map(({ plan, rows }) => {
    if (!affinityEnabled) return { plan, priorityRows: rows, fallbackRows: [] as RagRow[] };

    const aRows: RagRow[] = [];
    const bRows: RagRow[] = [];
    const fallbackRows: RagRow[] = [];
    for (const row of rows) {
      const affinity = classifyRowForSearchPlan(plan, row);
      if (affinity === "A") aRows.push(row);
      else if (affinity === "B") bRows.push(row);
      else if (affinity === "C") fallbackRows.push(row);
    }
    return { plan, priorityRows: [...aRows, ...bRows], fallbackRows };
  });
  const preciseLists = affinityPlanRows
    .map(({ priorityRows }) => priorityRows)
    .filter((rows) => rows.length > 0);
  const protectedPlanRows = affinityPlanRows.filter(
    ({ plan, priorityRows }) => plan.protect && priorityRows.length > 0
  );

  const requiredFacetPlans = precisePlans.filter(
    (plan) => plan.protect && plan.facetTerms.length > 0
  );
  const requiredFacetCoverageComplete =
    affinityEnabled &&
    requiredFacetPlans.length > 0 &&
    requiredFacetPlans.every((requiredPlan) =>
      affinityPlanRows.some(
        ({ plan, priorityRows }) =>
          plan.id === requiredPlan.id && priorityRows.length > 0
      )
    );
  const missingRequiredPlanIds = new Set(
    requiredFacetPlans
      .filter(
        (requiredPlan) =>
          !affinityPlanRows.some(
            ({ plan, priorityRows }) =>
              plan.id === requiredPlan.id && priorityRows.length > 0
          )
      )
      .map((plan) => plan.id)
  );
  // 명시적으로 요구된 facet이 있으면 그중 A/B가 없는 facet의 C만 살린다.
  // 명시 facet이 없는 단일 주제/확장 검색은 모든 C를 기존처럼 사용할 수 있다.
  const fallbackPlans =
    requiredFacetPlans.length > 0
      ? precisePlans.filter((plan) => missingRequiredPlanIds.has(plan.id))
      : precisePlans;
  const fallbackPlanIds = new Set(fallbackPlans.map((plan) => plan.id));
  const fallbackPreciseLists = affinityPlanRows
    .filter(({ plan }) => fallbackPlanIds.has(plan.id))
    .map(({ fallbackRows }) => fallbackRows)
    .filter((rows) => rows.length > 0);

  // 각 하위주제의 첫 유효 근거는 최종 재순위·문서 다양성 단계에서도 보호한다.
  const protectedRows: RagRow[] = [];
  const protectedSeen = new Set<string>();
  const protectedFacets = new Map<string, string[]>();
  for (const { plan, priorityRows } of protectedPlanRows) {
    const representative = priorityRows.find((row) => !protectedSeen.has(row.id));
    if (!representative) continue;
    protectedSeen.add(representative.id);
    protectedRows.push(representative);
    protectedFacets.set(representative.id, [plan.id]);
  }

  // 각 하위주제에서 상위 3개까지 우선 병합한 뒤 벡터/RRF 결과로 나머지를 채운다.
  const interleavedCoverage = interleaveUnique(
    preciseLists,
    Math.min(candidateCount, preciseLists.length * 3),
    (row) => row.id
  );
  const coverage = [...protectedRows];
  const coverageSeen = new Set(coverage.map((row) => row.id));
  for (const row of interleavedCoverage) {
    if (coverageSeen.has(row.id)) continue;
    coverageSeen.add(row.id);
    coverage.push(row);
  }
  const fused = rrfFuse([vecResult.rows, ...keywordLists]);
  const fusedPriority: RagRow[] = [];
  const fusedFallback: RagRow[] = [];
  if (!affinityEnabled) {
    fusedPriority.push(...fused);
  } else {
    for (const row of fused) {
      let hasPriorityAffinity = false;
      for (const plan of precisePlans) {
        const affinity = classifyRowForSearchPlan(plan, row);
        if (affinity === "A" || affinity === "B") {
          hasPriorityAffinity = true;
          break;
        }
      }
      if (hasPriorityAffinity) {
        fusedPriority.push(row);
        continue;
      }
      if (
        fallbackPlans.some(
          (plan) =>
            classifyRowForSearchPlan(plan, row) === "C"
        )
      ) {
        fusedFallback.push(row);
      }
    }
  }

  const rows = [...coverage];
  const seen = new Set(rows.map((row) => row.id));
  const appendUnique = (candidates: readonly RagRow[]): void => {
    for (const row of candidates) {
      if (rows.length >= candidateCount) break;
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
  };
  appendUnique(fusedPriority);

  // 제목-주제 또는 제목-절차 근거가 모든 필수 facet을 덮으면 본문에만 걸린 C 후보로
  // 생성용 24개 슬롯을 억지로 채우지 않는다. 부족할 때만 C를 보호되지 않은 뒤쪽 후보로 살린다.
  if (!requiredFacetCoverageComplete) {
    appendUnique(
      interleaveUnique(
        fallbackPreciseLists,
        Math.min(candidateCount, fallbackPreciseLists.length * 3),
        (row) => row.id
      )
    );
    appendUnique(fusedFallback);
  }
  return {
    rows: rows.slice(0, candidateCount),
    protectedIds: protectedRows.map((row) => row.id),
    protectedFacets: Object.fromEntries(protectedFacets),
    degraded:
      vecResult.degraded || keywordResults.some((result) => result.degraded),
  };
}

// 선택한 분야에 관련 자료가 다른 edu_category로 분류된 경우를 위한 안전 폴백.
// 분야 제한 검색이 정확히 0건일 때만 같은 벡터·검색 계획으로 전 분야를 한 번 재시도한다.
// 정상 분야 결과가 하나라도 있으면 추가 조회하지 않는다.
async function hybridCandidatesWithCategoryFallback(
  supabase: Awaited<ReturnType<typeof createClient>>,
  embedding: number[] | null,
  plans: TopicSearchPlan[],
  category: string | null | undefined,
  candidateCount: number
): Promise<HybridCandidateResult> {
  const primary = await hybridCandidates(
    supabase,
    embedding,
    plans,
    category,
    candidateCount
  );
  if (!category?.trim() || primary.rows.length > 0) return primary;

  const unrestricted = await hybridCandidates(
    supabase,
    embedding,
    plans,
    null,
    candidateCount
  );
  return {
    ...unrestricted,
    // 분야 제한을 완화했음을 호출자가 알 수 있게 한다.
    degraded: true,
  };
}

// 정제된 청크들을 생성용 컨텍스트 문자열 + 출처(파일 단위 중복 제거)로 조립한다.
function buildContextFromRefined(
  refined: RefinedRagRow[],
  maxSources: number
): {
  contextText: string;
  sources: GeneratedDocSource[];
  bindingSources: GeneratedDocSource[];
} {
  const contextText = refined
    .map((r) => `[${labelOf(r.meta)}]\n${r.text}`)
    .join("\n\n---\n\n");

  const sourceCandidates: GeneratedDocSource[] = [];
  for (const r of refined) {
    const documentId = documentIdOf(r.meta);
    const page = pageOf(r.meta);
    sourceCandidates.push({ document_id: documentId, doc: documentLabelOf(r.meta), page });
  }
  const { sources, bindingSources } = splitGeneratedSourcesForDisplay(
    sourceCandidates,
    maxSources
  );
  return { contextText, sources, bindingSources };
}

// 하이브리드 검색(벡터+키워드 RRF) + LLM 재순위 → 컨텍스트 + 출처 (lib/rag.ts SearchResult)
export async function searchExternalRag(
  query: string,
  embedding: number[] | null,
  topK: number,
  category?: string | null,
  keywordTerms: string[] = [],
  suppliedClient?: ExternalRagSupabaseClient
): Promise<SearchResult> {
  const supabase = suppliedClient ?? (await createClient());
  // 지나치게 큰 호출값으로 컨텍스트가 폭증하지 않게 하되, 호출자가 요청한 topK는 존중한다.
  const keep = Math.max(1, Math.min(topK, 10));
  // 노이즈(목차·총론)가 섞여도 본문 청크가 충분히 남도록 후보를 넉넉히 받는다.
  const candidateCount = Math.max(40, keep * 6);
  const plans = buildTopicSearchPlans(query, keywordTerms);

  // ①② 하이브리드 후보 → ③ RRF 융합 → ④ 정제·노이즈 제외 → ⑤ LLM 재순위
  const candidates = await hybridCandidatesWithCategoryFallback(
    supabase,
    embedding,
    plans,
    category,
    candidateCount
  );
  const fused = candidates.rows;
  if (fused.length === 0) {
    return { contextText: "", sources: [], matched: 0, degraded: candidates.degraded };
  }
  const refined = refine(fused, Math.max(12, keep * 2));
  if (refined.length === 0) {
    return { contextText: "", sources: [], matched: 0, degraded: candidates.degraded };
  }
  const protectedIds = new Set(candidates.protectedIds);
  const protectedRows = refined
    .filter((row) => protectedIds.has(row.id))
    .slice(0, keep);
  const remaining = refined.filter((row) => !protectedIds.has(row.id));
  const reranked = await llmRerank(
    query,
    remaining,
    Math.max(0, keep - protectedRows.length)
  );
  const top = [...protectedRows, ...reranked].slice(0, keep);

  const contextText = top
    .map((r) => {
      const purposes = (candidates.protectedFacets[r.id] ?? [])
        .map((facet) => FACET_DISPLAY_LABELS[facet] ?? facet)
        .filter(Boolean);
      const purposeLine =
        purposes.length > 0 ? `\n[확인 항목: ${purposes.join(" · ")}]` : "";
      return `[${labelOf(r.meta)}]${purposeLine}\n${r.text}`;
    })
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
const GEN_FALLBACK_MAX_LIMIT = 80;
const SOURCE_DISCOVERY_PAGE = 1000;
const SOURCE_DISCOVERY_MAX_ROWS = 5000;
const SOURCE_MAX_PER_CATEGORY = 24;
const SOURCE_QUERY_MAX_ROWS = 160;

type CategorySourceRow = {
  id: string;
  document_id: number | string | null;
  source: string | null;
};

type CategorySourceRef = {
  key: string;
  documentId: string | null;
  source: string | null;
};

function categorySourceRefOf(row: CategorySourceRow): CategorySourceRef | null {
  const numericId = numberMetadata(row.document_id);
  const documentId = numericId != null && numericId > 0 ? String(numericId) : null;
  const source = row.source?.trim() || null;
  if (!documentId && !source) return null;
  return {
    key: documentId ? `document:${documentId}` : `source:${source}`,
    documentId,
    source,
  };
}

// 분야의 고유 문서를 먼저 가볍게 찾는다. 전체 테이블을 무제한 순회하지 않도록 조회량을 고정하고,
// UUID id 순으로 읽은 뒤 문서 키를 정렬해 같은 데이터에서는 항상 같은 문서 순서를 얻는다.
async function discoverCategorySources(
  supabase: Awaited<ReturnType<typeof createClient>>,
  category: string
): Promise<CategorySourceRef[] | null> {
  const byKey = new Map<string, CategorySourceRef>();

  for (let from = 0; from < SOURCE_DISCOVERY_MAX_ROWS; from += SOURCE_DISCOVERY_PAGE) {
    const to = Math.min(
      from + SOURCE_DISCOVERY_PAGE - 1,
      SOURCE_DISCOVERY_MAX_ROWS - 1
    );
    const { data, error } = await withRagDbTimeout(
      (supabase.from as CallableFunction)(RAG_TABLE)
        .select("id, document_id:metadata->>document_id, source:metadata->>source")
        .eq("is_active", true)
        .eq(`metadata->>${CATEGORY_FIELD}`, category)
        .order("id", { ascending: true })
        .range(from, to)
    );

    if (error) {
      console.error("[rag-external] source discovery error:", error.message);
      return null;
    }

    const rows = (data ?? []) as CategorySourceRow[];
    for (const row of rows) {
      const ref = categorySourceRefOf(row);
      if (ref && !byKey.has(ref.key)) byKey.set(ref.key, ref);
    }
    if (rows.length < to - from + 1) break;
  }

  return Array.from(byKey.values())
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, SOURCE_MAX_PER_CATEGORY);
}

// 발견한 각 원본 문서에서 제한된 수의 청크를 병렬 조회한다. 문서 하나만 있는 분야는 그 문서에서
// 충분한 후보를 받고, 문서가 많으면 문서별 후보량을 줄여 전체 읽기량을 일정 범위로 유지한다.
async function fetchRowsByCategorySources(
  supabase: Awaited<ReturnType<typeof createClient>>,
  category: string,
  desiredLimit: number
): Promise<RagRow[] | null> {
  const sources = await discoverCategorySources(supabase, category);
  if (!sources || sources.length === 0) return null;

  const perSourceLimit = Math.min(
    SOURCE_QUERY_MAX_ROWS,
    Math.max(8, Math.ceil(desiredLimit / sources.length) * 3),
    desiredLimit * 2
  );
  const results = await Promise.all(
    sources.map(async (source) => {
      let query = (supabase.from as CallableFunction)(RAG_TABLE)
        .select("id, content, metadata")
        .eq("is_active", true)
        .eq(`metadata->>${CATEGORY_FIELD}`, category)
        .order("id", { ascending: true })
        .limit(perSourceLimit);
      query = source.documentId
        ? query.eq("metadata->>document_id", source.documentId)
        : query.eq("metadata->>source", source.source);
      return withRagDbTimeout(query);
    })
  );

  const rows: RagRow[] = [];
  for (const result of results) {
    if (result.error) {
      console.error("[rag-external] source context error:", result.error.message);
      continue;
    }
    rows.push(...((result.data ?? []) as RagRow[]));
  }
  return rows.length > 0 ? rows : null;
}

// 문서별 조회가 실패하거나 구형 데이터에 source/document_id가 없을 때 사용하는 기존 방식 폴백.
async function fetchLegacyCategoryRows(
  supabase: Awaited<ReturnType<typeof createClient>>,
  category: string,
  desiredLimit: number
): Promise<RagRow[] | null> {
  const { data, error } = await withRagDbTimeout(
    (supabase.from as CallableFunction)(RAG_TABLE)
      .select("id, content, metadata")
      .eq("is_active", true)
      .eq(`metadata->>${CATEGORY_FIELD}`, category)
      .order("id", { ascending: true })
      .limit(desiredLimit * 2)
  );

  if (error) {
    console.error("[rag-external] fetch context error:", error.message);
    return null;
  }
  return (data ?? []) as RagRow[];
}

// 분야 자료를 모아 생성(AI 자료제작) 컨텍스트를 만든다.
// topic 이 있으면 챗봇과 동일한 하이브리드 검색으로 "주제 관련" 청크를 우선 모으고,
// 없거나(분야 전반) 검색 결과가 비면 분야 전체 청크로 폴백한다.
export async function fetchExternalRagContext(
  category: string,
  limit = 40,
  topic?: string,
  suppliedClient?: ExternalRagSupabaseClient
): Promise<{
  contextText: string;
  sources: GeneratedDocSource[];
  bindingSources: GeneratedDocSource[];
  degraded: boolean;
}> {
  const supabase = suppliedClient ?? (await createClient());
  const topicTrimmed = topic?.trim().slice(0, 100);
  let retrievalDegraded = false;

  // ① 주제 기반: "분야 + 주제"를 임베딩해 하이브리드 검색 → 정제 → 컨텍스트 조립.
  // 임베딩 서비스가 끊겨도 하위주제별 키워드 검색은 반드시 계속한다.
  if (topicTrimmed) {
    // 질의 확장은 임베딩과 병렬로 시작한다. 실패해도 expandQuery 자체가 원문으로 복구한다.
    const expansionPromise = expandQuery(topicTrimmed);
    let embedding: number[] | null = null;
    try {
      await assertExternalEmbeddingContract(supabase);
      embedding = await getQueryEmbedding(`${category} ${topicTrimmed}`);
    } catch (error) {
      retrievalDegraded = true;
      console.error(
        "[rag-external] 생성용 벡터 검색 비활성화, 키워드 검색으로 진행:",
        error instanceof Error ? error.message : error
      );
    }

    try {
      const { keywords } = await expansionPromise;
      const plans = buildTopicSearchPlans(topicTrimmed, keywords);
      // AI 자료제작의 일반 교재는 사용자가 고른 분야 밖으로 넓히지 않는다. 전 분야 공통
      // 근거는 별도 SOP 검색에서 document_type까지 검증한 뒤에만 합친다.
      const candidates = await hybridCandidates(
        supabase,
        embedding,
        plans,
        category,
        Math.max(60, GEN_KEEP * 3)
      );
      retrievalDegraded ||= candidates.degraded;
      const refined = refine(candidates.rows, candidates.rows.length);
      const protectedIds = new Set(candidates.protectedIds);
      const protectedRows = refined
        .filter((row) => protectedIds.has(row.id))
        .slice(0, GEN_KEEP);
      const remaining = refined.filter((row) => !protectedIds.has(row.id));
      const diverseRemainder = selectSourceDiverse(
        remaining,
        Math.max(0, GEN_KEEP - protectedRows.length),
        (item) => documentSourceKey(item.meta)
      );
      const selected = [...protectedRows, ...diverseRemainder].slice(0, GEN_KEEP);
      if (selected.length > 0) {
        return {
          ...buildContextFromRefined(selected, 5),
          degraded: retrievalDegraded,
        };
      }
      // 주제 검색 결과가 없으면 분야 전체로 폴백
      retrievalDegraded = true;
    } catch (e) {
      retrievalDegraded = true;
      console.error("[rag-external] 주제 키워드 검색까지 실패, 분야 전체로 폴백:", e);
    }
  }

  // ② 분야 전체(폴백/주제 미지정): 원본 문서별 후보를 받은 뒤 라운드로빈으로 고른다.
  // 단일 문서 분야는 같은 로직에서 해당 문서 청크로 요청량을 모두 채운다.
  const normalizedLimit = Number.isFinite(limit) ? Math.floor(limit) : 40;
  const desiredLimit = Math.max(1, Math.min(normalizedLimit, GEN_FALLBACK_MAX_LIMIT));
  const sourceRows = await fetchRowsByCategorySources(supabase, category, desiredLimit);
  let rows = sourceRows ?? (await fetchLegacyCategoryRows(supabase, category, desiredLimit));
  if (!rows || rows.length === 0) {
    return { contextText: "", sources: [], bindingSources: [], degraded: retrievalDegraded };
  }

  // 모든 문서의 후보를 먼저 정제해야 앞 문서의 정상 청크만으로 keep이 차는 편향이 생기지 않는다.
  let refined = refine(rows, rows.length);
  if (refined.length === 0 && sourceRows) {
    rows = await fetchLegacyCategoryRows(supabase, category, desiredLimit);
    if (!rows || rows.length === 0) {
      return { contextText: "", sources: [], bindingSources: [], degraded: retrievalDegraded };
    }
    refined = refine(rows, rows.length);
  }
  const diverse = selectSourceDiverse(refined, desiredLimit, (item) =>
    documentSourceKey(item.meta)
  );
  if (diverse.length === 0) {
    return { contextText: "", sources: [], bindingSources: [], degraded: retrievalDegraded };
  }
  return {
    ...buildContextFromRefined(diverse, 5),
    degraded: retrievalDegraded,
  };
}

export type ExternalSopContext = {
  contextText: string;
  sources: GeneratedDocSource[];
  bindingSources: GeneratedDocSource[];
  degraded: boolean;
  evidence: SopEvidence;
};

function selectScopedSopRows(
  refined: readonly RefinedRagRow[],
  requestedCategory: string,
  limit: number
): RefinedRagRow[] {
  const requested = requestedCategory.trim().slice(0, 100);
  const commonRows = refined.filter(
    (row) => row.meta?.edu_category === COMMON_SOP_CATEGORY
  );
  const requestedRows = refined.filter((row) => {
    const rowCategory = row.meta?.edu_category;
    return !rowCategory || rowCategory === requested;
  });

  if (requested === COMMON_SOP_CATEGORY) {
    return selectSourceDiverse(
      commonRows.length > 0 ? commonRows : requestedRows,
      limit,
      (item) => documentSourceKey(item.meta)
    );
  }
  if (requestedRows.length === 0) {
    return selectSourceDiverse(commonRows, limit, (item) =>
      documentSourceKey(item.meta)
    );
  }
  if (commonRows.length === 0 || limit <= 1) {
    return selectSourceDiverse(requestedRows, limit, (item) =>
      documentSourceKey(item.meta)
    );
  }

  // 요청 분야가 주 근거가 되도록 먼저 채우되, 관련 공통 SOP가 있으면 기본 조회(4건)의
  // 최소 한 자리를 보장한다. 요청 분야 근거가 적으면 남은 자리는 공통 SOP로 채운다.
  const primary = selectSourceDiverse(requestedRows, limit - 1, (item) =>
    documentSourceKey(item.meta)
  );
  const common = selectSourceDiverse(commonRows, limit - primary.length, (item) =>
    documentSourceKey(item.meta)
  );
  return [...primary, ...common].slice(0, limit);
}

/**
 * 공식 SOP 또는 관리자가 현장지침·매뉴얼로 분류한 문서만 별도로 검색한다.
 * 일반 교재의 출처 라벨이 SOP 근거로 승격되지 않도록 metadata.document_type을
 * 서버 필터로 고정한다. 요청 분야를 주 범위로 하고 `현장지휘·공통`만 전 분야 보조 범위로
 * 허용한다. 다른 분야 지침이나 공통 분야의 일반 교육자료는 근거로 승격하지 않는다.
 * 임베딩·질의확장 없이 제한된 키워드 검색만 수행해 일반 RAG와 병렬 실행해도 부담을 낮춘다.
 */
export async function fetchExternalSopContext(
  category: string,
  topic: string,
  limit = 4,
  suppliedClient?: ExternalRagSupabaseClient
): Promise<ExternalSopContext> {
  const supabase = suppliedClient ?? (await createClient());
  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(8, Math.floor(limit)))
    : 4;
  const plans = buildTopicSearchPlans(topic, []);
  const relevanceTerms = meaningfulSopTopicTerms(topic);
  const categoryScope = sopCategoryScope(category);
  // '훈련·대비' 같은 분야 공통어만으로는 특정 SOP 적용 근거를 고를 수 없다. 세부 수행이나
  // 장비를 나타내는 핵심어가 없으면 일반 지침을 임의로 승격하지 않고 미확인으로 남긴다.
  if (plans.length === 0 || relevanceTerms.length === 0 || categoryScope.length === 0) {
    return {
      contextText: "",
      sources: [],
      bindingSources: [],
      degraded: false,
      evidence: { status: "not_found", sourceLabels: [] },
    };
  }

  const results = await Promise.all(
    plans.slice(0, 4).flatMap((plan) =>
      plan.queries.slice(0, 2).map(async (keywordQuery) => {
        try {
          const request = (supabase.from as CallableFunction)(RAG_TABLE)
            .select("id, content, metadata")
            .eq("is_active", true)
            .in(`metadata->>${CATEGORY_FIELD}`, categoryScope)
            .in("metadata->>document_type", [...SOP_DOCUMENT_TYPES])
            // SOP 공유 DB 계약은 Header 2+본문에서 관련성을 판정한다. 같은 범위를 미리
            // 검색하는 생성 열을 써야 제목에만 주제가 있고 본문은 단계문인 정상 페이지를
            // not_found로 놓친 뒤 공유 단계에서 거절하는 불일치가 생기지 않는다.
            .textSearch("sop_search_vector", keywordQuery, {
              type: "websearch",
              config: "simple",
            })
            .limit(32);
          const { data, error } = await withRagDbTimeout(request);
          if (error) {
            console.error("[rag-external] SOP keyword error:", error.message);
            return { rows: [] as RagRow[], degraded: true, terms: plan.terms };
          }
          const relevantRows = ((data ?? []) as RagRow[]).filter((row) =>
            rowSupportsSopTopic(row, relevanceTerms)
          );
          return {
            rows: rankKeywordRows(relevantRows, plan.terms),
            degraded: false,
            terms: plan.terms,
          };
        } catch (error) {
          console.error(
            "[rag-external] SOP keyword request failed:",
            error instanceof Error ? error.message : error
          );
          return { rows: [] as RagRow[], degraded: true, terms: plan.terms };
        }
      })
    )
  );

  const degraded = results.some((result) => result.degraded);
  const combined = interleaveUnique(
    results.map((result) => result.rows),
    64,
    (row) => row.id
  );
  const refined = refine(combined, combined.length);
  const selected = selectScopedSopRows(refined, category, normalizedLimit);

  if (selected.length === 0) {
    return {
      contextText: "",
      sources: [],
      bindingSources: [],
      degraded,
      evidence: {
        status: degraded ? "degraded" : "not_found",
        sourceLabels: [],
      },
    };
  }

  const context = buildContextFromRefined(selected, normalizedLimit);
  return {
    ...context,
    degraded,
    evidence: {
      status: "found",
      sourceLabels: selected.map((row) => `[${labelOf(row.meta)}]`),
    },
  };
}

// 분야 → 원본 파일명 목록 (AI 자료제작 선택지·NotebookLM 자료 목록용)
// Supabase REST는 요청당 최대 1000행이라, 전체 분야를 빠짐없이 모으려면 페이지네이션 필요.
export async function listExternalRagCategories(): Promise<Record<string, string[]>> {
  const supabase = await createClient();
  const PAGE = 1000;
  const byCat = new Map<string, Set<string>>();

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await withRagDbTimeout(
      (supabase.from as CallableFunction)(RAG_TABLE)
        .select(`category:metadata->>${CATEGORY_FIELD}, source:metadata->>source`)
        .eq("is_active", true)
        .range(from, from + PAGE - 1)
    );
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

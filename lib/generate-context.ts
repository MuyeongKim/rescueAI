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
  extractSourceLabels,
  splitGeneratedSourcesForDisplay,
  type GeneratedDocSource,
} from "@/lib/generate";
import type { SopEvidence } from "@/lib/sop-evidence";
import { withSupabaseRequestTimeout } from "@/lib/supabase/request-timeout";

export type GenerationContext = {
  contextText: string;
  sources: GeneratedDocSource[];
  bindingSources: GeneratedDocSource[];
  degraded: boolean;
  sopEvidence: SopEvidence;
};

export type GenerationContextSupabaseClient = Awaited<ReturnType<typeof createClient>>;

const GENERATION_CONTEXT_DB_TIMEOUT_MS = 45_000;
export const MAX_GENERATION_CONTEXT_UTF8_BYTES = 240_000;
const MAX_SOP_CONTEXT_UTF8_BYTES = 80_000;
const CONTEXT_SEPARATOR = "\n\n---\n\n";
const SOP_CONTEXT_HEADING = "\n\n=== 관련 SOP·현장지침 근거 ===\n";

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8Bytes(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  // UTF-16 surrogate pair의 앞 절반에서 잘리지 않게 한다.
  if (low > 0 && /[\uD800-\uDBFF]/.test(value.charAt(low - 1))) low -= 1;
  return value.slice(0, low).trimEnd();
}

function fitWholeContextSegments(value: string, maxBytes: number): string {
  const normalized = value.trim();
  if (!normalized || maxBytes <= 0) return "";
  if (utf8Bytes(normalized) <= maxBytes) return normalized;

  let fitted = "";
  for (const segment of normalized.split(CONTEXT_SEPARATOR)) {
    const next = fitted ? `${fitted}${CONTEXT_SEPARATOR}${segment}` : segment;
    if (utf8Bytes(next) <= maxBytes) {
      fitted = next;
      continue;
    }
    // 비정상적으로 큰 단일 청크도 출처 라벨과 앞부분 근거는 보존한다.
    if (!fitted) fitted = utf8Prefix(segment, maxBytes);
    break;
  }
  return fitted;
}

/**
 * 체크포인트가 DB 1 MiB 상한을 넘지 않도록 생성 근거만 보수적으로 제한한다.
 * SOP는 별도 예산으로 먼저 보존하고, 나머지를 일반 교범에 배정한다.
 */
export function limitGenerationContextText(general: string, sop = ""): string {
  const limitedSop = fitWholeContextSegments(sop, MAX_SOP_CONTEXT_UTF8_BYTES);
  const sopSection = limitedSop ? `${SOP_CONTEXT_HEADING}${limitedSop}` : "";
  const generalBudget = Math.max(
    0,
    MAX_GENERATION_CONTEXT_UTF8_BYTES - utf8Bytes(sopSection)
  );
  const limitedGeneral = fitWholeContextSegments(general, generalBudget);
  return `${limitedGeneral}${sopSection}`.trim();
}

/** 목차의 부족 조건에만 사용한다. 분야 범위를 넓히거나 SOP 확인 상태를 바꾸지 않는다. */
export async function supplementGenerationContext(
  current: GenerationContext,
  category: string,
  query: string,
  suppliedClient: GenerationContextSupabaseClient,
): Promise<GenerationContext> {
  // 레거시 chunks 경로에는 주제 검색 계약이 없으므로 같은 범주 전체 조회를 반복하지 않는다.
  if (!ragTableEnabled()) return current;
  const additional = await fetchExternalRagContext(category, 24, query, suppliedClient, {
    allowCategoryFallback: false,
  });
  if (!additional.contextText) return { ...current, degraded: current.degraded || additional.degraded };
  const [general, sop = ""] = current.contextText.split(SOP_CONTEXT_HEADING);
  const existingSegments = new Set(general.split(CONTEXT_SEPARATOR).map((segment) => segment.trim()));
  const newSegments = additional.contextText.split(CONTEXT_SEPARATOR)
    .map((segment) => segment.trim()).filter((segment) => segment && !existingSegments.has(segment));
  const contextText = limitGenerationContextText(
    [general, ...newSegments].filter(Boolean).join(CONTEXT_SEPARATOR), sop,
  );
  const retained = new Set(extractSourceLabels(contextText));
  const candidates = [...current.bindingSources, ...additional.bindingSources]
    .filter((source) => retained.has(generatedSourceLabel(source)));
  const display = splitGeneratedSourcesForDisplay(
    [...current.sources, ...additional.sources]
      .filter((source) => retained.has(generatedSourceLabel(source))), 5,
  );
  return {
    ...current,
    contextText,
    sources: display.sources,
    bindingSources: splitGeneratedSourcesForDisplay(candidates, Number.MAX_SAFE_INTEGER).bindingSources,
    degraded: current.degraded || additional.degraded,
  };
}

// 분야 자료의 청크를 모아 생성 컨텍스트 + 출처 목록을 만든다.
// topic 이 있으면 주제 관련 청크를 우선 검색한다(rag_rescue 경로).
export async function fetchCategoryContext(
  category: string,
  limit = 40,
  topic?: string,
  suppliedClient?: GenerationContextSupabaseClient,
): Promise<GenerationContext> {
  // RAG_TABLE=rag_rescue: 외부에서 임베딩해 둔 기존 테이블 사용
  if (ragTableEnabled()) {
    const query = topic?.trim() || `${category} 분야 핵심 훈련`;
    const [general, sop] = await Promise.all([
      fetchExternalRagContext(category, limit, query, suppliedClient),
      fetchExternalSopContext(category, query, 4, suppliedClient),
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
    const contextText = limitGenerationContextText(general.contextText, sop.contextText);
    const retainedSopLabels = sop.evidence.sourceLabels.filter((label) =>
      contextText.includes(label)
    );
    const sopEvidence =
      sop.evidence.status === "found" && retainedSopLabels.length === 0
        ? { status: "degraded" as const, sourceLabels: [] }
        : { ...sop.evidence, sourceLabels: retainedSopLabels };

    return {
      contextText,
      sources: merged.sources,
      bindingSources: binding.bindingSources,
      degraded: general.degraded || sop.degraded,
      sopEvidence,
    };
  }

  const supabase = suppliedClient ?? (await createClient());
  const { data: docs, error: docsError } = await withSupabaseRequestTimeout(
    supabase
      .from("documents")
      .select("id, title")
      .eq("category", category)
      .eq("status", "processed")
      .limit(50),
    GENERATION_CONTEXT_DB_TIMEOUT_MS
  );
  if (docsError) {
    console.error("[generate-context] document lookup failed:", docsError.message);
    return {
      contextText: "",
      sources: [],
      bindingSources: [],
      degraded: true,
      sopEvidence: { status: "not_found", sourceLabels: [] },
    };
  }
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
  const { data: chunks, error: chunksError } = await withSupabaseRequestTimeout(
    supabase
      .from("chunks")
      .select("content, page_num, document_id")
      .in(
        "document_id",
        docs.map((d) => d.id),
      )
      .limit(limit),
    GENERATION_CONTEXT_DB_TIMEOUT_MS
  );
  if (chunksError) {
    console.error("[generate-context] chunk lookup failed:", chunksError.message);
    return {
      contextText: "",
      sources: [],
      bindingSources: [],
      degraded: true,
      sopEvidence: { status: "not_found", sourceLabels: [] },
    };
  }
  if (!chunks || chunks.length === 0) {
    return {
      contextText: "",
      sources: [],
      bindingSources: [],
      degraded: false,
      sopEvidence: { status: "not_found", sourceLabels: [] },
    };
  }

  const contextText = limitGenerationContextText(
    chunks
      .map((c) => {
      const source: GeneratedDocSource = {
        document_id: c.document_id ?? -1,
        doc: titleById.get(c.document_id ?? -1) ?? "자료",
        page: c.page_num,
      };
      return `${generatedSourceLabel(source)}\n${c.content}`;
      })
      .join(CONTEXT_SEPARATOR)
  );

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

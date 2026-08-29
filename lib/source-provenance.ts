import type { GeneratedDocSource } from "@/lib/generate";
import { createClient } from "@/lib/supabase/server";

export type VerifiedGeneratedSources = {
  sources: GeneratedDocSource[];
  degraded: boolean;
};

const PROVENANCE_PAIR_BATCH_SIZE = 20;
const PROVENANCE_ROWS_PER_PAIR_LIMIT = 16;

function nativeProvenancePairFilter(
  sources: readonly Pick<GeneratedDocSource, "document_id" | "page">[]
): string {
  return sources
    .map((source) =>
      source.page === null
        ? `and(document_id.eq.${source.document_id},page_num.is.null)`
        : `and(document_id.eq.${source.document_id},page_num.eq.${source.page})`
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
 * 저장 요청의 출처 구조를 DB 조회 전에 엄격하게 확인한다.
 * page=null은 페이지 정보가 없는 실제 원본과 대조할 수 있으므로 허용하지만,
 * 추적할 수 없는 document_id<=0과 잘못된 페이지 번호는 허용하지 않는다.
 */
export function claimedGeneratedSources(
  content: unknown
): { ok: true; sources: GeneratedDocSource[] } | { ok: false } {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return { ok: false };
  }
  const value = (content as { sources?: unknown }).sources;
  if (value === undefined) return { ok: true, sources: [] };
  if (!Array.isArray(value) || value.length > 80) return { ok: false };

  const sources: GeneratedDocSource[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return { ok: false };
    }
    const source = candidate as Record<string, unknown>;
    const doc = typeof source.doc === "string" ? source.doc.trim() : "";
    if (
      !Number.isSafeInteger(source.document_id) ||
      (source.document_id as number) <= 0 ||
      !doc ||
      doc.length > 300 ||
      (source.page !== null &&
        (!Number.isSafeInteger(source.page) || (source.page as number) <= 0))
    ) {
      return { ok: false };
    }
    sources.push({
      document_id: source.document_id as number,
      doc,
      page: source.page as number | null,
    });
  }
  return { ok: true, sources };
}

function sourceKey(source: GeneratedDocSource): string | null {
  const doc = typeof source.doc === "string" ? source.doc.trim() : "";
  if (
    !Number.isSafeInteger(source.document_id) ||
    source.document_id <= 0 ||
    !doc ||
    (source.page !== null &&
      (!Number.isSafeInteger(source.page) || (source.page ?? 0) <= 0))
  ) {
    return null;
  }
  return JSON.stringify([source.document_id, doc, source.page]);
}

/** DB가 확인한 출처 집합이 클라이언트 주장과 하나도 빠짐없이 정확히 같은지 확인한다. */
export function sameVerifiedSourceSet(
  claimed: readonly GeneratedDocSource[],
  verified: readonly GeneratedDocSource[]
): boolean {
  const claimedKeys = new Set<string>();
  for (const source of claimed) {
    const key = sourceKey(source);
    if (!key) return false;
    claimedKeys.add(key);
  }
  const verifiedKeys = new Set<string>();
  for (const source of verified) {
    const key = sourceKey(source);
    if (!key) return false;
    verifiedKeys.add(key);
  }
  return (
    claimedKeys.size === verifiedKeys.size &&
    Array.from(claimedKeys).every((key) => verifiedKeys.has(key))
  );
}

/** 외부 RAG를 쓰지 않는 설치에서는 documents/chunks의 실제 분야·제목·페이지로 대조한다. */
export async function verifyNativeDocumentSourceProvenance(
  candidates: readonly GeneratedDocSource[],
  expectedCategory: string,
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<VerifiedGeneratedSources> {
  const category = expectedCategory.trim().slice(0, 100);
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
  if (!category || requested.length === 0) return { sources: [], degraded: false };

  const documentIds = Array.from(new Set(requested.map((source) => source.document_id)));
  try {
    const chunkQueries: Array<
      PromiseLike<{ data: unknown; error: { message?: string } | null }>
    > = [];
    const chunkLimits: number[] = [];
    for (const batch of provenancePairBatches(requested)) {
      const limit = Math.min(
        1000,
        Math.max(64, batch.length * PROVENANCE_ROWS_PER_PAIR_LIMIT)
      );
      chunkLimits.push(limit);
      chunkQueries.push(
        (supabase.from as CallableFunction)("chunks")
          .select("document_id, page_num")
          // 독립 IN 조건은 요청하지 않은 문서×페이지 조합을 만들므로 정확한 쌍만 조회한다.
          .or(nativeProvenancePairFilter(batch))
          .limit(limit)
      );
    }

    const [documentsResult, ...chunkResults] = await Promise.all([
      (supabase.from as CallableFunction)("documents")
        .select("id, title, category")
        .eq("category", category)
        .eq("status", "processed")
        .in("id", documentIds)
        .limit(80),
      ...chunkQueries,
    ]);
    const chunkError = chunkResults.find((result) => result.error)?.error;
    if (documentsResult.error || chunkError) {
      console.error(
        "[generate/save] 기본 자료 출처 검증 실패:",
        documentsResult.error?.message ?? chunkError?.message
      );
      return { sources: [], degraded: true };
    }
    const documents = new Map<number, string>(
      ((documentsResult.data ?? []) as Array<{ id: number; title: string }>).map((document) => [
        document.id,
        document.title.trim(),
      ])
    );
    if (chunkResults.some((result, index) =>
      Array.isArray(result.data) && result.data.length >= chunkLimits[index]
    )) {
      return { sources: [], degraded: true };
    }
    const chunks = chunkResults.flatMap(
      (result) =>
        (result.data ?? []) as Array<{
          document_id: number | null;
          page_num: number | null;
        }>
    );
    const actualPages = new Set(
      chunks
        .filter(
          (chunk) =>
            Number.isSafeInteger(chunk.document_id) &&
            (chunk.page_num === null ||
              (Number.isSafeInteger(chunk.page_num) && (chunk.page_num ?? 0) > 0))
        )
        .map((chunk) => JSON.stringify([chunk.document_id, chunk.page_num]))
    );
    return {
      sources: requested.filter(
        (source) =>
          documents.get(source.document_id) === source.doc &&
          actualPages.has(JSON.stringify([source.document_id, source.page]))
      ),
      degraded: false,
    };
  } catch (error) {
    console.error(
      "[generate/save] 기본 자료 출처 검증 요청 실패:",
      error instanceof Error ? error.message : error
    );
    return { sources: [], degraded: true };
  }
}

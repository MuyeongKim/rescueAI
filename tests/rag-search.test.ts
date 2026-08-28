import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getQueryEmbedding: vi.fn(),
  toPgVector: vi.fn(),
  expandQuery: vi.fn(),
  ragTableEnabled: vi.fn(),
  assertExternalEmbeddingContract: vi.fn(),
  searchExternalRag: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));

vi.mock("@/lib/embeddings", () => ({
  getQueryEmbedding: mocks.getQueryEmbedding,
  toPgVector: mocks.toPgVector,
}));

vi.mock("@/lib/rag-external", () => ({
  expandQuery: mocks.expandQuery,
  ragTableEnabled: mocks.ragTableEnabled,
  assertExternalEmbeddingContract: mocks.assertExternalEmbeddingContract,
  searchExternalRag: mocks.searchExternalRag,
}));

import { searchContext } from "@/lib/rag";

describe("searchContext 외부 RAG 복구", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.ragTableEnabled.mockReturnValue(true);
    mocks.expandQuery.mockResolvedValue({
      embedText: "확장된 화학보호복 절차 질의",
      keywords: ["점검", "착용", "탈의", "제독"],
    });
    mocks.searchExternalRag.mockResolvedValue({
      contextText: "[실무가이드 p.41]\n화학보호복 착용",
      sources: [],
      matched: 1,
      degraded: false,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("임베딩이 실패해도 null 벡터와 확장 키워드로 외부 검색을 계속한다", async () => {
    mocks.assertExternalEmbeddingContract.mockResolvedValue(undefined);
    mocks.getQueryEmbedding.mockRejectedValue(new Error("embedding timeout"));

    const result = await searchContext("화학보호복 착탈의와 제독", "화학사고", 8);

    expect(mocks.searchExternalRag).toHaveBeenCalledWith(
      "화학보호복 착탈의와 제독",
      null,
      8,
      "화학사고",
      ["점검", "착용", "탈의", "제독"],
      undefined
    );
    expect(result).toMatchObject({ matched: 1, degraded: true });
    expect(console.error).toHaveBeenCalledWith(
      "[rag] 벡터 검색 비활성화, 키워드 검색으로 진행:",
      "embedding timeout"
    );
  });

  it("임베딩이 정상이면 같은 공간의 벡터와 키워드를 함께 전달한다", async () => {
    const embedding = Array.from({ length: 1024 }, () => 0.01);
    mocks.assertExternalEmbeddingContract.mockResolvedValue(undefined);
    mocks.getQueryEmbedding.mockResolvedValue(embedding);

    const result = await searchContext("화학보호복 점검", "화학사고", 5);

    expect(mocks.getQueryEmbedding).toHaveBeenCalledWith("확장된 화학보호복 절차 질의");
    expect(mocks.searchExternalRag).toHaveBeenCalledWith(
      "화학보호복 점검",
      embedding,
      5,
      "화학사고",
      ["점검", "착용", "탈의", "제독"],
      undefined
    );
    expect(result.degraded).toBe(false);
  });

  it("요청 컨텍스트가 없는 평가는 명시한 Supabase 클라이언트를 하위 검색에 전달한다", async () => {
    const evaluationSupabase = {
      from: vi.fn(),
      rpc: vi.fn(),
    } as never;
    const embedding = Array.from({ length: 1024 }, () => 0.01);
    mocks.assertExternalEmbeddingContract.mockResolvedValue(undefined);
    mocks.getQueryEmbedding.mockResolvedValue(embedding);

    await searchContext("화학보호복 점검", "화학사고", 5, {
      supabase: evaluationSupabase,
    });

    expect(mocks.assertExternalEmbeddingContract).toHaveBeenCalledWith(evaluationSupabase);
    expect(mocks.searchExternalRag).toHaveBeenCalledWith(
      "화학보호복 점검",
      embedding,
      5,
      "화학사고",
      ["점검", "착용", "탈의", "제독"],
      evaluationSupabase
    );
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/embeddings", () => ({
  getQueryEmbedding: async () => [0.1], toPgVector: () => "[0.1]",
}));
vi.mock("@/lib/rag-external", () => ({
  ragTableEnabled: () => false,
  expandQuery: async (query: string) => ({ embedText: query, keywords: [] }),
}));

import { searchContext } from "@/lib/rag";

describe("기본 hybrid_search 참고 자료", () => {
  beforeEach(() => vi.clearAllMocks());

  it("답변 컨텍스트에 들어간 모든 페이지와 같은 페이지의 후속 내용이 확인용 출처에 남는다", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      chunk_id: index, document_id: 7, doc_title: "구조 교범", page_num: Math.min(index + 1, 4),
      content: `${"현장 점검 근거 ".repeat(60)}끝에 있는 중요 조건 ${index}`, rrf_score: 1,
    }));
    mocks.rpc.mockResolvedValue({ data: rows, error: null });
    const result = await searchContext("구조 장비 점검");
    expect(result.sources.map((source) => source.page)).toEqual([1, 2, 3, 4]);
    expect(result.sources.find((source) => source.page === 4)?.content).toContain("중요 조건 3");
    expect(result.sources.find((source) => source.page === 4)?.content).toContain("중요 조건 4");
    expect(result.matched).toBe(5);
  });

  it("검색 실패와 정상 검색의 근거 없음 상태를 구분한다", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: "statement timeout" } });
      expect((await searchContext("구조 장비 점검")).degraded).toBe(true);
      mocks.rpc.mockResolvedValueOnce({ data: [], error: null });
      expect((await searchContext("존재하지 않는 장비")).degraded ?? false).toBe(false);
    } finally {
      log.mockRestore();
    }
  });
});

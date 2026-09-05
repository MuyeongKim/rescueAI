import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ generateObject: vi.fn(), createClient: vi.fn() }));
vi.mock("ai", () => ({ generateObject: mocks.generateObject }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/llm", () => ({ getChatModel: () => "test-model" }));
vi.mock("@/lib/embeddings", () => ({ toPgVector: () => "[0.1]" }));

import { searchExternalRag } from "@/lib/rag-external";

function fixture() {
  const rows = Array.from({ length: 3 }, (_, index) => ({
    id: `candidate-${index}`,
    content: `${"도르래의 배경 설명입니다. ".repeat(30)}후반부 고유 근거 ${index}. 다만 지정된 적용 조건을 충족해야 한다.`,
    metadata: { source: `도르래 ${index}.pdf`, "Header 2": "도르래 설명", document_id: index + 1, page_num: 20 + index },
  }));
  const rpc = vi.fn((name: string) => Promise.resolve({
    data: name.startsWith("match_") ? rows : [], error: null,
  }));
  return { rows, client: { rpc } };
}

describe("튜터 재순위 호출 계약", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("RERANK", "1");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("실제 모델 호출에 청크 후반부와 예외를 전달하고 반환 번호를 같은 출처에 연결한다", async () => {
    const { rows, client } = fixture();
    mocks.generateObject.mockImplementation(async ({ prompt }: { prompt: string }) => {
      expect(prompt).toContain(`[1] 도르래 1 — 도르래 설명 p.21\n${rows[1].content}`);
      expect(rows[1].content.indexOf("후반부 고유 근거")).toBeGreaterThan(350);
      return { object: { ranked: [1] } };
    });
    const result = await searchExternalRag("도르래 설명", [0.1], 1, "일반구조", [], client as never);
    expect(mocks.generateObject).toHaveBeenCalledTimes(1);
    expect(mocks.generateObject.mock.calls[0][0].abortSignal).toBeInstanceOf(AbortSignal);
    expect(result.sources.map((source) => source.document_id)).toEqual([2]);
    expect(result.contextText).toContain(rows[1].content);
    expect(result.degraded).toBe(false);
  });

  it("잘못된 번호와 중복을 버리고 부족한 선택은 기존 융합 순서로 채운다", async () => {
    const { client } = fixture();
    mocks.generateObject.mockResolvedValue({ object: { ranked: [99, 1, 1, -1, 0.5] } });
    const result = await searchExternalRag("도르래 설명", [0.1], 2, "일반구조", [], client as never);
    expect(mocks.generateObject).toHaveBeenCalledTimes(1);
    expect(result.sources.map((source) => source.document_id)).toEqual([2, 1]);
  });

  it("재순위 모델 실패 시 추가 호출 없이 기존 융합 순서와 원문을 유지한다", async () => {
    const { rows, client } = fixture();
    mocks.generateObject.mockRejectedValue(new Error("rerank timeout"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await searchExternalRag("도르래 설명", [0.1], 1, "일반구조", [], client as never);
    expect(mocks.generateObject).toHaveBeenCalledTimes(1);
    expect(result.sources.map((source) => source.document_id)).toEqual([1]);
    expect(result.contextText).toContain(rows[0].content);
  });

  it("모든 후보가 무관하다는 명시 판정과 빈 선택이 함께 있으면 무관 자료로 채우지 않는다", async () => {
    const { client } = fixture();
    mocks.generateObject.mockResolvedValue({ object: { ranked: [], noRelevantEvidence: true } });
    const result = await searchExternalRag("도르래 설명", [0.1], 1, "일반구조", [], client as never);
    expect(result).toMatchObject({ contextText: "", sources: [], matched: 0, degraded: false });
    expect(mocks.generateObject).toHaveBeenCalledOnce();
  });

  it.each([
    { ranked: [], noRelevantEvidence: false },
    { ranked: [] },
    { ranked: [1], noRelevantEvidence: true },
  ])("빈 선택이나 모순된 응답만으로 근거를 없애지 않는다: %j", async (object) => {
    const { client } = fixture();
    mocks.generateObject.mockResolvedValue({ object });
    const result = await searchExternalRag("도르래 설명", [0.1], 1, "일반구조", [], client as never);
    expect(result.matched).toBe(1);
    expect(result.sources).toHaveLength(1);
  });
});

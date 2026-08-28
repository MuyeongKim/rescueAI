import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  generateObject: vi.fn(),
  getChatModel: vi.fn(),
  getConfiguredEmbeddingContract: vi.fn(),
  getQueryEmbedding: vi.fn(),
  toPgVector: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));

vi.mock("ai", () => ({
  generateObject: mocks.generateObject,
}));

vi.mock("@/lib/llm", () => ({
  getChatModel: mocks.getChatModel,
}));

vi.mock("@/lib/embeddings", () => ({
  getConfiguredEmbeddingContract: mocks.getConfiguredEmbeddingContract,
  getQueryEmbedding: mocks.getQueryEmbedding,
  toPgVector: mocks.toPgVector,
}));

import {
  fetchExternalRagContext,
  MAX_KEYWORD_SEARCH_QUERIES,
  searchExternalRag,
} from "@/lib/rag-external";

type RagRow = {
  id: string;
  content: string;
  metadata: {
    source: string;
    document_id: number;
    page_num: number;
    "Header 2": string;
  };
};

type QueryRecord = {
  table: string;
  index: number;
  eqs: Array<[column: string, value: unknown]>;
  keyword?: string;
  limit?: number;
};

type QueryResponse = {
  data: unknown[];
  error: { message: string } | null;
};

const TOPIC =
  "화학보호복 등급 선정과 착용 전 점검·착의·탈의·오염통제, 이상 시 중단·보고";
const CHEMICAL_CHECK_TOPIC = "화학보호복 착용 전 점검";
const DRONE_TOPIC = "소방드론 비행 전 기체·배터리·현장 환경 점검";
const GOOGLE_CONTRACT = {
  provider: "google",
  model: "gemini-embedding-001",
  dimensions: 1024,
  version: "google-retrieval-v1",
};

function row(index: number, overrides: Partial<RagRow> = {}): RagRow {
  return {
    id: `row-${index}`,
    content: `화학보호복 절차 성공 근거 ${index}. 현장 대원이 즉시 확인할 수 있도록 충분히 긴 안전 교육 문장입니다.`,
    metadata: {
      source: "화학사고 실무가이드.pdf",
      document_id: index + 1,
      page_num: 40 + index,
      "Header 2": "화학보호복 절차",
    },
    ...overrides,
  };
}

function droneRow(index: number): RagRow {
  return row(index, {
    content: `소방드론 비행 전에는 기체와 프로펠러, 배터리 상태 및 기상·비행 환경을 점검한다. 현장 안전 운용 근거 ${index}.`,
    metadata: {
      source: "재난현장 소방드론 운용절차.pdf",
      document_id: 15,
      page_num: 20 + index,
      "Header 2": "비행 전 점검",
    },
  });
}

function crossTopicChemicalRow(): RagRow {
  return row(269, {
    id: "cross-topic-p269",
    content:
      "화학보호복 착용 전에는 보호복과 장갑의 손상 여부를 점검하고 착용 순서를 확인한다. 현장 대원이 즉시 확인할 수 있도록 충분히 긴 절차 문장이다.",
    metadata: {
      source: "화학사고 실무가이드.pdf",
      document_id: 15,
      page_num: 269,
      "Header 2": "11. 방사능 물질 회수 및 인명구조",
    },
  });
}

function chemicalTitleRow(): RagRow {
  return row(41, {
    id: "chemical-title-p41",
    content:
      "화학보호복 착용 전에는 보호복과 장갑의 손상, 기밀 상태를 점검하고 2인 1조로 확인한다. 현장 대원이 즉시 확인할 수 있도록 충분히 긴 절차 문장이다.",
    metadata: {
      source: "화학사고 실무가이드.pdf",
      document_id: 15,
      page_num: 41,
      "Header 2": "화학보호복 착용",
    },
  });
}

function hasCategoryFilter(record: QueryRecord, category: string): boolean {
  return record.eqs.some(
    ([column, value]) => column === "metadata->>edu_category" && value === category
  );
}

function createSupabaseMock(
  respond: (record: QueryRecord) => QueryResponse
): { client: { from: ReturnType<typeof vi.fn>; rpc: ReturnType<typeof vi.fn> }; records: QueryRecord[] } {
  const records: QueryRecord[] = [];
  const from = vi.fn((table: string) => {
    const record: QueryRecord = {
      table,
      index: records.length,
      eqs: [],
    };
    records.push(record);

    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn((column: string, value: unknown) => {
        record.eqs.push([column, value]);
        return builder;
      }),
      textSearch: vi.fn((_column: string, keyword: string) => {
        record.keyword = keyword;
        return builder;
      }),
      limit: vi.fn((limit: number) => {
        record.limit = limit;
        return builder;
      }),
      then: <TResult1 = QueryResponse, TResult2 = never>(
        onFulfilled?: ((value: QueryResponse) => TResult1 | PromiseLike<TResult1>) | null,
        onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
      ): Promise<TResult1 | TResult2> =>
        Promise.resolve(respond(record)).then(onFulfilled, onRejected),
    };
    return builder;
  });
  const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
  return { client: { from, rpc }, records };
}

const previousRerank = process.env.RERANK;
const previousQueryExpansion = process.env.QUERY_EXPANSION;

describe("searchExternalRag Supabase I/O 계약", () => {
  beforeAll(() => {
    process.env.RERANK = "0";
    process.env.QUERY_EXPANSION = "0";
  });

  afterAll(() => {
    if (previousRerank === undefined) delete process.env.RERANK;
    else process.env.RERANK = previousRerank;
    if (previousQueryExpansion === undefined) delete process.env.QUERY_EXPANSION;
    else process.env.QUERY_EXPANSION = previousQueryExpansion;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.toPgVector.mockReturnValue("[0.1]");
    mocks.getConfiguredEmbeddingContract.mockReturnValue(GOOGLE_CONTRACT);
    mocks.getQueryEmbedding.mockResolvedValue([0.1]);
  });

  it("명시적 Supabase 클라이언트가 있으면 쿠키 기반 서버 클라이언트를 만들지 않는다", async () => {
    const supabase = createSupabaseMock((record) => ({
      data: [row(record.index)],
      error: null,
    }));

    const result = await searchExternalRag(
      TOPIC,
      null,
      2,
      "화학사고",
      [],
      supabase.client as never
    );

    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(result.matched).toBeGreaterThan(0);
  });

  it("키워드 질의 수를 제한하고 모든 질의에 활성·분야 필터를 적용한다", async () => {
    const supabase = createSupabaseMock((record) => ({
      data: [row(record.index)],
      error: null,
    }));
    mocks.createClient.mockResolvedValue(supabase.client);

    await searchExternalRag(TOPIC, null, 8, "화학사고");

    const keywordQueries = supabase.records.filter((record) => record.keyword !== undefined);
    expect(keywordQueries.length).toBeGreaterThan(0);
    expect(keywordQueries.length).toBeLessThanOrEqual(MAX_KEYWORD_SEARCH_QUERIES);
    expect(keywordQueries.slice(1).every((query) => (query.limit ?? 0) <= 24)).toBe(true);
    for (const query of keywordQueries) {
      expect(query.eqs).toContainEqual(["is_active", true]);
      expect(query.eqs).toContainEqual(["metadata->>edu_category", "화학사고"]);
    }
  });

  it("분야 제한 후보가 0건이면 같은 검색을 전 분야로 한 번 재시도한다", async () => {
    const supabase = createSupabaseMock((record) => ({
      data: hasCategoryFilter(record, "드론 운용") ? [] : [droneRow(record.index)],
      error: null,
    }));
    supabase.client.rpc.mockImplementation(
      (_fn: string, args: { filter: Record<string, string> }) =>
        Promise.resolve({
          data: args.filter.edu_category ? [] : [droneRow(100)],
          error: null,
        })
    );

    const result = await searchExternalRag(
      DRONE_TOPIC,
      [0.1],
      5,
      "드론 운용",
      [],
      supabase.client as never
    );

    const keywordQueries = supabase.records.filter((record) => record.keyword !== undefined);
    expect(keywordQueries.some((record) => hasCategoryFilter(record, "드론 운용"))).toBe(true);
    expect(keywordQueries.some((record) => !hasCategoryFilter(record, "드론 운용"))).toBe(true);
    expect(supabase.client.rpc).toHaveBeenCalledTimes(2);
    expect(supabase.client.rpc.mock.calls[0]?.[1]?.filter).toEqual({
      edu_category: "드론 운용",
    });
    expect(supabase.client.rpc.mock.calls[1]?.[1]?.filter).toEqual({});
    expect(result.matched).toBeGreaterThan(0);
    expect(result.contextText).toContain("소방드론 비행 전");
    expect(result.degraded).toBe(true);
  });

  it("분야 제한 후보가 있으면 전 분야 재시도를 하지 않는다", async () => {
    const supabase = createSupabaseMock((record) => ({
      data: [droneRow(record.index)],
      error: null,
    }));
    supabase.client.rpc.mockResolvedValue({ data: [droneRow(100)], error: null });

    const result = await searchExternalRag(
      DRONE_TOPIC,
      [0.1],
      5,
      "드론 운용",
      [],
      supabase.client as never
    );

    const keywordQueries = supabase.records.filter((record) => record.keyword !== undefined);
    expect(keywordQueries.length).toBeGreaterThan(0);
    expect(keywordQueries.every((record) => hasCategoryFilter(record, "드론 운용"))).toBe(true);
    expect(supabase.client.rpc).toHaveBeenCalledTimes(1);
    expect(result.matched).toBeGreaterThan(0);
    expect(result.degraded).toBe(false);
  });

  it("자료제작도 분야 후보가 0건이면 동일한 전 분야 폴백으로 근거를 회수한다", async () => {
    const supabase = createSupabaseMock((record) => {
      if (record.table === "rag_embedding_config") {
        return { data: [GOOGLE_CONTRACT], error: null };
      }
      return {
        data: hasCategoryFilter(record, "드론 운용") ? [] : [droneRow(record.index)],
        error: null,
      };
    });
    supabase.client.rpc.mockImplementation(
      (_fn: string, args: { filter: Record<string, string> }) =>
        Promise.resolve({
          data: args.filter.edu_category ? [] : [droneRow(100)],
          error: null,
        })
    );
    mocks.createClient.mockResolvedValue(supabase.client);

    const result = await fetchExternalRagContext("드론 운용", 40, DRONE_TOPIC);

    expect(supabase.client.rpc).toHaveBeenCalledTimes(2);
    expect(result.contextText).toContain("소방드론 비행 전");
    expect(result.sources[0]?.document_id).toBe(15);
    expect(result.degraded).toBe(true);
  });

  it("일부 키워드 질의가 실패해도 성공 결과를 유지하고 degraded를 표시한다", async () => {
    const supabase = createSupabaseMock((record) =>
      record.index === 1
        ? { data: [], error: { message: "temporary PostgREST failure" } }
        : { data: [row(record.index)], error: null }
    );
    mocks.createClient.mockResolvedValue(supabase.client);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const result = await searchExternalRag(TOPIC, null, 4, "화학사고");

      expect(
        supabase.records.filter((record) => record.keyword !== undefined).length
      ).toBeGreaterThan(1);
      expect(result.degraded).toBe(true);
      expect(result.matched).toBeGreaterThan(0);
      expect(result.contextText).toContain("성공 근거");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("topK를 지키고 HTML 엔티티와 내부 대괄호를 정규화한 출처를 반환한다", async () => {
    const rows = Array.from({ length: 6 }, (_, index) =>
      row(index, {
        metadata: {
          source: "교재 &lt;A&gt; [원본].pdf",
          document_id: index + 1,
          page_num: 41 + index,
          "Header 2": "절차 [점검] &amp; 안전",
        },
      })
    );
    const supabase = createSupabaseMock(() => ({ data: rows, error: null }));
    mocks.createClient.mockResolvedValue(supabase.client);

    const result = await searchExternalRag(TOPIC, null, 2, "화학사고");

    expect(result.matched).toBe(2);
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0].doc).toBe("교재 <A> (원본) — 절차 (점검) & 안전");
    expect(result.contextText).toContain(
      "[교재 <A> (원본) — 절차 (점검) & 안전 p.41]"
    );
    expect(result.contextText).not.toMatch(/&(?:lt|gt|amp);|\[원본\]|\[점검\]/);
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });

  it("RRF 첫 행이 본문 단독 교차주제여도 제목-주제 근거를 보호하고 교차주제를 제외한다", async () => {
    const crossTopic = crossTopicChemicalRow();
    const titled = chemicalTitleRow();
    const supabase = createSupabaseMock(() => ({
      data: [crossTopic, titled],
      error: null,
    }));
    supabase.client.rpc.mockResolvedValue({
      data: [crossTopic, titled],
      error: null,
    });

    const result = await searchExternalRag(
      CHEMICAL_CHECK_TOPIC,
      [0.1],
      5,
      "화학사고",
      [],
      supabase.client as never
    );

    expect(result.contextText).toContain("화학보호복 착용 p.41");
    expect(result.contextText).not.toContain("방사능 물질 회수 및 인명구조");
    expect(result.sources.map((source) => source.page)).toContain(41);
    expect(result.sources.map((source) => source.page)).not.toContain(269);
  });

  it("제목-주제 근거가 부족하면 C 후보를 보호하지 않은 채 재순위 fallback으로 살린다", async () => {
    const first = crossTopicChemicalRow();
    const second = row(270, {
      id: "cross-topic-p270",
      content:
        "두 번째 fallback 근거. 화학보호복 착용 전에는 보호복과 장갑의 손상 여부를 점검하고 기밀 상태를 확인한다. 현장 대원이 즉시 확인할 수 있도록 충분히 긴 절차 문장이다.",
      metadata: {
        source: "화학사고 실무가이드.pdf",
        document_id: 15,
        page_num: 270,
        "Header 2": "고층 인명구조",
      },
    });
    const supabase = createSupabaseMock(() => ({ data: [first, second], error: null }));
    supabase.client.rpc.mockResolvedValue({ data: [first, second], error: null });
    mocks.generateObject.mockResolvedValue({ object: { ranked: [1] } });
    process.env.RERANK = "1";

    try {
      const result = await searchExternalRag(
        CHEMICAL_CHECK_TOPIC,
        [0.1],
        1,
        "화학사고",
        [],
        supabase.client as never
      );

      expect(mocks.generateObject).toHaveBeenCalledTimes(1);
      expect(result.matched).toBe(1);
      expect(result.contextText).toContain("고층 인명구조 p.270");
      expect(result.contextText).toContain("두 번째 fallback 근거");
      expect(result.contextText).not.toContain("방사능 물질 회수 및 인명구조");
    } finally {
      process.env.RERANK = "0";
    }
  });

  it("LLM 재순위가 실행돼도 하위주제별 첫 근거를 최종 결과에 보존한다", async () => {
    const supabase = createSupabaseMock((record) => ({
      data: [row(record.index)],
      error: null,
    }));
    mocks.createClient.mockResolvedValue(supabase.client);
    mocks.generateObject.mockResolvedValue({ object: { ranked: [0, 1] } });
    process.env.RERANK = "1";

    try {
      const result = await searchExternalRag(TOPIC, null, 8, "화학사고");

      // recall(0) 다음의 selection·precheck·donning·doffing·decon·emergency 첫 행.
      for (const page of [41, 42, 43, 44, 46, 48]) {
        expect(result.contextText).toContain(`p.${page}]`);
      }
      expect(result.matched).toBe(8);
      expect(mocks.generateObject).toHaveBeenCalledTimes(1);
    } finally {
      process.env.RERANK = "0";
    }
  });
});

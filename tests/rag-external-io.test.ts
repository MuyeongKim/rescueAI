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
  COMMON_SOP_CATEGORY,
  fetchExternalRagContext,
  fetchExternalSopContext,
  MAX_CONCURRENT_KEYWORD_SEARCHES,
  MAX_KEYWORD_SEARCH_QUERIES,
  searchExternalRag,
  sopCategoryScope,
  verifyExternalRagSourceProvenance,
} from "@/lib/rag-external";

type RagRow = {
  id: string;
  content: string;
  metadata: {
    source: string;
    document_id: number;
    page_num: number | null;
    "Header 2": string;
    edu_category?: string;
    document_type?: string;
  };
};

type QueryRecord = {
  table: string;
  index: number;
  eqs: Array<[column: string, value: unknown]>;
  ins: Array<[column: string, values: unknown[]]>;
  isFilters: Array<[column: string, value: unknown]>;
  orFilters: string[];
  keyword?: string;
  keywordColumn?: string;
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
  respond: (record: QueryRecord) => QueryResponse | Promise<QueryResponse>
): { client: { from: ReturnType<typeof vi.fn>; rpc: ReturnType<typeof vi.fn> }; records: QueryRecord[] } {
  const records: QueryRecord[] = [];
  const from = vi.fn((table: string) => {
    const record: QueryRecord = {
      table,
      index: records.length,
      eqs: [],
      ins: [],
      isFilters: [],
      orFilters: [],
    };
    records.push(record);

    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn((column: string, value: unknown) => {
        record.eqs.push([column, value]);
        return builder;
      }),
      in: vi.fn((column: string, values: unknown[]) => {
        record.ins.push([column, values]);
        return builder;
      }),
      is: vi.fn((column: string, value: unknown) => {
        record.isFilters.push([column, value]);
        return builder;
      }),
      or: vi.fn((filter: string) => {
        record.orFilters.push(filter);
        return builder;
      }),
      textSearch: vi.fn((column: string, keyword: string) => {
        record.keywordColumn = column;
        record.keyword = keyword;
        return builder;
      }),
      limit: vi.fn((limit: number) => {
        record.limit = limit;
        return builder;
      }),
      order: vi.fn(() => builder),
      range: vi.fn(() => builder),
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

  it("SOP 검색 범위는 요청 분야에 현장지휘·공통만 보조로 더한다", () => {
    expect(sopCategoryScope("산악")).toEqual(["산악", COMMON_SOP_CATEGORY]);
    expect(sopCategoryScope(COMMON_SOP_CATEGORY)).toEqual([COMMON_SOP_CATEGORY]);
    expect(sopCategoryScope("  ")).toEqual([]);
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

  it("자기소개가 붙어도 실제 장비 근거를 유지하고 다른 장비 후보는 제거한다", async () => {
    const chemical = chemicalTitleRow();
    const unrelated = droneRow(900);
    const supabase = createSupabaseMock(() => ({ data: [unrelated, chemical], error: null }));
    supabase.client.rpc.mockResolvedValue({ data: [unrelated, chemical], error: null });
    const result = await searchExternalRag(
      "신규대원인데 화학보호복 착용 절차를 알려줘", [0.1], 8, "화학사고", [], supabase.client as never
    );
    expect(result.matched).toBe(1);
    expect(result.degraded).toBe(false);
    expect(result.contextText).toContain("화학보호복 착용");
    expect(result.contextText).not.toContain("소방드론");
    expect(supabase.records.some((record) => record.keyword === "화학보호복 착용")).toBe(true);
  });

  it("검색에 제공한 네 번째 페이지와 같은 페이지의 후속 청크도 확인용 출처에 남긴다", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => row(index, {
      content: `화학보호복 착용 절차의 점검과 안전 근거 ${index}. ${"실제 대원이 원문에서 확인해야 하는 충분한 길이의 점검 내용입니다. ".repeat(12)}후속 세부 근거 ${index}`,
      metadata: {
        source: "화학보호복 교범.pdf", document_id: 1, page_num: Math.min(index + 1, 4), "Header 2": "화학보호복 착용",
      },
    }));
    const supabase = createSupabaseMock(() => ({ data: rows, error: null }));
    const result = await searchExternalRag("화학보호복 착용 절차", null, 8, "화학사고", [], supabase.client as never);
    expect(result.matched).toBe(5);
    expect(result.sources.map((source) => source.page)).toEqual([1, 2, 3, 4]);
    expect(result.sources.find((source) => source.page === 4)?.content).toContain("후속 세부 근거 3");
    expect(result.sources.find((source) => source.page === 4)?.content).toContain("후속 세부 근거 4");
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

  it("다중 facet 검색도 Supabase FTS 동시 요청 수를 제한한다", async () => {
    let active = 0;
    let peak = 0;
    const supabase = createSupabaseMock(async (record) => {
      if (record.keyword === undefined) return { data: [], error: null };
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { data: [row(record.index)], error: null };
    });

    await searchExternalRag(TOPIC, null, 8, "화학사고", [], supabase.client as never);

    expect(
      supabase.records.filter((record) => record.keyword !== undefined).length
    ).toBe(MAX_KEYWORD_SEARCH_QUERIES);
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_KEYWORD_SEARCHES);
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

  it("분야 미선택 인명구조사 질문은 문서 근거로 분야를 자동 판정해 벡터 검색한다", async () => {
    const qualificationRow = row(220, {
      id: "rescue-technician-level-2",
      content:
        "인명구조사 2급 실기평가는 기본역량 2개와 구조기술 7개 종목으로 구성되며 준비물, 감점 및 실격 기준을 평가표에서 확인한다.",
      metadata: {
        source: "2022년 인명구조사 2급 실기평가표 개정(최종본).pdf",
        document_id: 220,
        page_num: 4,
        "Header 2": "인명구조사 2급 실기평가 종목",
        edu_category: "일반구조",
      },
    });
    const supabase = createSupabaseMock(() => ({
      data: [qualificationRow],
      error: null,
    }));
    supabase.client.rpc.mockResolvedValue({ data: [qualificationRow], error: null });

    const result = await searchExternalRag(
      "인명구조사 2급 관련 정보?",
      [0.1],
      8,
      null,
      [],
      supabase.client as never
    );

    expect(supabase.client.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.client.rpc.mock.calls[0]?.[1]?.filter).toEqual({
      edu_category: "일반구조",
      source: "2022년 인명구조사 2급 실기평가표 개정(최종본).pdf",
    });
    expect(result.contextText).toContain("인명구조사 2급 실기평가 종목");
    expect(result.sources[0]?.doc).toContain("인명구조사 2급 실기평가표");
  });

  it("자료제작 일반 교재는 분야 후보가 0건이어도 전 분야로 넓히지 않는다", async () => {
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

    const keywordQueries = supabase.records.filter((record) => record.keyword !== undefined);
    expect(keywordQueries.length).toBeGreaterThan(0);
    expect(keywordQueries.every((record) => hasCategoryFilter(record, "드론 운용"))).toBe(
      true
    );
    expect(supabase.client.rpc).toHaveBeenCalledTimes(1);
    expect(result.contextText).toBe("");
    expect(result.sources).toEqual([]);
    expect(result.bindingSources).toEqual([]);
    expect(result.degraded).toBe(true);
  });

  it("SOP 검색은 요청 분야와 현장지휘·공통의 관리자 분류 문서만 별도 조회한다", async () => {
    const sopRow = row(70, {
      content:
        "산악 조난자 수색에서는 수색 구역을 나누고 위치와 진행 상황을 지휘관에게 보고한다. 충분히 긴 현장 절차 근거 문장이다.",
      metadata: {
        source: "산악 현장활동 지침.pdf",
        document_id: 70,
        page_num: 12,
        "Header 2": "조난자 수색과 보고",
      },
    });
    const supabase = createSupabaseMock(() => ({ data: [sopRow], error: null }));

    const result = await fetchExternalSopContext(
      "산악",
      "조난자 수색구역 설정 / 상위 주제: 산악사고 대비 훈련",
      4,
      supabase.client as never
    );

    expect(result.evidence.status).toBe("found");
    expect(result.evidence.sourceLabels[0]).toContain("산악 현장활동 지침");
    expect(result.contextText).toContain("수색 구역");
    const keywordQueries = supabase.records.filter((record) => record.keyword !== undefined);
    expect(keywordQueries.length).toBeGreaterThan(0);
    for (const query of keywordQueries) {
      expect(query.keywordColumn).toBe("sop_search_vector");
      expect(query.ins).toContainEqual([
        "metadata->>document_type",
        ["sop", "operational_guidance"],
      ]);
      expect(query.ins).toContainEqual([
        "metadata->>edu_category",
        ["산악", COMMON_SOP_CATEGORY],
      ]);
    }
  });

  it("요청 분야 근거를 우선하면서 관련 현장지휘·공통 SOP를 보조 근거로 포함한다", async () => {
    const requested = row(74, {
      content:
        "산악 조난자 수색에서는 수색 구역을 나누고 위치와 진행 상황을 지휘관에게 보고한다. 충분히 긴 현장 절차 근거 문장이다.",
      metadata: {
        source: "산악 현장활동 지침.pdf",
        document_id: 74,
        page_num: 12,
        "Header 2": "조난자 수색과 보고",
        edu_category: "산악",
        document_type: "operational_guidance",
      },
    });
    const common = row(75, {
      content:
        "조난자 수색 구역을 설정한 현장은 지휘체계를 유지하고 대원의 위치와 진행 상황을 지휘관에게 보고한다. 충분히 긴 공통 현장 절차 근거 문장이다.",
      metadata: {
        source: "재난현장 표준작전절차.pdf",
        document_id: 75,
        page_num: 20,
        "Header 2": "조난자 수색 지휘와 보고",
        edu_category: COMMON_SOP_CATEGORY,
        document_type: "sop",
      },
    });
    const supabase = createSupabaseMock(() => ({
      // DB 응답 순서와 관계없이 요청 분야가 주 근거, 공통 SOP가 보조 근거여야 한다.
      data: [common, requested],
      error: null,
    }));

    const result = await fetchExternalSopContext(
      "산악",
      "조난자 수색구역 설정 / 상위 주제: 산악사고 대비 훈련",
      4,
      supabase.client as never
    );

    expect(result.evidence.status).toBe("found");
    expect(result.evidence.sourceLabels).toEqual([
      "[산악 현장활동 지침 — 조난자 수색과 보고 p.12]",
      "[재난현장 표준작전절차 — 조난자 수색 지휘와 보고 p.20]",
    ]);
    expect(result.contextText).toContain("공통 현장 절차 근거");
  });

  it("SOP 주제가 본문이 아닌 페이지 제목에만 있어도 통합 검색 후보에서 근거로 채택한다", async () => {
    const headerOnly = row(73, {
      content:
        "면체의 밀착 상태와 용기 압력을 확인하고 이상이 있으면 교관에게 보고한다. 충분히 긴 현장 단계 설명이다.",
      metadata: {
        source: "공기호흡기 현장활동 지침.pdf",
        document_id: 73,
        page_num: 8,
        "Header 2": "공기호흡기 착용",
      },
    });
    const supabase = createSupabaseMock((record) =>
      record.keywordColumn === "sop_search_vector"
        ? { data: [headerOnly], error: null }
        : { data: [], error: null }
    );

    const result = await fetchExternalSopContext(
      "화재",
      "공기호흡기 착용 방법",
      4,
      supabase.client as never
    );

    expect(result.evidence.status).toBe("found");
    expect(result.evidence.sourceLabels).toContain(
      "[공기호흡기 현장활동 지침 — 공기호흡기 착용 p.8]"
    );
  });

  it("같은 분야 지침이어도 주제의 구체 핵심어가 부족하면 SOP 근거로 승격하지 않는다", async () => {
    const unrelated = row(71, {
      content:
        "산악 안전교육은 훈련 전 위험요소를 확인하고 대원 건강상태를 점검한다. 충분히 긴 일반 안전 문장이다.",
      metadata: {
        source: "산악 현장활동 지침.pdf",
        document_id: 71,
        page_num: 3,
        "Header 2": "교육 전 일반 안전관리",
      },
    });
    const supabase = createSupabaseMock(() => ({ data: [unrelated], error: null }));

    const result = await fetchExternalSopContext(
      "산악",
      "조난자 수색구역 설정 / 상위 주제: 산악사고 대비 훈련",
      4,
      supabase.client as never
    );

    expect(result.evidence).toEqual({ status: "not_found", sourceLabels: [] });
    expect(result.contextText).toBe("");
  });

  it("파일명만 주제와 일치하고 해당 페이지가 무관하면 SOP 근거로 승격하지 않는다", async () => {
    const filenameOnly = row(72, {
      content:
        "교육 운영을 위한 정기 훈련 일정과 참석 인원을 기록한다. 교관 배정과 출석부 보관 기준을 안내한다.",
      metadata: {
        source: "산악 조난자 수색 현장활동지침.pdf",
        document_id: 72,
        page_num: 99,
        "Header 2": "정기 교육 운영",
      },
    });
    const supabase = createSupabaseMock(() => ({ data: [filenameOnly], error: null }));

    const result = await fetchExternalSopContext(
      "산악",
      "조난자 수색구역 설정 / 상위 주제: 산악사고 대비 훈련",
      4,
      supabase.client as never
    );

    expect(result.evidence).toEqual({ status: "not_found", sourceLabels: [] });
    expect(result.contextText).toBe("");
  });

  it("SOP 분류 자료가 0건이면 not_found, 조회 장애면 degraded를 구분한다", async () => {
    const empty = createSupabaseMock(() => ({ data: [], error: null }));
    const unavailable = createSupabaseMock(() => ({
      data: [],
      error: { message: "temporary SOP search failure" },
    }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const notFound = await fetchExternalSopContext(
        "산악",
        "조난자 수색구역 설정 / 상위 주제: 산악사고 대비 훈련",
        4,
        empty.client as never
      );
      const degraded = await fetchExternalSopContext(
        "산악",
        "조난자 수색구역 설정 / 상위 주제: 산악사고 대비 훈련",
        4,
        unavailable.client as never
      );

      expect(notFound.evidence).toEqual({ status: "not_found", sourceLabels: [] });
      expect(degraded.evidence).toEqual({ status: "degraded", sourceLabels: [] });
    } finally {
      consoleError.mockRestore();
    }
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

      expect(result.contextText).toContain("[확인 항목: 사전점검]");
      expect(result.contextText).toContain("[확인 항목: 단계별 행동절차]");
      expect(result.contextText).toContain("[확인 항목: 안전·중단 기준]");
      expect(result.matched).toBe(8);
      expect(mocks.generateObject).toHaveBeenCalledTimes(1);
    } finally {
      process.env.RERANK = "0";
    }
  });

  it("저장 시각자료는 실제 RAG 문서 ID·페이지·정규화 라벨이 모두 맞는 출처만 검증한다", async () => {
    const actual = row(7, {
      metadata: {
        source: "화학보호복 교범.pdf",
        document_id: 7,
        page_num: 3,
        "Header 2": "화학보호복 교범",
      },
    });
    const supabase = createSupabaseMock(() => ({ data: [actual], error: null }));

    const result = await verifyExternalRagSourceProvenance(
      [
        { document_id: 7, doc: "화학보호복 교범", page: 3 },
        { document_id: 8, doc: "화학보호복 교범", page: 3 },
        { document_id: 7, doc: "다른 표시 라벨", page: 3 },
      ],
      "화학사고",
      supabase.client as never
    );

    expect(result).toEqual({
      sources: [{ document_id: 7, doc: "화학보호복 교범", page: 3 }],
      degraded: false,
    });
    expect(supabase.records[0].orFilters[0]).toContain(
      "and(metadata->>document_id.eq.7,metadata->>page_num.eq.3)"
    );
    expect(supabase.records[0].orFilters[0]).toContain(
      "and(metadata->>document_id.eq.8,metadata->>page_num.eq.3)"
    );
    expect(supabase.records[0].ins).not.toContainEqual([
      "metadata->>document_id",
      ["7", "8"],
    ]);
    expect(supabase.records[0].eqs).toContainEqual([
      "metadata->>edu_category",
      "화학사고",
    ]);
  });

  it("저장 검증용 본문은 정확히 대조한 출처만 포함하고 동일 행 중복은 제거한다", async () => {
    const verified = row(7, {
      content: "화학보호복 점검 압력 100 kPa는 이 문서에서 직접 확인한 근거입니다.",
      metadata: { source: "화학보호복 교범.pdf", document_id: 7, page_num: 3, "Header 2": "화학보호복 교범" },
    });
    const unrelated = row(8, {
      content: "조작한 라벨과 무관한 문서의 압력 999 kPa는 검증 근거로 포함하면 안 됩니다.",
      metadata: { source: "다른 교범.pdf", document_id: 7, page_num: 3, "Header 2": "다른 교범" },
    });
    const supabase = createSupabaseMock(() => ({ data: [verified, unrelated], error: null }));
    const result = await verifyExternalRagSourceProvenance(
      [{ document_id: 7, doc: "화학보호복 교범", page: 3 }], "화학사고", supabase.client as never, true
    );
    expect(result.degraded).toBe(false);
    expect(result.sources).toEqual([{ document_id: 7, doc: "화학보호복 교범", page: 3 }]);
    expect(result.contextText).toContain("[화학보호복 교범 p.3]");
    expect(result.contextText?.match(/100 kPa/g)).toHaveLength(1);
    expect(result.contextText).not.toContain("999 kPa");
  });

  it.each([undefined, "", "A".repeat(80_001)])("저장 검증 본문이 없거나 상한을 넘으면 불완전 상태로 닫는다", async (content) => {
    const actual = row(7, {
      content: content as string,
      metadata: { source: "화학보호복 교범.pdf", document_id: 7, page_num: 3, "Header 2": "화학보호복 교범" },
    });
    const supabase = createSupabaseMock(() => ({ data: [actual], error: null }));
    const result = await verifyExternalRagSourceProvenance(
      [{ document_id: 7, doc: "화학보호복 교범", page: 3 }], "화학사고", supabase.client as never, true
    );
    expect(result.degraded).toBe(true);
    expect(result.contextText).toBe("");
  });

  it("저장 출처 검증은 공통 분야에서 SOP 유형만 보조 출처로 허용한다", async () => {
    const categorySource = row(76, {
      metadata: {
        source: "산악구조 교범.pdf",
        document_id: 76,
        page_num: 4,
        "Header 2": "조난자 수색",
        edu_category: "산악",
        document_type: "training_material",
      },
    });
    const commonSop = row(77, {
      metadata: {
        source: "재난현장 표준작전절차.pdf",
        document_id: 77,
        page_num: 8,
        "Header 2": "수색 현장 지휘",
        edu_category: COMMON_SOP_CATEGORY,
        document_type: "sop",
      },
    });
    const supabase = createSupabaseMock((record) => {
      const categoryFilter = record.eqs.find(
        ([column]) => column === "metadata->>edu_category"
      )?.[1];
      return {
        data: categoryFilter === COMMON_SOP_CATEGORY ? [commonSop] : [categorySource],
        error: null,
      };
    });

    const result = await verifyExternalRagSourceProvenance(
      [
        { document_id: 76, doc: "산악구조 교범 — 조난자 수색", page: 4 },
        { document_id: 77, doc: "재난현장 표준작전절차 — 수색 현장 지휘", page: 8 },
      ],
      "산악",
      supabase.client as never
    );

    expect(result.sources).toHaveLength(2);
    const commonQuery = supabase.records.find((record) =>
      record.eqs.some(
        ([column, value]) =>
          column === "metadata->>edu_category" && value === COMMON_SOP_CATEGORY
      )
    );
    expect(commonQuery?.ins).toContainEqual([
      "metadata->>document_type",
      ["sop", "operational_guidance"],
    ]);
  });

  it("저장 출처 검증은 공통 일반자료와 타 분야 SOP를 요청 분야 출처로 허용하지 않는다", async () => {
    const commonTraining = row(78, {
      metadata: {
        source: "공통 교육자료.pdf",
        document_id: 78,
        page_num: 2,
        "Header 2": "교육 운영",
        edu_category: COMMON_SOP_CATEGORY,
        document_type: "training_material",
      },
    });
    const otherCategorySop = row(79, {
      metadata: {
        source: "화재 현장활동 지침.pdf",
        document_id: 79,
        page_num: 5,
        "Header 2": "화재 현장 지휘",
        edu_category: "화재",
        document_type: "sop",
      },
    });
    const supabase = createSupabaseMock((record) => {
      const categoryFilter = record.eqs.find(
        ([column]) => column === "metadata->>edu_category"
      )?.[1];
      const sopOnly = record.ins.some(
        ([column]) => column === "metadata->>document_type"
      );
      if (categoryFilter === COMMON_SOP_CATEGORY && !sopOnly) {
        return { data: [commonTraining], error: null };
      }
      if (categoryFilter === "화재") {
        return { data: [otherCategorySop], error: null };
      }
      return { data: [], error: null };
    });

    const result = await verifyExternalRagSourceProvenance(
      [
        { document_id: 78, doc: "공통 교육자료 — 교육 운영", page: 2 },
        { document_id: 79, doc: "화재 현장활동 지침 — 화재 현장 지휘", page: 5 },
      ],
      "산악",
      supabase.client as never
    );

    expect(result).toEqual({ sources: [], degraded: false });
    const queriedCategories = supabase.records.flatMap((record) =>
      record.eqs
        .filter(([column]) => column === "metadata->>edu_category")
        .map(([, value]) => value)
    );
    expect(new Set(queriedCategories)).toEqual(
      new Set(["산악", COMMON_SOP_CATEGORY])
    );
  });

  it("저장 시각자료 RAG 조회 장애는 출처 없음이 아니라 재시도 상태로 구분한다", async () => {
    const supabase = createSupabaseMock(() => ({
      data: [],
      error: { message: "temporary provenance failure" },
    }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(
        verifyExternalRagSourceProvenance(
          [{ document_id: 7, doc: "화학보호복 교범", page: 3 }],
          "화학사고",
          supabase.client as never
        )
      ).resolves.toEqual({ sources: [], degraded: true });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("page=null 출처는 실제 활성 RAG 메타데이터 페이지도 NULL일 때만 인정한다", async () => {
    const actual = row(7, {
      metadata: {
        source: "산악구조 일반지침.pdf",
        document_id: 7,
        page_num: null,
        "Header 2": "산악구조 일반지침",
      },
    });
    const supabase = createSupabaseMock(() => ({ data: [actual], error: null }));

    const result = await verifyExternalRagSourceProvenance(
      [
        { document_id: 7, doc: "산악구조 일반지침", page: null },
        { document_id: 7, doc: "조작한 라벨", page: null },
      ],
      "산악",
      supabase.client as never
    );

    expect(result).toEqual({
      sources: [{ document_id: 7, doc: "산악구조 일반지침", page: null }],
      degraded: false,
    });
    expect(supabase.records[0].orFilters[0]).toContain(
      "and(metadata->>document_id.eq.7,metadata->>page_num.is.null)"
    );
  });

  it("80개 출처도 정확한 문서·페이지 쌍을 20개씩 나눠 검증한다", async () => {
    const sources = Array.from({ length: 80 }, (_, index) => ({
      document_id: index + 1,
      doc: `구조 교범 ${index + 1}`,
      page: index + 101,
    }));
    const actualRows = sources.map((source, index) =>
      row(index + 900, {
        metadata: {
          source: `${source.doc}.pdf`,
          document_id: source.document_id,
          page_num: source.page,
          "Header 2": source.doc,
          edu_category: "산악",
          document_type: "training_material",
        },
      })
    );
    const supabase = createSupabaseMock((record) => {
      const category = record.eqs.find(
        ([column]) => column === "metadata->>edu_category"
      )?.[1];
      return { data: category === "산악" ? actualRows : [], error: null };
    });

    const result = await verifyExternalRagSourceProvenance(
      sources,
      "산악",
      supabase.client as never
    );

    expect(result).toEqual({ sources, degraded: false });
    const requestedCategoryQueries = supabase.records.filter((record) =>
      record.eqs.some(
        ([column, value]) =>
          column === "metadata->>edu_category" && value === "산악"
      )
    );
    expect(requestedCategoryQueries).toHaveLength(4);
    for (const record of requestedCategoryQueries) {
      expect(record.orFilters).toHaveLength(1);
      expect(record.orFilters[0].match(/metadata->>document_id\.eq\./g)).toHaveLength(20);
      expect(record.ins.some(([column]) => column === "metadata->>page_num")).toBe(false);
    }
  });

  it("page=null 주장에 실제 RAG 페이지 번호가 있으면 정확한 문서라도 거절한다", async () => {
    const actual = row(7, {
      metadata: {
        source: "산악구조 일반지침.pdf",
        document_id: 7,
        page_num: 3,
        "Header 2": "산악구조 일반지침",
      },
    });
    const supabase = createSupabaseMock(() => ({ data: [actual], error: null }));

    await expect(
      verifyExternalRagSourceProvenance(
        [{ document_id: 7, doc: "산악구조 일반지침", page: null }],
        "산악",
        supabase.client as never
      )
    ).resolves.toEqual({ sources: [], degraded: false });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const fetchExternalSopContext = vi.fn();
  const verifyExternalRagSourceProvenance = vi.fn();
  return {
    createClient: vi.fn(),
    checkStoredMaterialGrounding: vi.fn().mockResolvedValue({ ok: true }),
    createGenerationRagReader: vi.fn(),
    generationRagReader: {
      fetchSopContext: fetchExternalSopContext,
      verifySourceProvenance: verifyExternalRagSourceProvenance,
    },
    requireApiUser: vi.fn(),
    rateLimit: vi.fn(),
    tooManyRequests: vi.fn(),
    fetchExternalSopContext,
    verifyExternalRagSourceProvenance,
    ragTableEnabled: vi.fn(),
  };
});

vi.mock("@/lib/demo", () => ({ DEMO: false }));
vi.mock("@/lib/generation-grounding-server", () => ({ checkStoredMaterialGrounding: mocks.checkStoredMaterialGrounding }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/supabase/generation-rag", () => ({
  createGenerationRagReader: mocks.createGenerationRagReader,
}));
vi.mock("@/lib/auth", () => ({ requireApiUser: mocks.requireApiUser }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
  tooManyRequests: mocks.tooManyRequests,
}));
vi.mock("@/lib/rag-external", () => ({
  fetchExternalSopContext: mocks.fetchExternalSopContext,
  verifyExternalRagSourceProvenance: mocks.verifyExternalRagSourceProvenance,
  ragTableEnabled: mocks.ragTableEnabled,
}));

import { DELETE, PATCH, POST } from "@/app/api/generate/save/route";
import { verifyNativeDocumentSourceProvenance } from "@/lib/source-provenance";
import {
  SOP_APPLICATION_MARKER,
  SOP_DEGRADED_DISCLOSURE,
  SOP_NOT_FOUND_DISCLOSURE,
  type SopEvidence,
} from "@/lib/sop-evidence";

const VERIFIED_SOP_LABEL = "[산악구조 현장활동 지침 p.3]";

function sopLookupResult(evidence: SopEvidence) {
  return {
    contextText: "",
    sources: [],
    bindingSources: [],
    degraded: evidence.status === "degraded",
    evidence,
  };
}

function makeClient({
  count = 0,
  currentRevision = 3,
  currentExists = true,
  updateRows = [{ id: 12, revision: currentRevision + 1 }],
}: {
  count?: number;
  currentRevision?: number;
  currentExists?: boolean;
  updateRows?: Array<{ id: number; revision: number }>;
} = {}) {
  const countEq = vi.fn().mockResolvedValue({ count, error: null });
  const currentMaybeSingle = vi.fn().mockResolvedValue({
    data: currentExists ? { id: 12, revision: currentRevision } : null,
    error: null,
  });
  const currentOwnerEq = vi.fn(() => ({ maybeSingle: currentMaybeSingle }));
  const currentIdEq = vi.fn(() => ({ eq: currentOwnerEq }));
  const countSelect = vi.fn(() => ({ eq: countEq }));
  const materialSelect = vi.fn((columns: string) =>
    columns === "id, revision" ? { eq: currentIdEq } : countSelect()
  );

  const insertSingle = vi.fn().mockResolvedValue({ data: { id: 31, revision: 1 }, error: null });
  const insertSelect = vi.fn(() => ({ single: insertSingle }));
  const insert = vi.fn(() => ({ select: insertSelect }));

  const updateSelect = vi.fn().mockResolvedValue({ data: updateRows, error: null });
  const updateRevisionEq = vi.fn(() => ({ select: updateSelect }));
  const updateIdEq = vi.fn(() => ({ eq: updateRevisionEq }));
  const update = vi.fn(() => ({ eq: updateIdEq }));

  return {
    from: vi.fn(() => ({ select: materialSelect, insert, update })),
    spies: {
      countSelect,
      materialSelect,
      currentIdEq,
      currentOwnerEq,
      currentMaybeSingle,
      insert,
      update,
      updateIdEq,
      updateRevisionEq,
    },
  };
}

function requestWith(body: unknown, headers?: Record<string, string>): Request {
  return new Request("http://localhost/api/generate/save", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function patchRequestWith(body: unknown, headers?: Record<string, string>): Request {
  return new Request("http://localhost/api/generate/save", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function deleteRequest(id = 12, revision = 3): Request {
  return new Request(
    `http://localhost/api/generate/save?id=${id}&revision=${revision}`,
    { method: "DELETE" }
  );
}

function makeDeleteClient({
  currentRevision = 3,
  currentExists = true,
  deletedRows = [{ id: 12 }],
}: {
  currentRevision?: number;
  currentExists?: boolean;
  deletedRows?: Array<{ id: number }>;
} = {}) {
  const currentMaybeSingle = vi.fn().mockResolvedValue({
    data: currentExists ? { id: 12, revision: currentRevision } : null,
    error: null,
  });
  const currentOwnerEq = vi.fn(() => ({ maybeSingle: currentMaybeSingle }));
  const currentIdEq = vi.fn(() => ({ eq: currentOwnerEq }));
  const select = vi.fn(() => ({ eq: currentIdEq }));

  const deleteSelect = vi.fn().mockResolvedValue({ data: deletedRows, error: null });
  const deleteRevisionEq = vi.fn(() => ({ select: deleteSelect }));
  const deleteOwnerEq = vi.fn(() => ({ eq: deleteRevisionEq }));
  const deleteIdEq = vi.fn(() => ({ eq: deleteOwnerEq }));
  const remove = vi.fn(() => ({ eq: deleteIdEq }));

  return {
    from: vi.fn(() => ({ select, delete: remove })),
    spies: {
      currentIdEq,
      currentOwnerEq,
      currentMaybeSingle,
      remove,
      deleteIdEq,
      deleteOwnerEq,
      deleteRevisionEq,
      deleteSelect,
    },
  };
}

function makePatchClient(stored: Record<string, unknown> | null) {
  const storedMaybeSingle = vi.fn().mockResolvedValue({ data: stored, error: null });
  const storedOwnerEq = vi.fn(() => ({ maybeSingle: storedMaybeSingle }));
  const storedEq = vi.fn(() => ({ eq: storedOwnerEq }));
  const storedSelect = vi.fn(() => ({ eq: storedEq }));

  const profileMaybeSingle = vi.fn().mockResolvedValue({
    data: { full_name: "검증 대원" },
    error: null,
  });
  const profileEq = vi.fn(() => ({ maybeSingle: profileMaybeSingle }));
  const profileSelect = vi.fn(() => ({ eq: profileEq }));

  const updateSelect = vi.fn().mockResolvedValue({ data: [{ id: 12 }], error: null });
  const updateEq = vi.fn(() => ({ select: updateSelect }));
  const update = vi.fn(() => ({ eq: updateEq }));

  return {
    from: vi.fn((table: string) =>
      table === "profiles"
        ? { select: profileSelect }
        : { select: storedSelect, update }
    ),
    spies: { storedSelect, storedEq, storedOwnerEq, storedMaybeSingle, update, profileSelect },
  };
}

function makeNativeProvenanceClient(pageNum: number | null = 3) {
  const filters: Array<[string, string, unknown]> = [];
  const from = vi.fn((table: string) => {
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn((column: string, value: unknown) => {
        filters.push([table, column, value]);
        return builder;
      }),
      in: vi.fn((column: string, value: unknown) => {
        filters.push([table, column, value]);
        return builder;
      }),
      is: vi.fn((column: string, value: unknown) => {
        filters.push([table, column, value]);
        return builder;
      }),
      or: vi.fn((value: string) => {
        filters.push([table, "or", value]);
        return builder;
      }),
      limit: vi.fn(async () =>
        table === "documents"
          ? {
              data: [{ id: 7, title: "화학보호복 교범", category: "화학사고" }],
              error: null,
            }
          : { data: [{ document_id: 7, page_num: pageNum }], error: null }
      ),
    };
    return builder;
  });
  return { from, filters };
}

function expanded(text: string, minimum = 220): string {
  let value = text;
  const filler =
    "교관은 각 단계에서 대원의 역할과 확인 결과를 질문하고, 대원은 관찰한 판단 근거와 수행 결과를 서로 교차 확인한다.";
  while (value.replace(/\s+/g, " ").trim().length < minimum) value += ` ${filler}`;
  return value;
}

function validPlanSections(sopText: string, sourceRef: string) {
  return [
    {
      heading: "훈련목표",
      content: expanded(
        "산악사고 현장에서 역할을 분담하고 위험요인을 확인하며 구조 대상자를 안전하게 인계하는 수행 능력을 기른다.",
        70
      ),
    },
    {
      heading: "훈련내용",
      content: expanded(
        `[도입 · 20분] 현장 조건과 역할을 확인한다. [이론 · 20분] 구조 원칙과 장비 특성을 설명한다. [시범 · 20분] 교관 동작을 관찰한다. [실습 · 40분] 조별로 절차를 반복한다. [평가 · 20분] 수행 결과를 확인한다. ${sopText}`,
        260
      ),
    },
    {
      heading: "필요장비",
      content: expanded(
        `개인보호장비, 통신장비, 구조 로프, 들것과 응급처치 장비를 수량별로 준비하고 사용 전 손상 여부를 점검한다. ${sourceRef}`,
        70
      ),
    },
    {
      heading: "안전관리",
      content: expanded(
        `교관은 추락과 장비 손상 위험을 사전에 확인하고 보호구 착용과 안전구역 통제를 점검한다. 이상 징후나 통신 두절이 발생하면 훈련을 즉시 중단하고 현장지휘자에게 보고한 뒤 안전한 위치로 철수한다. ${sourceRef}`,
        130
      ),
    },
    {
      heading: "훈련평가",
      content: expanded(
        "평가 체크리스트로 역할 확인, 장비 점검, 구조 절차와 상황보고 수행을 관찰한다. 필수 항목을 누락 없이 정확히 수행하면 통과하며, 미달 항목은 교관 강평 후 다시 시연해 기준 충족 여부를 확인한다.",
        120
      ),
    },
  ];
}

function validLessonSections(sopText: string, sourceRef: string) {
  return [
    {
      heading: "학습목표",
      content: expanded(
        "대원은 산악사고의 주요 위험요인을 설명하고 장비 점검, 역할 분담, 환자 고정과 이송 절차를 안전하게 수행할 수 있다.",
        90
      ),
    },
    {
      heading: "도입",
      content: expanded(
        "[도입 · 10분] 실제 출동 상황을 제시하고 대원에게 최초 위험요인과 우선 행동을 질문한다. 답변을 비교해 오늘 학습할 판단 기준을 확인한다.",
        140
      ),
    },
    {
      heading: "핵심이론",
      content: expanded(
        `[핵심이론 · 20분] 지형 확인, 접근로 선정, 역할 분담, 환자 상태 확인과 이송 원칙을 순서대로 설명한다. 각 단계의 판단 조건을 사례와 연결한다. ${sopText}`,
        280
      ),
    },
    {
      heading: "교관시범",
      content: expanded(
        `[교관시범 · 20분] 교관이 장비 외관 점검부터 결착, 상호 확인, 환자 고정과 상황보고까지 천천히 시범한다. 대원이 관찰해야 할 손 위치와 확인 구호를 단계마다 멈춰 설명한다. ${sourceRef}`,
        220
      ),
    },
    {
      heading: "대원실습",
      content: expanded(
        "[대원실습 · 40분] 대원을 조별로 나누어 지휘, 안전, 장비, 환자 역할을 순환한다. 각 조는 준비, 접근, 고정, 이송, 인계 과정을 반복하고 동료 체크리스트로 누락을 기록한다.",
        220
      ),
    },
    {
      heading: "안전유의사항",
      content: expanded(
        `[안전유의 · 15분] 추락, 낙석, 장비 손상과 통신 두절 위험을 확인하고 보호구와 안전구역을 점검한다. 이상 징후가 있으면 즉시 실습을 중단하고 교관에게 보고한 뒤 안전지대로 철수한다. ${sourceRef}`,
        150
      ),
    },
    {
      heading: "정리·평가",
      content: expanded(
        "[정리평가 · 15분] 핵심 절차를 질문하고 조별 수행평가를 실시한다. 평가 체크리스트의 필수 항목을 누락 없이 정확히 수행하면 통과하며, 미달 항목은 교정 후 다시 시연해 기준 충족을 확인한다.",
        200
      ),
    },
  ];
}

function validSlides(sopText: string, sourceRef?: string) {
  const verifiedSourceRef = sourceRef ?? "[화학보호복 교범 p.3]";
  return Array.from({ length: 14 }, (_, index) => {
    const isSafety = index === 12;
    const isSummary = index === 13;
    const first = index === 0;
    const focus = isSafety
      ? "위험요인과 중단·보고 기준"
      : isSummary
        ? "수행평가와 통과 기준"
        : `현장 대응 핵심 단계 ${index + 1}`;
    return {
      title: `${focus}를 확인합니다`,
      bullets: [
        isSafety
          ? "안전구역과 보호장비를 점검하고 위험 징후를 계속 감시합니다."
          : isSummary
            ? "평가 체크리스트로 필수 수행을 확인하고 정확한 통과 기준을 적용합니다."
            : `대원은 ${focus}의 판단 조건과 담당 역할을 현장 구호로 확인합니다.`,
        isSafety
          ? "이상 징후나 통신 두절이 발생하면 즉시 중단·보고하고 안전지대로 철수합니다."
          : "교관 시범을 관찰한 뒤 조별 실습에서 같은 순서로 반복하고 누락을 확인합니다.",
      ],
      notes: expanded(
        `${first ? `${sopText} ` : ""}교관은 이 장의 핵심 판단 조건을 먼저 설명합니다. 대원에게 현장에서 무엇을 먼저 확인할지 질문하고 답변의 근거를 확인합니다. 이어서 올바른 동작을 시범하고 흔한 실수를 비교합니다. 조별 실습에서는 역할과 확인 구호를 관찰합니다. 마지막으로 누락된 행동을 교정하고 다음 단계와 연결합니다.`,
        170
      ),
      layout: isSafety ? "safety" : isSummary ? "summary" : "concept",
      role: isSafety ? "safety" : isSummary ? "summary" : first ? "objectives" : "concept",
      composition: first
        ? "visual-explanation"
        : isSafety
          ? "checklist"
          : isSummary
            ? "summary"
            : "list",
      visual: first
        ? {
            mode: "source-page",
            documentId: 7,
            page: 3,
            sourceRef: verifiedSourceRef,
            altText: "보호복 점검 지점을 보여 주는 원문 교육자료 페이지",
            imageData: "data:image/jpeg;base64,AAAA",
          }
        : { mode: "none" },
      sourceRefs: [verifiedSourceRef],
    };
  });
}

function validSlidesBody(extra: Record<string, unknown> = {}) {
  return {
    kind: "slides",
    category: "화재",
    audience: "일반 대원",
    duration: "2시간",
    topic: "화학보호복 착용",
    title: "화학보호복 교육",
    content: {
      slides: validSlides(SOP_NOT_FOUND_DISCLOSURE),
      sources: [{ document_id: 7, doc: "화학보호복 교범", page: 3 }],
      sourceLabels: ["[화학보호복 교범 p.3]"],
      sopEvidence: { status: "not_found", sourceLabels: [] },
    },
    ...extra,
  };
}

function validFoundContractBody(kind: "plan" | "lesson" | "slides") {
  const common = {
    kind,
    category: "산악",
    audience: "일반 대원",
    duration: "2시간",
    topic: "산악사고 대비 훈련",
    title: "산악사고 대비 훈련",
  };
  const sopText = `${SOP_APPLICATION_MARKER}\n${VERIFIED_SOP_LABEL}`;
  const sopEvidence = { status: "found" as const, sourceLabels: [VERIFIED_SOP_LABEL] };
  if (kind === "plan") {
    return {
      ...common,
      content: {
        sections: validPlanSections(sopText, VERIFIED_SOP_LABEL),
        sources: [
          { document_id: 7, doc: "산악구조 현장활동 지침", page: 3 },
        ],
        sourceLabels: [VERIFIED_SOP_LABEL],
        sopEvidence,
      },
    };
  }
  if (kind === "lesson") {
    return {
      ...common,
      content: {
        sections: validLessonSections(sopText, VERIFIED_SOP_LABEL),
        sources: [
          { document_id: 7, doc: "산악구조 현장활동 지침", page: 3 },
        ],
        sourceLabels: [VERIFIED_SOP_LABEL],
        sopEvidence,
      },
    };
  }
  return {
    ...common,
    content: {
      slides: validSlides(SOP_APPLICATION_MARKER, VERIFIED_SOP_LABEL),
      sources: [
        { document_id: 7, doc: "산악구조 현장활동 지침", page: 3 },
      ],
      sourceLabels: [VERIFIED_SOP_LABEL],
      sopEvidence,
    },
  };
}

describe("기본 documents/chunks 원문 출처 검증", () => {
  it("같은 분야의 실제 문서 제목과 청크 페이지가 모두 맞는 출처만 유지한다", async () => {
    const client = makeNativeProvenanceClient();

    const result = await verifyNativeDocumentSourceProvenance(
      [
        { document_id: 7, doc: "화학보호복 교범", page: 3 },
        { document_id: 7, doc: "조작한 제목", page: 3 },
        { document_id: 7, doc: "화학보호복 교범", page: 99 },
      ],
      "화학사고",
      client as never
    );

    expect(result).toEqual({
      sources: [{ document_id: 7, doc: "화학보호복 교범", page: 3 }],
      degraded: false,
    });
    expect(client.filters).toContainEqual(["documents", "category", "화학사고"]);
    expect(client.filters).toContainEqual(["documents", "status", "processed"]);
  });

  it("page=null은 실제 chunks 페이지도 NULL인 같은 문서만 인정한다", async () => {
    const client = makeNativeProvenanceClient(null);

    const result = await verifyNativeDocumentSourceProvenance(
      [
        { document_id: 7, doc: "화학보호복 교범", page: null },
        { document_id: 8, doc: "화학보호복 교범", page: null },
      ],
      "화학사고",
      client as never
    );

    expect(result).toEqual({
      sources: [{ document_id: 7, doc: "화학보호복 교범", page: null }],
      degraded: false,
    });
    expect(client.filters).toContainEqual([
      "chunks",
      "or",
      "and(document_id.eq.7,page_num.is.null),and(document_id.eq.8,page_num.is.null)",
    ]);
  });

  it("page=null 주장에 실제 chunks 페이지 번호가 있으면 거절한다", async () => {
    const client = makeNativeProvenanceClient(3);

    await expect(
      verifyNativeDocumentSourceProvenance(
        [{ document_id: 7, doc: "화학보호복 교범", page: null }],
        "화학사고",
        client as never
      )
    ).resolves.toEqual({ sources: [], degraded: false });
  });

  it("기본 documents/chunks 출처 80개도 문서·페이지 정확한 쌍으로 나눠 검증한다", async () => {
    const sources = Array.from({ length: 80 }, (_, index) => ({
      document_id: index + 1,
      doc: `구조 교범 ${index + 1}`,
      page: index + 10,
    }));
    const filters: Array<[string, string, unknown]> = [];
    const from = vi.fn((table: string) => {
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        in: vi.fn(() => builder),
        or: vi.fn((value: string) => {
          filters.push([table, "or", value]);
          return builder;
        }),
        limit: vi.fn(async () =>
          table === "documents"
            ? {
                data: sources.map((source) => ({
                  id: source.document_id,
                  title: source.doc,
                  category: "일반구조",
                })),
                error: null,
              }
            : {
                data: sources.map((source) => ({
                  document_id: source.document_id,
                  page_num: source.page,
                })),
                error: null,
              }
        ),
      };
      return builder;
    });

    await expect(
      verifyNativeDocumentSourceProvenance(
        sources,
        "일반구조",
        { from } as never
      )
    ).resolves.toEqual({ sources, degraded: false });

    const chunkPairFilters = filters.filter(([table]) => table === "chunks");
    expect(chunkPairFilters).toHaveLength(4);
    for (const [, , value] of chunkPairFilters) {
      expect(String(value).match(/document_id\.eq\./g)).toHaveLength(20);
    }
  });
});

describe("POST /api/generate/save", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkStoredMaterialGrounding.mockResolvedValue({ ok: true });
    mocks.requireApiUser.mockResolvedValue({ ok: true, user: { id: "user-1" } });
    mocks.rateLimit.mockReturnValue({ ok: true, retryAfterSec: 0 });
    mocks.tooManyRequests.mockReturnValue(new Response("Too Many Requests", { status: 429 }));
    mocks.ragTableEnabled.mockReturnValue(true);
    mocks.createGenerationRagReader.mockReturnValue(mocks.generationRagReader);
    mocks.verifyExternalRagSourceProvenance.mockImplementation(async (sources) => ({
      sources,
      degraded: false,
    }));
    mocks.fetchExternalSopContext.mockResolvedValue(
      sopLookupResult({ status: "not_found", sourceLabels: [] })
    );
  });

  it.each([422, 503] as const)("편집본 기술 수치 검증 %i 실패 시 DB에 쓰지 않는다", async (status) => {
    const client = makeClient();
    mocks.createClient.mockResolvedValue(client);
    mocks.checkStoredMaterialGrounding.mockResolvedValue({ ok: false, status, error: "원문 수치 확인 필요" });
    const response = await POST(requestWith(validSlidesBody()));
    expect(response.status).toBe(status);
    expect(mocks.checkStoredMaterialGrounding).toHaveBeenCalledOnce();
    expect(client.spies.insert).not.toHaveBeenCalled();
    expect(client.spies.update).not.toHaveBeenCalled();
  });

  it("인증 실패 시 잘못된 JSON도 파싱하기 전에 401을 반환한다", async () => {
    mocks.createClient.mockResolvedValue(makeClient());
    mocks.requireApiUser.mockResolvedValue({
      ok: false,
      response: new Response("Unauthorized", { status: 401 }),
    });

    const response = await POST(requestWith("{"));

    expect(response.status).toBe(401);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.createGenerationRagReader).not.toHaveBeenCalled();
  });

  it("레이트리밋 실패 시 JSON을 파싱하지 않고 429를 반환한다", async () => {
    mocks.createClient.mockResolvedValue(makeClient());
    mocks.rateLimit.mockReturnValue({ ok: false, retryAfterSec: 10 });

    const response = await POST(requestWith("{"));

    expect(response.status).toBe(429);
    expect(mocks.tooManyRequests).toHaveBeenCalledWith(10);
    expect(mocks.createGenerationRagReader).not.toHaveBeenCalled();
  });

  it("120KB를 넘는 선언 길이는 인증 후 413으로 거절한다", async () => {
    mocks.createClient.mockResolvedValue(makeClient());
    const response = await POST(
      requestWith(validSlidesBody(), { "Content-Length": String(120 * 1024 + 1) })
    );

    expect(response.status).toBe(413);
  });

  it("교육 시간 합계가 요청 시간과 다르면 외부 조회 전에 저장을 차단한다", async () => {
    const client = makeClient();
    mocks.createClient.mockResolvedValue(client);
    const body = validFoundContractBody("plan");
    body.content.sections[1].content = body.content.sections[1].content.replace(
      "[평가 · 20분]",
      "[평가 · 10분]"
    );

    const response = await POST(requestWith(body));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "generation_quality_invalid",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "time_total_mismatch" }),
      ]),
    });
    expect(mocks.fetchExternalSopContext).not.toHaveBeenCalled();
    expect(client.spies.insert).not.toHaveBeenCalled();
  });

  it("필수 안전·중단 기준이 빠지면 저장을 차단한다", async () => {
    const client = makeClient();
    mocks.createClient.mockResolvedValue(client);
    const body = validFoundContractBody("plan");
    body.content.sections[3].content = expanded(
      "교관은 교육 순서와 조별 역할을 설명하고 대원은 준비한 내용을 차례로 수행한다.",
      130
    );

    const response = await POST(requestWith(body));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "generation_quality_invalid",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "missing_safety" }),
      ]),
    });
    expect(client.spies.insert).not.toHaveBeenCalled();
  });

  it("교육 시간에 비해 슬라이드 수가 부족하면 저장을 차단한다", async () => {
    const client = makeClient();
    mocks.createClient.mockResolvedValue(client);
    const body = validSlidesBody();
    body.content.slides = body.content.slides.slice(0, 13);

    const response = await POST(requestWith(body));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "generation_quality_invalid",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "slide_count" }),
      ]),
    });
    expect(client.spies.insert).not.toHaveBeenCalled();
  });

  it("중복 제목 같은 검토 경고만 있으면 저장을 허용한다", async () => {
    const client = makeClient();
    mocks.createClient.mockResolvedValue(client);
    const body = validFoundContractBody("slides");
    body.content.slides[1].title = body.content.slides[0].title;
    mocks.fetchExternalSopContext.mockResolvedValue(
      sopLookupResult({ status: "found", sourceLabels: [VERIFIED_SOP_LABEL] })
    );

    const response = await POST(requestWith(body));

    expect(response.status).toBe(200);
    expect(client.spies.insert).toHaveBeenCalledOnce();
  });

  it("서버 정규화 뒤 imageData 없이 새 자료를 저장한다", async () => {
    const client = makeClient();
    mocks.createClient.mockResolvedValue(client);

    const response = await POST(requestWith(validSlidesBody()));

    expect(response.status).toBe(200);
    expect(client.spies.insert).toHaveBeenCalledOnce();
    const inserted = client.spies.insert.mock.calls[0][0];
    expect(JSON.stringify(inserted)).not.toContain("imageData");
    expect(inserted).toMatchObject({ user_id: "user-1", kind: "slides" });
    expect(inserted.content.sopEvidence).toEqual({ status: "not_found", sourceLabels: [] });
  });

  it("클라이언트 출처 라벨 대신 서버가 검증한 sources의 라벨만 저장한다", async () => {
    const client = makeClient();
    mocks.createClient.mockResolvedValue(client);
    mocks.fetchExternalSopContext.mockResolvedValue(
      sopLookupResult({ status: "found", sourceLabels: [VERIFIED_SOP_LABEL] })
    );
    const body = validFoundContractBody("plan");
    body.content.sourceLabels = ["[가짜 교육자료 p.999]"];

    const response = await POST(requestWith(body));

    expect(response.status).toBe(200);
    expect(client.spies.insert.mock.calls[0][0].content.sourceLabels).toEqual([
      VERIFIED_SOP_LABEL,
    ]);
  });

  it("source-page 메타데이터 충돌로 안전 폴백된 시각자료는 품질 게이트에서 저장을 막는다", async () => {
    const client = makeClient();
    mocks.createClient.mockResolvedValue(client);
    const body = validSlidesBody();
    body.content.slides[0].visual.documentId = 999;

    const response = await POST(requestWith(body));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "generation_quality_invalid",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "invalid_slide_visual" }),
      ]),
    });
    expect(client.spies.insert).not.toHaveBeenCalled();
  });

  it("visual과 sources를 함께 바꾼 위조 원문 연결은 저장 전에 422로 차단한다", async () => {
    const client = makeClient();
    mocks.createClient.mockResolvedValue(client);
    mocks.verifyExternalRagSourceProvenance.mockResolvedValue({
      sources: [],
      degraded: false,
    });
    const body = validSlidesBody();
    body.content.slides[0].visual.documentId = 99;
    body.content.sources[0].document_id = 99;

    const response = await POST(requestWith(body));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "source_provenance_invalid",
    });
    expect(client.spies.insert).not.toHaveBeenCalled();
  });

  it.each(["plan", "lesson"] as const)(
    "%s의 시각자료 없는 일반 출처도 실제 RAG와 다르면 422로 차단한다",
    async (kind) => {
      const client = makeClient();
      mocks.createClient.mockResolvedValue(client);
      mocks.verifyExternalRagSourceProvenance.mockResolvedValue({
        sources: [],
        degraded: false,
      });
      const body = validFoundContractBody(kind);
      body.content.sources = [
        { document_id: 77, doc: "조작한 교육자료", page: 4 },
      ];

      const response = await POST(requestWith(body));

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        code: "source_provenance_invalid",
      });
      expect(client.spies.insert).not.toHaveBeenCalled();
      expect(mocks.fetchExternalSopContext).not.toHaveBeenCalled();
    }
  );

  it("추적할 수 없는 document_id=0 출처는 DB 조회 전에 422로 차단한다", async () => {
    const client = makeClient();
    mocks.createClient.mockResolvedValue(client);
    const body = validFoundContractBody("plan");
    body.content.sources = [{ document_id: 0, doc: "출처 미상", page: null }];

    const response = await POST(requestWith(body));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "source_provenance_invalid",
    });
    expect(mocks.verifyExternalRagSourceProvenance).not.toHaveBeenCalled();
    expect(client.spies.insert).not.toHaveBeenCalled();
  });

  it("문서 번호 타입이 잘못된 출처도 POST에서 422로 구분한다", async () => {
    const client = makeClient();
    mocks.createClient.mockResolvedValue(client);
    const body = validFoundContractBody("lesson");
    body.content.sources = [
      { document_id: "7" as unknown as number, doc: "산악구조 일반지침", page: 3 },
    ];

    const response = await POST(requestWith(body));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "source_provenance_invalid",
    });
    expect(client.spies.insert).not.toHaveBeenCalled();
  });

  it.each(["plan", "lesson"] as const)(
    "실제 RAG에 page=null로 존재하는 문서 출처는 %s 저장에 유지한다",
    async (kind) => {
      const client = makeClient();
      mocks.createClient.mockResolvedValue(client);
      mocks.fetchExternalSopContext.mockResolvedValue(
        sopLookupResult({ status: "found", sourceLabels: [VERIFIED_SOP_LABEL] })
      );
      const body = validFoundContractBody(kind);
      body.content.sources = [
        { document_id: 7, doc: "산악구조 현장활동 지침", page: 3 },
        { document_id: 7, doc: "산악구조 일반지침", page: null },
      ];

      const response = await POST(requestWith(body));

      expect(response.status).toBe(200);
      expect(client.spies.insert.mock.calls[0][0].content.sources).toEqual(
        body.content.sources
      );
    }
  );

  it.each(["plan", "lesson"] as const)(
    "page=null 주장과 실제 RAG 페이지가 다르면 %s 저장을 422로 차단한다",
    async (kind) => {
      const client = makeClient();
      mocks.createClient.mockResolvedValue(client);
      mocks.verifyExternalRagSourceProvenance.mockResolvedValue({
        sources: [],
        degraded: false,
      });
      const body = validFoundContractBody(kind);
      body.content.sources = [
        { document_id: 7, doc: "산악구조 일반지침", page: null },
      ];

      const response = await POST(requestWith(body));

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        code: "source_provenance_invalid",
      });
      expect(client.spies.insert).not.toHaveBeenCalled();
    }
  );

  it("RAG 출처 재검증 장애 중에는 시각자료를 잃은 채 저장하지 않고 503을 반환한다", async () => {
    mocks.createClient.mockResolvedValue(makeClient());
    mocks.verifyExternalRagSourceProvenance.mockResolvedValue({
      sources: [],
      degraded: true,
    });

    const response = await POST(requestWith(validSlidesBody()));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "source_provenance_unavailable",
    });
  });

  it("검증할 일반 출처가 없는 자료는 외부 RAG 사용 여부와 관계없이 저장을 막는다", async () => {
    const client = makeClient();
    mocks.createClient.mockResolvedValue(client);
    mocks.ragTableEnabled.mockReturnValue(false);
    const body = validSlidesBody();
    body.content.slides[0].visual = { mode: "none" };
    body.content.slides[0].composition = "list";
    body.content.sources = [];
    body.content.sourceLabels = [];

    const response = await POST(requestWith(body));

    expect(response.status).toBe(422);
    expect(mocks.createGenerationRagReader).not.toHaveBeenCalled();
    expect(mocks.fetchExternalSopContext).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      code: "generation_quality_invalid",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "source_validation_unavailable" }),
      ]),
    });
    expect(client.spies.insert).not.toHaveBeenCalled();
  });

  it("sources가 비어 있으면 가짜 sourceLabels와 본문 인용으로도 저장 게이트를 우회할 수 없다", async () => {
    const client = makeClient();
    mocks.createClient.mockResolvedValue(client);
    mocks.ragTableEnabled.mockReturnValue(false);
    const body = validSlidesBody();
    body.content.slides[0].visual = { mode: "none" };
    body.content.slides[0].composition = "list";
    body.content.sources = [];
    body.content.sourceLabels = ["[가짜 교육교범 p.999]"];
    body.content.slides.forEach((slide) => {
      slide.sourceRefs = ["[가짜 교육교범 p.999]"];
    });

    const response = await POST(requestWith(body));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "generation_quality_invalid",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "source_validation_unavailable" }),
      ]),
    });
    expect(mocks.verifyExternalRagSourceProvenance).not.toHaveBeenCalled();
    expect(client.spies.insert).not.toHaveBeenCalled();
  });

  it.each(["plan", "lesson", "slides"] as const)(
    "%s 저장은 서버에서 확인한 SOP 출처와 지정 위치의 적용 표식을 함께 검증한다",
    async (kind) => {
      const client = makeClient();
      mocks.createClient.mockResolvedValue(client);
      mocks.fetchExternalSopContext.mockResolvedValue(
        sopLookupResult({ status: "found", sourceLabels: [VERIFIED_SOP_LABEL] })
      );

      const response = await POST(requestWith(validFoundContractBody(kind)));

      expect(response.status).toBe(200);
      expect(mocks.fetchExternalSopContext).toHaveBeenCalledWith(
        "산악",
        "산악사고 대비 훈련",
        4
      );
      expect(client.spies.insert.mock.calls[0][0].content.sopEvidence).toEqual({
        status: "found",
        sourceLabels: [VERIFIED_SOP_LABEL],
      });
    }
  );

  it("사용자 세션에서 공통 SOP가 누락돼도 생성 Workflow와 같은 서버 reader 결과로 저장한다", async () => {
    const client = makeClient();
    mocks.createClient.mockResolvedValue(client);
    const commonSopLabel = "[재난현장 표준작전절차(SOP) — 들어가는 말 p.261]";
    const serverEvidence = {
      status: "found" as const,
      sourceLabels: [VERIFIED_SOP_LABEL, commonSopLabel],
    };
    mocks.fetchExternalSopContext.mockResolvedValue(
      sopLookupResult(serverEvidence)
    );
    const body = validFoundContractBody("slides");
    body.content.sources.push({
      document_id: 8,
      doc: "재난현장 표준작전절차(SOP) — 들어가는 말",
      page: 261,
    });
    body.content.sourceLabels = serverEvidence.sourceLabels;
    body.content.sopEvidence = serverEvidence;

    const response = await POST(requestWith(body));

    expect(response.status).toBe(200);
    expect(mocks.createGenerationRagReader).toHaveBeenCalledOnce();
    expect(mocks.fetchExternalSopContext).toHaveBeenCalledWith(
      "산악",
      "산악사고 대비 훈련",
      4
    );
    expect(client.spies.insert.mock.calls[0][0].content.sopEvidence).toEqual(
      serverEvidence
    );
  });

  it("클라이언트 SOP 근거가 서버 재조회 결과와 다르면 409로 거절한다", async () => {
    const client = makeClient();
    mocks.createClient.mockResolvedValue(client);
    const body = validFoundContractBody("slides");

    const response = await POST(requestWith(body));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.code).toBe("sop_evidence_conflict");
    expect(client.spies.insert).not.toHaveBeenCalled();
    expect(client.spies.update).not.toHaveBeenCalled();
  });

  it("상태가 같아도 실제 SOP 문서나 페이지가 다르면 409로 거절한다", async () => {
    const client = makeClient();
    mocks.createClient.mockResolvedValue(client);
    mocks.fetchExternalSopContext.mockResolvedValue(
      sopLookupResult({
        status: "found",
        sourceLabels: ["[다른 산악구조 지침 p.9]"],
      })
    );

    const response = await POST(requestWith(validFoundContractBody("slides")));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "sop_evidence_conflict",
    });
    expect(client.spies.insert).not.toHaveBeenCalled();
  });

  it("서버 RAG 검증기를 준비하지 못하면 저장하지 않고 503을 반환한다", async () => {
    const client = makeClient();
    mocks.createClient.mockResolvedValue(client);
    mocks.createGenerationRagReader.mockImplementation(() => {
      throw new Error("missing service key");
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(requestWith(validSlidesBody()));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "source_provenance_unavailable",
    });
    expect(client.spies.insert).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("넓은 주제의 선택 방향까지 포함해 생성 시점과 같은 SOP 검색어를 재구성한다", async () => {
    const client = makeClient();
    mocks.createClient.mockResolvedValue(client);
    mocks.fetchExternalSopContext.mockResolvedValue(
      sopLookupResult({ status: "found", sourceLabels: [VERIFIED_SOP_LABEL] })
    );
    const body = validFoundContractBody("plan");
    body.content.focus = "암벽 접근 및 환자 고정";

    const response = await POST(requestWith(body));

    expect(response.status).toBe(200);
    expect(mocks.fetchExternalSopContext).toHaveBeenCalledWith(
      "산악",
      "암벽 접근 및 환자 고정 / 상위 주제: 산악사고 대비 훈련",
      4
    );
  });

  it("확인된 SOP 출처가 있어도 지정 위치에 연결되지 않으면 422로 거절한다", async () => {
    const client = makeClient();
    mocks.createClient.mockResolvedValue(client);
    mocks.fetchExternalSopContext.mockResolvedValue(
      sopLookupResult({ status: "found", sourceLabels: [VERIFIED_SOP_LABEL] })
    );
    const body = validFoundContractBody("slides");
    body.content.slides[0].sourceRefs = [];

    const response = await POST(requestWith(body));
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(payload.code).toBe("sop_contract_invalid");
    expect(payload.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "missing_sop_reference" })])
    );
    expect(client.spies.insert).not.toHaveBeenCalled();
  });

  it("SOP 근거가 없을 때 고정 확인 안내문이 없으면 422로 거절한다", async () => {
    const client = makeClient();
    mocks.createClient.mockResolvedValue(client);
    const body = validSlidesBody();
    body.content.slides[0].notes = "교관 설명";

    const response = await POST(requestWith(body));
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(payload.code).toBe("sop_contract_invalid");
    expect(payload.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "missing_sop_disclosure" })])
    );
  });

  it("SOP 조회 실패 시 장애 전용 안내문과 degraded 상태를 저장한다", async () => {
    const client = makeClient();
    mocks.createClient.mockResolvedValue(client);
    mocks.fetchExternalSopContext.mockRejectedValue(new Error("temporary failure"));
    const body = validSlidesBody();
    body.content.slides[0].notes = SOP_DEGRADED_DISCLOSURE;
    body.content.sopEvidence = { status: "degraded", sourceLabels: [] };
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(requestWith(body));

    expect(response.status).toBe(200);
    expect(client.spies.insert.mock.calls[0][0].content.sopEvidence).toEqual({
      status: "degraded",
      sourceLabels: [],
    });
    consoleSpy.mockRestore();
  });

  it("SOP 조회 실패를 근거 없음 안내문으로 대체하면 저장을 거절한다", async () => {
    const client = makeClient();
    mocks.createClient.mockResolvedValue(client);
    mocks.fetchExternalSopContext.mockRejectedValue(new Error("temporary failure"));
    const body = validSlidesBody();
    delete body.content.sopEvidence;
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(requestWith(body));
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(payload.code).toBe("sop_contract_invalid");
    expect(payload.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "missing_sop_disclosure" })])
    );
    expect(client.spies.insert).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("NotebookLM 저장은 SOP 재조회와 계약 검사의 대상이 아니다", async () => {
    const client = makeClient();
    mocks.createClient.mockResolvedValue(client);

    const response = await POST(
      requestWith({
        kind: "notebooklm",
        category: "산악",
        topic: "산악사고 대비 훈련",
        title: "NotebookLM 제작 프롬프트",
        content: { prompt: "NotebookLM에서 사용할 충분히 구체적인 제작 프롬프트" },
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.createGenerationRagReader).not.toHaveBeenCalled();
    expect(mocks.fetchExternalSopContext).not.toHaveBeenCalled();
    expect(client.spies.insert).toHaveBeenCalledOnce();
  });

  it("신규 저장은 사용자별 200개 상한에서 409로 차단한다", async () => {
    const client = makeClient({ count: 200 });
    mocks.createClient.mockResolvedValue(client);

    const response = await POST(requestWith(validSlidesBody()));

    expect(response.status).toBe(409);
    expect(client.spies.insert).not.toHaveBeenCalled();
  });

  it("기존 자료 업데이트는 개수 상한 조회 없이 허용한다", async () => {
    const client = makeClient({ count: 200 });
    mocks.createClient.mockResolvedValue(client);

    const response = await POST(requestWith(validSlidesBody({ id: 12, revision: 3 })));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ id: 12, revision: 4 });
    expect(client.spies.update).toHaveBeenCalledOnce();
    expect(client.spies.updateRevisionEq).toHaveBeenCalledWith("revision", 3);
    expect(client.spies.countSelect).not.toHaveBeenCalled();
  });

  it("기존 자료 업데이트에 개정 번호가 없으면 덮어쓰기 요청을 거절한다", async () => {
    const client = makeClient();
    mocks.createClient.mockResolvedValue(client);

    const response = await POST(requestWith(validSlidesBody({ id: 12 })));

    expect(response.status).toBe(400);
    expect(client.spies.currentMaybeSingle).not.toHaveBeenCalled();
    expect(client.spies.update).not.toHaveBeenCalled();
  });

  it("다른 화면이 먼저 저장한 개정 번호이면 RAG 조회 전에 409를 반환한다", async () => {
    const client = makeClient({ currentRevision: 4 });
    mocks.createClient.mockResolvedValue(client);

    const response = await POST(
      requestWith(validSlidesBody({ id: 12, revision: 3 }))
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      code: "material_revision_conflict",
      currentRevision: 4,
    });
    expect(mocks.fetchExternalSopContext).not.toHaveBeenCalled();
    expect(client.spies.update).not.toHaveBeenCalled();
  });

  it("사전 확인 직후 다른 화면이 저장해 CAS가 0행이면 409를 반환한다", async () => {
    const client = makeClient({ currentRevision: 3, updateRows: [] });
    mocks.createClient.mockResolvedValue(client);

    const response = await POST(
      requestWith(validSlidesBody({ id: 12, revision: 3 }))
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "material_revision_conflict",
    });
  });
});

describe("DELETE /api/generate/save", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      ok: true,
      user: { id: "user-1", email: "user1@example.com" },
    });
    mocks.rateLimit.mockReturnValue({ ok: true, retryAfterSec: 0 });
    mocks.tooManyRequests.mockReturnValue(new Response("Too Many Requests", { status: 429 }));
  });

  it("개정 번호가 없는 오래된 삭제 요청을 인증·DB 조회 전에 거절한다", async () => {
    const response = await DELETE(
      new Request("http://localhost/api/generate/save?id=12", { method: "DELETE" })
    );

    expect(response.status).toBe(400);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("다른 화면이 먼저 수정한 저장본은 삭제하지 않고 409를 반환한다", async () => {
    const client = makeDeleteClient({ currentRevision: 4 });
    mocks.createClient.mockResolvedValue(client);

    const response = await DELETE(deleteRequest(12, 3));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      code: "material_revision_conflict",
      currentRevision: 4,
    });
    expect(client.spies.remove).not.toHaveBeenCalled();
  });

  it("개정 확인 직후 저장 경쟁에서 CAS가 0행이면 최신본을 보존한다", async () => {
    const client = makeDeleteClient({ currentRevision: 3, deletedRows: [] });
    mocks.createClient.mockResolvedValue(client);

    const response = await DELETE(deleteRequest(12, 3));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "material_revision_conflict",
    });
    expect(client.spies.deleteIdEq).toHaveBeenCalledWith("id", 12);
    expect(client.spies.deleteOwnerEq).toHaveBeenCalledWith("user_id", "user-1");
    expect(client.spies.deleteRevisionEq).toHaveBeenCalledWith("revision", 3);
  });

  it("소유자와 최신 개정 번호가 모두 맞을 때만 삭제한다", async () => {
    const client = makeDeleteClient();
    mocks.createClient.mockResolvedValue(client);

    const response = await DELETE(deleteRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(client.spies.deleteSelect).toHaveBeenCalledWith("id");
  });
});

describe("PATCH /api/generate/save", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkStoredMaterialGrounding.mockResolvedValue({ ok: true });
    mocks.requireApiUser.mockResolvedValue({
      ok: true,
      user: { id: "user-1", email: "user1@example.com" },
    });
    mocks.rateLimit.mockReturnValue({ ok: true, retryAfterSec: 0 });
    mocks.tooManyRequests.mockReturnValue(new Response("Too Many Requests", { status: 429 }));
    mocks.ragTableEnabled.mockReturnValue(true);
    mocks.createGenerationRagReader.mockReturnValue(mocks.generationRagReader);
    mocks.verifyExternalRagSourceProvenance.mockImplementation(async (sources) => ({
      sources,
      degraded: false,
    }));
    mocks.fetchExternalSopContext.mockResolvedValue(
      sopLookupResult({ status: "found", sourceLabels: [VERIFIED_SOP_LABEL] })
    );
  });

  it("인증 실패 시 잘못된 JSON도 파싱하기 전에 401을 반환한다", async () => {
    const client = makePatchClient(null);
    mocks.createClient.mockResolvedValue(client);
    mocks.requireApiUser.mockResolvedValue({
      ok: false,
      response: new Response("Unauthorized", { status: 401 }),
    });

    const response = await PATCH(patchRequestWith("{"));

    expect(response.status).toBe(401);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.createGenerationRagReader).not.toHaveBeenCalled();
    expect(client.spies.storedSelect).not.toHaveBeenCalled();
  });

  it("공유 요청 본문은 인증 뒤 2KB 상한으로 제한한다", async () => {
    const client = makePatchClient(null);
    mocks.createClient.mockResolvedValue(client);

    const response = await PATCH(
      patchRequestWith({ id: 12, shared: true, padding: "x".repeat(3_000) })
    );

    expect(response.status).toBe(413);
    expect(mocks.createGenerationRagReader).not.toHaveBeenCalled();
    expect(client.spies.storedSelect).not.toHaveBeenCalled();
  });

  it("과거 저장본도 원문 수치 검증에 실패하면 공유하지 않는다", async () => {
    const client = makePatchClient({ id: 12, ...validFoundContractBody("plan") });
    mocks.createClient.mockResolvedValue(client);
    mocks.checkStoredMaterialGrounding.mockResolvedValue({ ok: false, status: 422, error: "원문 수치 확인 필요" });
    const response = await PATCH(patchRequestWith({ id: 12, shared: true }));
    expect(response.status).toBe(422);
    expect(mocks.checkStoredMaterialGrounding).toHaveBeenCalledOnce();
    expect(client.spies.update).not.toHaveBeenCalled();
  });

  it("SOP 근거 상태가 없는 과거 저장본은 새 공유를 422로 막는다", async () => {
    const body = validFoundContractBody("plan");
    delete body.content.sopEvidence;
    const client = makePatchClient({ id: 12, ...body });
    mocks.createClient.mockResolvedValue(client);

    const response = await PATCH(patchRequestWith({ id: 12, shared: true }));
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(payload.code).toBe("sop_revalidation_required");
    expect(mocks.fetchExternalSopContext).not.toHaveBeenCalled();
    expect(client.spies.update).not.toHaveBeenCalled();
  });

  it("필수 훈련 메타데이터가 없는 과거 저장본도 새 공유를 422로 막는다", async () => {
    const body = validFoundContractBody("plan");
    const client = makePatchClient({ id: 12, ...body, duration: null });
    mocks.createClient.mockResolvedValue(client);

    const response = await PATCH(patchRequestWith({ id: 12, shared: true }));
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(payload.code).toBe("sop_revalidation_required");
    expect(mocks.fetchExternalSopContext).not.toHaveBeenCalled();
    expect(client.spies.update).not.toHaveBeenCalled();
  });

  it("저장본의 출처 구조가 잘못됐으면 새 공유를 422로 차단한다", async () => {
    const body = validFoundContractBody("plan");
    body.content.sources = [
      { document_id: 7, doc: "산악구조 일반지침", page: -1 },
    ];
    const client = makePatchClient({ id: 12, ...body });
    mocks.createClient.mockResolvedValue(client);

    const response = await PATCH(patchRequestWith({ id: 12, shared: true }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "source_provenance_invalid",
    });
    expect(mocks.verifyExternalRagSourceProvenance).not.toHaveBeenCalled();
    expect(client.spies.update).not.toHaveBeenCalled();
  });

  it("일반 출처가 없는 저장본은 가짜 sourceLabels가 있어도 새 공유를 차단한다", async () => {
    const body = validFoundContractBody("plan");
    body.content.sources = [];
    body.content.sourceLabels = ["[가짜 교육자료 p.999]"];
    const client = makePatchClient({ id: 12, ...body });
    mocks.createClient.mockResolvedValue(client);

    const response = await PATCH(patchRequestWith({ id: 12, shared: true }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "generation_quality_invalid",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "source_validation_unavailable" }),
      ]),
    });
    expect(mocks.verifyExternalRagSourceProvenance).not.toHaveBeenCalled();
    expect(client.spies.update).not.toHaveBeenCalled();
  });

  it("새 공유는 클라이언트 본문이 아닌 본인 저장 행을 SOP 재검증한 뒤 허용한다", async () => {
    const body = validFoundContractBody("plan");
    const client = makePatchClient({ id: 12, ...body });
    mocks.createClient.mockResolvedValue(client);

    const response = await PATCH(patchRequestWith({ id: 12, shared: true }));

    expect(response.status).toBe(200);
    expect(client.spies.storedSelect).toHaveBeenCalledWith(
      "id, kind, category, audience, duration, topic, title, content"
    );
    expect(client.spies.storedEq).toHaveBeenCalledWith("id", 12);
    expect(client.spies.storedOwnerEq).toHaveBeenCalledWith("user_id", "user-1");
    expect(mocks.fetchExternalSopContext).toHaveBeenCalledWith(
      "산악",
      "산악사고 대비 훈련",
      4
    );
    expect(client.spies.update).toHaveBeenCalledWith({
      shared: true,
      author_name: "검증 대원",
    });
  });

  it("저장 당시 함께 조작된 원문 시각자료 출처는 새 공유 전에 다시 검증해 차단한다", async () => {
    const body = validSlidesBody();
    body.content.slides[0].visual.documentId = 99;
    body.content.sources[0].document_id = 99;
    const client = makePatchClient({ id: 12, ...body });
    mocks.createClient.mockResolvedValue(client);
    mocks.verifyExternalRagSourceProvenance.mockResolvedValue({
      sources: [],
      degraded: false,
    });
    mocks.fetchExternalSopContext.mockResolvedValue(
      sopLookupResult({ status: "not_found", sourceLabels: [] })
    );

    const response = await PATCH(patchRequestWith({ id: 12, shared: true }));
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(payload.code).toBe("source_provenance_invalid");
    expect(client.spies.update).not.toHaveBeenCalled();
    expect(mocks.fetchExternalSopContext).not.toHaveBeenCalled();
  });

  it.each(["plan", "lesson"] as const)(
    "%s의 위조 일반 출처도 새 공유 전에 422로 차단한다",
    async (kind) => {
      const body = validFoundContractBody(kind);
      body.content.sources = [
        { document_id: 77, doc: "조작한 교육자료", page: null },
      ];
      const client = makePatchClient({ id: 12, ...body });
      mocks.createClient.mockResolvedValue(client);
      mocks.verifyExternalRagSourceProvenance.mockResolvedValue({
        sources: [],
        degraded: false,
      });

      const response = await PATCH(patchRequestWith({ id: 12, shared: true }));

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        code: "source_provenance_invalid",
      });
      expect(client.spies.update).not.toHaveBeenCalled();
      expect(mocks.fetchExternalSopContext).not.toHaveBeenCalled();
    }
  );

  it("일반 출처 RAG 재검증 장애 중에는 계획 공유도 fail-closed로 막는다", async () => {
    const body = validFoundContractBody("plan");
    body.content.sources = [
      { document_id: 7, doc: "산악구조 일반지침", page: null },
    ];
    const client = makePatchClient({ id: 12, ...body });
    mocks.createClient.mockResolvedValue(client);
    mocks.verifyExternalRagSourceProvenance.mockResolvedValue({
      sources: [],
      degraded: true,
    });

    const response = await PATCH(patchRequestWith({ id: 12, shared: true }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "source_provenance_unavailable",
    });
    expect(client.spies.update).not.toHaveBeenCalled();
    expect(mocks.fetchExternalSopContext).not.toHaveBeenCalled();
  });

  it("과거 저장본의 visual과 sources 불일치는 정규화로 숨기지 않고 공유를 차단한다", async () => {
    const body = validSlidesBody();
    body.content.slides[0].visual.documentId = 999;
    const client = makePatchClient({ id: 12, ...body });
    mocks.createClient.mockResolvedValue(client);

    const response = await PATCH(patchRequestWith({ id: 12, shared: true }));
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(payload.code).toBe("source_provenance_invalid");
    expect(mocks.verifyExternalRagSourceProvenance).not.toHaveBeenCalled();
    expect(mocks.fetchExternalSopContext).not.toHaveBeenCalled();
    expect(client.spies.update).not.toHaveBeenCalled();
  });

  it("SOP 검색 장애 상태의 저장본은 장애 안내문이 있어도 공유하지 않는다", async () => {
    const body = validSlidesBody();
    body.content.slides[0].notes = SOP_DEGRADED_DISCLOSURE;
    body.content.sopEvidence = { status: "degraded", sourceLabels: [] };
    const client = makePatchClient({ id: 12, ...body });
    mocks.createClient.mockResolvedValue(client);
    mocks.fetchExternalSopContext.mockRejectedValue(new Error("temporary failure"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await PATCH(patchRequestWith({ id: 12, shared: true }));
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(payload.code).toBe("sop_search_unavailable");
    expect(client.spies.update).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("비준수 과거 자료도 공유 해제는 SOP 재검증 없이 허용한다", async () => {
    const client = makePatchClient(null);
    mocks.createClient.mockResolvedValue(client);

    const response = await PATCH(patchRequestWith({ id: 12, shared: false }));

    expect(response.status).toBe(200);
    expect(client.spies.storedSelect).not.toHaveBeenCalled();
    expect(mocks.fetchExternalSopContext).not.toHaveBeenCalled();
    expect(client.spies.update).toHaveBeenCalledWith({ shared: false });
  });

  it("NotebookLM 저장본 공유는 기존처럼 SOP 검증 대상에서 제외한다", async () => {
    const client = makePatchClient({
      id: 12,
      kind: "notebooklm",
      category: "산악",
      topic: "산악사고 대비 훈련",
      title: "NotebookLM 제작 프롬프트",
      content: { prompt: "NotebookLM에서 사용할 충분히 구체적인 제작 프롬프트" },
    });
    mocks.createClient.mockResolvedValue(client);

    const response = await PATCH(patchRequestWith({ id: 12, shared: true }));

    expect(response.status).toBe(200);
    expect(mocks.createGenerationRagReader).not.toHaveBeenCalled();
    expect(mocks.fetchExternalSopContext).not.toHaveBeenCalled();
    expect(client.spies.update).toHaveBeenCalledOnce();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ external: vi.fn(), evidence: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rag-external", () => ({ ragTableEnabled: mocks.external }));
vi.mock("@/lib/supabase/generation-rag", () => ({ createGenerationRagReader: () => ({ verifySourceEvidence: mocks.evidence }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
import { checkStoredMaterialGrounding } from "@/lib/generation-grounding-server";
import { verifyNativeDocumentSourceProvenance } from "@/lib/source-provenance";

const source = { document_id: 7, doc: "장비 교범", page: 3 };
type ServerClient = Parameters<typeof checkStoredMaterialGrounding>[0]["supabase"];
const args = {
  kind: "plan" as const, title: "장비 점검", category: "일반구조", request: {},
  content: { sections: [{ heading: "훈련내용", content: "장비 압력 30 MPa" }], sources: [source] },
  supabase: {} as ServerClient,
};

function nativeClient(content: string | undefined, extra: Array<Record<string, unknown>> = []) {
  const selections: string[] = [], filters: string[] = [];
  const from = vi.fn((table: string) => {
    const builder = {
      select: vi.fn((value: string) => { selections.push(value); return builder; }),
      eq: vi.fn(() => builder), in: vi.fn(() => builder),
      or: vi.fn((value: string) => { filters.push(value); return builder; }),
      limit: vi.fn(async () => ({ error: null, data: table === "documents"
        ? [{ id: 7, title: "장비 교범", category: "일반구조" }]
        : [{ document_id: 7, page_num: 3, content }, ...extra] })),
    };
    return builder;
  });
  return { client: { from } as unknown as ServerClient, selections, filters };
}

beforeEach(() => {
  vi.clearAllMocks(); mocks.external.mockReturnValue(true);
  mocks.evidence.mockResolvedValue({ sources: [source], degraded: false, contextText: "장비 사용압력 30 MPa" });
});

describe("서버 수치 검증의 실제 근거 경계", () => {
  it("브라우저가 준 preview에 위조값이 있어도 서버 원문으로 거절한다", async () => {
    const result = await checkStoredMaterialGrounding({ ...args, content: {
      sections: [{ heading: "훈련내용", content: "압력 99999 MPa" }],
      sources: [{ ...source, preview: "압력 99999 MPa" }],
    } });
    expect(result).toMatchObject({ ok: false, status: 422 });
    expect(mocks.evidence).toHaveBeenCalledWith([source], "일반구조");
  });
  it("정상 원문의 동등 단위는 저장할 수 있다", async () => {
    expect(await checkStoredMaterialGrounding({ ...args, content: {
      ...args.content, sections: [{ heading: "훈련내용", content: "사용압력 300 bar" }],
    } })).toEqual({ ok: true });
  });
  it.each([
    { sources: [source], degraded: true, contextText: "30 MPa" },
    { sources: [source], degraded: false, contextText: "" },
  ])("검색/본문 유실을 검증 성공으로 바꾸지 않는다", async (evidence) => {
    mocks.evidence.mockResolvedValue(evidence);
    expect(await checkStoredMaterialGrounding(args)).toMatchObject({ ok: false, status: 503 });
  });
  it("기술 수치가 있지만 출처가 없거나 다른 페이지라면 차단한다", async () => {
    expect(await checkStoredMaterialGrounding({ ...args, content: { ...args.content, sources: [] } }))
      .toMatchObject({ ok: false, status: 422 });
    mocks.evidence.mockResolvedValue({ sources: [{ ...source, page: 4 }], degraded: false, contextText: "30 MPa" });
    expect(await checkStoredMaterialGrounding(args)).toMatchObject({ ok: false, status: 422 });
  });
  it("정상 훈련 시간만 있는 문서는 불필요한 원문 재조회를 하지 않는다", async () => {
    expect(await checkStoredMaterialGrounding({ ...args, content: { ...args.content,
      sections: [{ heading: "훈련내용", content: "20명, 60분간 실시" }] } })).toEqual({ ok: true });
    expect(mocks.evidence).not.toHaveBeenCalled();
  });
  it("기본 자료는 정확한 문서-페이지 쌍만 조회하고 무관한 본문은 근거에서 제외한다", async () => {
    mocks.external.mockReturnValue(false);
    const native = nativeClient("장비 사용압력 30 MPa", [{ document_id: 8, page_num: 3, content: "다른 장비 99999 MPa" }]);
    expect(await checkStoredMaterialGrounding({ ...args, supabase: native.client })).toEqual({ ok: true });
    expect(native.filters).toEqual(["and(document_id.eq.7,page_num.eq.3)"]);
    expect(native.selections).toContain("document_id, page_num, content");
    const bad = await checkStoredMaterialGrounding({ ...args, supabase: native.client,
      content: { ...args.content, sections: [{ heading: "훈련내용", content: "99999 MPa" }] } });
    expect(bad).toMatchObject({ ok: false, status: 422 });
  });
  it.each([undefined, "가".repeat(80_001)])("기본 자료 본문 누락·과다분량은 불완전 상태로 반환한다", async (content) => {
    const native = nativeClient(content);
    const result = await verifyNativeDocumentSourceProvenance([source], "일반구조", native.client, true);
    expect(result).toMatchObject({ degraded: true, contextText: "" });
  });
  it("기본 원문 청크의 실제 본문과 정확한 문서·페이지를 분리해서 보존한다", async () => {
    const native = nativeClient("첫 번째 원문 문장", [
      { document_id: 7, page_num: 3, content: "두 번째 청크의 원문 문장" },
      { document_id: 7, page_num: 4, content: "요청하지 않은 페이지" },
      { document_id: 8, page_num: 3, content: "요청하지 않은 문서" },
    ]);
    const result = await verifyNativeDocumentSourceProvenance([source], "일반구조", native.client, true);
    expect(result.evidenceChunks).toEqual([
      { source, content: "첫 번째 원문 문장" },
      { source, content: "두 번째 청크의 원문 문장" },
    ]);
  });
});

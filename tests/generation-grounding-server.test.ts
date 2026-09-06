import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ external: vi.fn(), evidence: vi.fn(), review: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rag-external", () => ({ ragTableEnabled: mocks.external }));
vi.mock("@/lib/supabase/generation-rag", () => ({ createGenerationRagReader: () => ({ verifySourceEvidence: mocks.evidence }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/generation-grounding-review", () => ({ reviewGenerationGrounding: mocks.review }));
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
  mocks.review.mockResolvedValue({ ok: true, issues: [] });
});

const decision = {
  title: "이상 시 중단합니다", bullets: ["진행을 중단하고 보고합니다", "동료 확인 후 진행합니다"],
  steps: ["이상 여부", "이상 있음", "이상 없음"], notes: "점검 결과에 따라 행동을 선택합니다.",
  composition: "decision-flow" as const,
  diagram: { kind: "decision" as const, conditionStepIndex: 0, branches: [
    { labelStepIndex: 1, bulletIndices: [0] }, { labelStepIndex: 2, bulletIndices: [1] },
  ] },
};
const legacy = { ...decision, diagram: undefined, composition: "list" as const };
const slideArgs = { ...args, kind: "slides" as const, content: { slides: [legacy, decision, legacy, decision], sources: [source] } };

describe("저장·공유·내보내기의 명시적 도식 근거 검토", () => {
  it("기술 수치가 없어도 도식이 있는 장만 실제 원문과 빠른 모델로 검토한다", async () => {
    expect(await checkStoredMaterialGrounding(slideArgs)).toEqual({ ok: true });
    expect(mocks.evidence).toHaveBeenCalledOnce();
    expect(mocks.review).toHaveBeenCalledWith(expect.objectContaining({
      draft: expect.objectContaining({ slides: [decision, decision] }),
      evidenceText: "장비 사용압력 30 MPa", modelKey: "gemini-flash", timeoutMs: 35_000,
    }));
  });

  it("뒤바뀐 분기 관계의 검토 오류는 원래 덱의 장 번호로 복원한다", async () => {
    const swapped = { ...decision, diagram: { ...decision.diagram, branches: [
      { labelStepIndex: 1, bulletIndices: [1] }, { labelStepIndex: 2, bulletIndices: [0] },
    ] } };
    mocks.review.mockResolvedValue({ ok: false, issues: [{
      code: "unsupported_evidence_claim", path: "slides.1.notes", partIndex: 1,
      excerpt: "이상 있음 → 동료 확인 후 진행합니다", message: "이상이 있을 때 진행한다는 연결은 원문과 충돌합니다.",
    }] });

    const result = await checkStoredMaterialGrounding({ ...slideArgs,
      content: { ...slideArgs.content, slides: [legacy, decision, legacy, swapped] } });

    expect(result).toMatchObject({ ok: false, status: 422, error: expect.stringContaining("4번 슬라이드"), issues: [{ path: "slides.3.notes" }] });
    if (!result.ok) expect(result.issues?.[0]).not.toHaveProperty("partIndex");
  });

  it("도식이 없는 기존 수치 없는 자료는 추가 모델 호출을 하지 않는다", async () => {
    expect(await checkStoredMaterialGrounding({ ...slideArgs, content: { ...slideArgs.content, slides: [legacy] } })).toEqual({ ok: true });
    expect(mocks.evidence).not.toHaveBeenCalled();
    expect(mocks.review).not.toHaveBeenCalled();
  });

  it("불완전한 연결과 출처 없는 도식은 원문·모델 호출 전 거절한다", async () => {
    expect(await checkStoredMaterialGrounding({ ...slideArgs, content: { ...slideArgs.content,
      slides: [{ ...decision, bullets: [decision.bullets[0]] }] } })).toMatchObject({ ok: false, status: 422 });
    expect(await checkStoredMaterialGrounding({ ...slideArgs, content: { ...slideArgs.content, sources: [] } }))
      .toMatchObject({ ok: false, status: 422 });
    expect(mocks.evidence).not.toHaveBeenCalled();
    expect(mocks.review).not.toHaveBeenCalled();
  });

  it("도식 검증용 원문 실패는 모델 호출 없이 불완전 상태를 유지한다", async () => {
    mocks.evidence.mockResolvedValue({ sources: [source], contextText: "부분 원문", degraded: true });
    expect(await checkStoredMaterialGrounding(slideArgs)).toMatchObject({ ok: false, status: 503 });
    expect(mocks.review).not.toHaveBeenCalled();
  });

  it("도식 검토 시간초과·모델 실패·응답 위치 오류는 저장 성공이 되지 않는다", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const error of [new DOMException("timed out", "TimeoutError"), new Error("model unavailable")]) {
        mocks.review.mockRejectedValueOnce(error);
        expect(await checkStoredMaterialGrounding(slideArgs)).toMatchObject({ ok: false, status: 503 });
      }
      mocks.review.mockResolvedValueOnce({ ok: false, issues: [{ code: "unsupported_evidence_claim", path: "slides.99.notes", message: "위치 오류" }] });
      expect(await checkStoredMaterialGrounding(slideArgs)).toMatchObject({ ok: false, status: 503 });
    } finally { log.mockRestore(); }
  });

  it("기본 자료 경로도 기존 사용자 RLS 조회의 원문만 도식 검토에 쓴다", async () => {
    mocks.external.mockReturnValue(false);
    const native = nativeClient("이상 시 중단하고 보고합니다. 이상 없으면 동료 확인 후 진행합니다.");
    expect(await checkStoredMaterialGrounding({ ...slideArgs, supabase: native.client })).toEqual({ ok: true });
    expect(mocks.evidence).not.toHaveBeenCalled();
    expect(native.filters).toEqual(["and(document_id.eq.7,page_num.eq.3)"]);
    expect(mocks.review.mock.calls[0][0].evidenceText).toContain("이상 시 중단하고 보고합니다");
  });
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

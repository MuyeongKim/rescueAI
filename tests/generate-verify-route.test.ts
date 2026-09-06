import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), check: vi.fn(), limit: vi.fn(), provenance: vi.fn(), sop: vi.fn(), external: vi.fn(), reader: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/demo", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/demo")>(), DEMO: false }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/auth", () => ({ requireApiUser: mocks.auth }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.limit, tooManyRequests: () => Response.json({ error: "잠시 후 시도" }, { status: 429 }) }));
vi.mock("@/lib/generation-grounding-server", () => ({ checkStoredMaterialGrounding: mocks.check }));
vi.mock("@/lib/rag-external", () => ({ ragTableEnabled: mocks.external }));
vi.mock("@/lib/supabase/generation-rag", () => ({ createGenerationRagReader: mocks.reader }));
import { POST } from "@/app/api/generate/verify/route";
import { buildDemoGeneration } from "@/lib/demo-generation";

const request = (body: unknown) => new Request("http://localhost/api/generate/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const valid = () => {
  const generated = buildDemoGeneration({ type: "plan", category: "화재", topic: "공기호흡기 점검", audience: "일반 대원", duration: "1시간" });
  return { kind: "plan", title: generated.title, category: "화재", topic: "공기호흡기 점검", content: { ...generated, sources: [{ document_id: 7, doc: "공기호흡기 교범", page: 3 }], sourceLabels: ["[공기호흡기 교범 p.3]"], focus: "착용 전 점검", conditions: "실내 훈련" } };
};
beforeEach(() => {
  vi.clearAllMocks(); mocks.auth.mockResolvedValue({ ok: true, user: { id: "owner" } }); mocks.limit.mockReturnValue({ ok: true }); mocks.check.mockResolvedValue({ ok: true });
  mocks.external.mockReturnValue(true);
  mocks.provenance.mockImplementation(async (sources) => ({ sources, degraded: false }));
  mocks.sop.mockResolvedValue({ evidence: { status: "not_found", sourceLabels: [] } });
  mocks.reader.mockReturnValue({ verifySourceProvenance: mocks.provenance, fetchSopContext: mocks.sop });
});

describe("내보내기 전 실제 출처·SOP·수치 검증 API", () => {
  it("인증·호출 제한을 원문 조회보다 먼저 적용한다", async () => {
    mocks.auth.mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await POST(request(valid()))).status).toBe(401);
    mocks.limit.mockReturnValueOnce({ ok: false });
    expect((await POST(request(valid()))).status).toBe(429);
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.reader).not.toHaveBeenCalled();
  });
  it.each([422, 503])("검증 실패 %i를 성공 응답으로 바꾸지 않는다", async (status) => {
    mocks.check.mockResolvedValue({ ok: false, status, error: "원문 검증 필요", issues: [] });
    const response = await POST(request(valid()));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: "원문 검증 필요" });
  });
  it("정규화한 본문과 현장 조건을 검증하고 검사 범위를 명시한다", async () => {
    const response = await POST(request(valid()));
    expect(await response.json()).toEqual({ ok: true, scope: "source-provenance-sop-and-technical-values" });
    expect(mocks.check).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ conditions: "실내 훈련", focus: "착용 전 점검" }) }));
    expect(mocks.sop).toHaveBeenCalledWith("화재", "착용 전 점검 / 상위 주제: 공기호흡기 점검", 4);
  });
  it.each([
    ["비활성 원본", []],
    ["다른 페이지", [{ document_id: 7, doc: "공기호흡기 교범", page: 4 }]],
    ["다른 제목", [{ document_id: 7, doc: "다른 교범", page: 3 }]],
  ])("기술 수치가 없어도 %s 출처는 다운로드 검증을 통과하지 못한다", async (_name, sources) => {
    mocks.provenance.mockResolvedValue({ sources, degraded: false });
    const body = valid();
    const response = await POST(request(body));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "source_provenance_invalid" });
    expect(mocks.check).not.toHaveBeenCalled();
  });
  it("출처 조회 degraded·예외는 수치가 없어도 실패로 닫는다", async () => {
    mocks.provenance.mockResolvedValueOnce({ sources: valid().content.sources, degraded: true });
    expect((await POST(request(valid()))).status).toBe(503);
    mocks.provenance.mockRejectedValueOnce(new Error("DB offline"));
    expect((await POST(request(valid()))).status).toBe(503);
    expect(mocks.check).not.toHaveBeenCalled();
  });
  it("현재 SOP 상태가 달라지거나 조회할 수 없으면 다운로드를 보류한다", async () => {
    mocks.sop.mockResolvedValueOnce({ evidence: { status: "found", sourceLabels: ["[공기호흡기 SOP p.7]"] } });
    const conflict = await POST(request(valid()));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "sop_evidence_conflict" });
    mocks.sop.mockResolvedValueOnce({ evidence: { status: "degraded", sourceLabels: [] } });
    expect((await POST(request(valid()))).status).toBe(503);
    mocks.sop.mockResolvedValueOnce({ degraded: true, evidence: { status: "found", sourceLabels: ["[공기호흡기 SOP p.7]"] } });
    expect((await POST(request(valid()))).status).toBe(503);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.sop.mockRejectedValueOnce(new Error("SOP offline"));
      expect((await POST(request(valid()))).status).toBe(503);
    } finally { spy.mockRestore(); }
    expect(mocks.check).not.toHaveBeenCalled();
  });
  it("SOP 필수 안내가 빠진 본문은 수치검사 전 거절한다", async () => {
    const body = valid();
    const content = { ...body.content, sections: [{ heading: "훈련내용", content: "교관 행동을 관찰한다." }] };
    const response = await POST(request({ ...body, content }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "sop_contract_invalid" });
    expect(mocks.check).not.toHaveBeenCalled();
  });
  it("주제 누락·빈 출처·잘못된 문서 번호로 SOP나 출처 검사를 건너뛰지 못한다", async () => {
    expect((await POST(request({ ...valid(), topic: undefined }))).status).toBe(400);
    expect((await POST(request({ ...valid(), content: { ...valid().content, sources: [] } }))).status).toBe(422);
    expect((await POST(request({ ...valid(), content: { ...valid().content, sources: [{ document_id: 0, doc: "위조", page: 1 }] } }))).status).toBe(422);
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.reader).not.toHaveBeenCalled();
  });
  it("파손된 본문은 원문 조회 전에 거절한다", async () => {
    expect((await POST(request({ ...valid(), content: { sections: "broken" } }))).status).toBe(400);
    expect(mocks.check).not.toHaveBeenCalled();
  });
});

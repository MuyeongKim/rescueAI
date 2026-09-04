import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), check: vi.fn(), limit: vi.fn() }));
vi.mock("@/lib/demo", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/demo")>(), DEMO: false }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/auth", () => ({ requireApiUser: mocks.auth }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.limit, tooManyRequests: () => Response.json({ error: "잠시 후 시도" }, { status: 429 }) }));
vi.mock("@/lib/generation-grounding-server", () => ({ checkStoredMaterialGrounding: mocks.check }));
import { POST } from "@/app/api/generate/verify/route";
import { buildDemoGeneration } from "@/lib/demo-generation";

const request = (body: unknown) => new Request("http://localhost/api/generate/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const valid = () => {
  const generated = buildDemoGeneration({ type: "plan", category: "화재", topic: "공기호흡기 점검", audience: "일반 대원", duration: "1시간" });
  return { kind: "plan", title: generated.title, category: "화재", content: { ...generated, focus: "착용 전 점검", conditions: "실내 훈련" } };
};
beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ ok: true, user: { id: "owner" } }); mocks.limit.mockReturnValue({ ok: true }); mocks.check.mockResolvedValue({ ok: true }); });

describe("내보내기 전 수치 검증 API", () => {
  it("인증·호출 제한을 원문 조회보다 먼저 적용한다", async () => {
    mocks.auth.mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await POST(request(valid()))).status).toBe(401);
    mocks.limit.mockReturnValueOnce({ ok: false });
    expect((await POST(request(valid()))).status).toBe(429);
    expect(mocks.check).not.toHaveBeenCalled();
  });
  it.each([422, 503])("검증 실패 %i를 성공 응답으로 바꾸지 않는다", async (status) => {
    mocks.check.mockResolvedValue({ ok: false, status, error: "원문 검증 필요", issues: [] });
    const response = await POST(request(valid()));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: "원문 검증 필요" });
  });
  it("정규화한 본문과 현장 조건을 검증하고 검사 범위를 명시한다", async () => {
    const response = await POST(request(valid()));
    expect(await response.json()).toEqual({ ok: true, scope: "technical-values" });
    expect(mocks.check).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ conditions: "실내 훈련", focus: "착용 전 점검" }) }));
  });
  it("파손된 본문은 원문 조회 전에 거절한다", async () => {
    expect((await POST(request({ ...valid(), content: { sections: "broken" } }))).status).toBe(400);
    expect(mocks.check).not.toHaveBeenCalled();
  });
});

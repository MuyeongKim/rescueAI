import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), auth: vi.fn(), complete: vi.fn(), rateLimit: vi.fn(), updateUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/supabase/password-change", () => ({ completeVerifiedPasswordChange: mocks.complete }));
vi.mock("@/lib/auth", () => ({ requireApiPasswordChangeUser: mocks.auth }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit, tooManyRequests: () => new Response("limited", { status: 429 }) }));
vi.mock("@/lib/demo-flag", () => ({ DEMO: false }));
import { POST } from "@/app/api/auth/change-password/route";

const user = { id: "verified-session-user" };
const client = { auth: { updateUser: mocks.updateUser } };
function request(body: unknown = { password: "synthetic-new-password" }, origin = "https://app.example") {
  return new Request("https://app.example/api/auth/change-password", {
    method: "POST", headers: { origin, "sec-fetch-site": origin === "https://app.example" ? "same-origin" : "cross-site", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.createClient.mockResolvedValue(client);
  mocks.auth.mockResolvedValue({ ok: true, user });
  mocks.rateLimit.mockReturnValue({ ok: true });
  mocks.updateUser.mockResolvedValue({ data: { user }, error: null });
  mocks.complete.mockResolvedValue(undefined);
});

describe("비밀번호 변경의 서버 경계", () => {
  it("같은 인증 세션에서 Auth 변경 성공을 확인한 뒤 본인의 완료 상태만 기록한다", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.auth).toHaveBeenCalledWith(client);
    expect(mocks.updateUser).toHaveBeenCalledWith({ password: "synthetic-new-password" });
    expect(mocks.complete).toHaveBeenCalledWith(user);
    expect(mocks.updateUser.mock.invocationCallOrder[0]).toBeLessThan(mocks.complete.mock.invocationCallOrder[0]);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("외부 출처 요청은 인증·Auth 변경 전에 거절한다", async () => {
    expect((await POST(request(undefined, "https://outside.example"))).status).toBe(403);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it.each([401, 403, 503])("인증 가드 거절(%s)을 유지하고 비밀번호를 변경하지 않는다", async (status) => {
    mocks.auth.mockResolvedValue({ ok: false, response: new Response("blocked", { status }) });
    expect((await POST(request())).status).toBe(status);
    expect(mocks.updateUser).not.toHaveBeenCalled(); expect(mocks.complete).not.toHaveBeenCalled();
  });

  it.each([
    { body: { password: "short" }, status: 400 },
    { body: { password: "x".repeat(129) }, status: 400 },
    { body: { password: "x".repeat(2000) }, status: 413 },
    { body: { password: "synthetic-new-password", userId: "another-user" }, status: 400 },
    { body: { password: "synthetic-new-password", must_change_password: false }, status: 400 },
  ])("입력 계약을 벗어난 요청은 Auth 호출 전에 거절한다", async ({ body, status }) => {
    expect((await POST(request(body))).status).toBe(status);
    expect(mocks.updateUser).not.toHaveBeenCalled(); expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("계정의 변경 요청 제한에 걸리면 provider를 호출하지 않는다", async () => {
    mocks.rateLimit.mockReturnValue({ ok: false, retryAfterSec: 60 });
    expect((await POST(request())).status).toBe(429);
    expect(mocks.rateLimit).toHaveBeenCalledWith(`password-change:${user.id}`, 5, 900_000);
    expect(mocks.updateUser).not.toHaveBeenCalled(); expect(mocks.complete).not.toHaveBeenCalled();
  });

  it.each([
    { data: { user: null }, error: { message: "provider-private-error" } },
    { data: { user: { id: "unexpected-user" } }, error: null },
  ])("Auth의 성공한 본인 변경 응답이 없으면 완료 상태를 기록하지 않는다", async (result) => {
    mocks.updateUser.mockResolvedValue(result);
    const response = await POST(request());
    expect(response.status).toBe(400); expect(mocks.complete).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("provider-private-error");
  });

  it("Auth 연결 실패를 완료로 처리하지 않는다", async () => {
    mocks.updateUser.mockRejectedValue(new Error("upstream failed"));
    expect((await POST(request())).status).toBe(503); expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("비밀번호 변경 뒤 완료 저장 실패는 부분 실패로 알린다", async () => {
    mocks.complete.mockRejectedValue(new Error("database failed"));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "password_changed_completion_failed", error: expect.stringContaining("비밀번호는 변경되었지만") });
  });
});

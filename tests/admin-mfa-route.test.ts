import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(), guard: vi.fn(), status: vi.fn(), rateLimit: vi.fn(), enroll: vi.fn(), verify: vi.fn(), unenroll: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/auth", () => ({ requireApiAdminMfaSetup: mocks.guard, getAdminMfaStatus: mocks.status }));
vi.mock("@/lib/demo-flag", () => ({ DEMO: false }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit, tooManyRequests: () => new Response("Too many attempts", { status: 429 }) }));

import { GET, POST } from "@/app/api/auth/admin-mfa/route";

const factorId = "c9c2efda-434b-4906-8595-a4e81a64333a";
const pendingId = "83282a97-4ee0-4a77-ab45-746b244e409a";
const verifiedFactor = { id: factorId, name: "기본 인증 앱", status: "verified" };
const pendingFactor = { id: pendingId, name: "예비 인증 앱", status: "unverified" };
function request(body: unknown, origin = "https://rescue.example.invalid") {
  return new Request("https://rescue.example.invalid/api/auth/admin-mfa", {
    method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createClient.mockResolvedValue({ auth: { mfa: { enroll: mocks.enroll, challengeAndVerify: mocks.verify, unenroll: mocks.unenroll } } });
  mocks.guard.mockResolvedValue({ ok: true, user: { id: "synthetic-admin" } });
  mocks.status.mockResolvedValue({ verified: false, factors: [verifiedFactor] });
  mocks.rateLimit.mockReturnValue({ ok: true, retryAfterSec: 0 });
  mocks.verify.mockResolvedValue({ data: { access_token: "synthetic-private-token", refresh_token: "synthetic-private-refresh" }, error: null });
  mocks.unenroll.mockResolvedValue({ error: null });
});

describe("관리자 MFA API", () => {
  it("관리자 역할 가드 실패 시 인증 수단을 읽거나 변경하지 않는다", async () => {
    mocks.guard.mockResolvedValue({ ok: false, response: new Response("Forbidden", { status: 403 }) });
    expect((await GET()).status).toBe(403);
    expect((await POST(request({ action: "enroll", name: "앱" }))).status).toBe(403);
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.enroll).not.toHaveBeenCalled();
  });

  it("다른 사이트의 변경 요청은 인증 API 호출 전에 차단한다", async () => {
    const result = await POST(request({ action: "verify", factorId, code: "123456" }, "https://attacker.example.invalid"));
    expect(result.status).toBe(403);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it.each([
    { action: "verify", factorId, code: "12345" },
    { action: "verify", factorId, code: "123456", userId: "other-user" },
    { action: "enroll", name: "" },
    { action: "cancel", factorId: "bad-id" },
  ])("잘못된 입력과 권한 관련 추가 필드를 거절한다", async (input) => {
    expect((await POST(request(input))).status).toBe(400);
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("반복 시도는 MFA 제공자를 호출하기 전에 제한한다", async () => {
    mocks.rateLimit.mockReturnValue({ ok: false, retryAfterSec: 30 });
    expect((await POST(request({ action: "verify", factorId, code: "123456" }))).status).toBe(429);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("현재 계정에 없는 인증 수단을 검증하거나 삭제하지 않는다", async () => {
    for (const input of [{ action: "verify", factorId: pendingId, code: "123456" }, { action: "cancel", factorId: pendingId }]) {
      expect((await POST(request(input))).status).toBe(404);
    }
    expect(mocks.verify).not.toHaveBeenCalled(); expect(mocks.unenroll).not.toHaveBeenCalled();
  });

  it("AAL1에서 새 인증 수단을 등록하거나 예비 수단으로 우회 검증하지 않는다", async () => {
    mocks.status.mockResolvedValue({ verified: false, factors: [verifiedFactor, pendingFactor] });
    expect((await POST(request({ action: "enroll", name: "새 앱" }))).status).toBe(403);
    expect((await POST(request({ action: "verify", factorId: pendingId, code: "123456" }))).status).toBe(403);
    expect(mocks.enroll).not.toHaveBeenCalled(); expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("기존 수단이 없는 관리자는 첫 등록을 시작하고 응답을 캐시하지 않는다", async () => {
    mocks.status.mockResolvedValue({ verified: false, factors: [] });
    mocks.enroll.mockResolvedValue({ data: { id: factorId, totp: { qr_code: "data:image/svg+xml;utf-8,synthetic", secret: "synthetic-secret" } }, error: null });
    const response = await POST(request({ action: "enroll", name: "기본 앱" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(mocks.enroll).toHaveBeenCalledWith({ factorType: "totp", friendlyName: "기본 앱", issuer: "RescueAI" });
    expect(await response.json()).toEqual({ enrollment: { factorId, qrCode: "data:image/svg+xml;utf-8,synthetic", secret: "synthetic-secret" } });
  });

  it("AAL2 관리자는 예비 인증 앱을 등록할 수 있다", async () => {
    mocks.status.mockResolvedValue({ verified: true, factors: [verifiedFactor] });
    mocks.enroll.mockResolvedValue({ data: { id: pendingId, totp: { qr_code: "synthetic", secret: "synthetic" } }, error: null });
    expect((await POST(request({ action: "enroll", name: "예비 앱" }))).status).toBe(200);
  });

  it("검증 성공 후 AAL2를 재확인하고 세션과 토큰을 응답하지 않는다", async () => {
    mocks.status.mockResolvedValueOnce({ verified: false, factors: [verifiedFactor] }).mockResolvedValueOnce({ verified: true, factors: [verifiedFactor] });
    const response = await POST(request({ action: "verify", factorId, code: "123456" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.verify).toHaveBeenCalledWith({ factorId, code: "123456" });
    expect(mocks.status).toHaveBeenCalledTimes(2);
  });

  it("인증 실패에 포함된 비밀값과 오류 객체는 외부에 전달하지 않는다", async () => {
    mocks.verify.mockResolvedValue({ error: { message: "private-token-and-code-123456" } });
    const response = await POST(request({ action: "verify", factorId, code: "123456" }));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("private-token-and-code");
  });

  it("현재 검증된 앱을 삭제할 수 없고 미완료 등록만 취소할 수 있다", async () => {
    mocks.status.mockResolvedValue({ verified: true, factors: [verifiedFactor, pendingFactor] });
    expect((await POST(request({ action: "cancel", factorId }))).status).toBe(403);
    expect(mocks.unenroll).not.toHaveBeenCalled();
    expect((await POST(request({ action: "cancel", factorId: pendingId }))).status).toBe(200);
    expect(mocks.unenroll).toHaveBeenCalledWith({ factorId: pendingId });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), redirect: vi.fn(), demo: false }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/demo", () => ({ get DEMO() { return mocks.demo; }, demoUser: { id: "demo" }, demoProfile: { role: "admin", must_change_password: false } }));

import { getUserAndProfile, requireAdminAndProfile, requireAdminMfaSetup, requireApiAdmin, requireApiAdminMfaSetup, requireApiPasswordChangeUser, requireApiUser, requireUserAndProfile } from "@/lib/auth";

const user = { id: "shared-user", email: "synthetic@example.invalid", user_metadata: { role: "admin", aal: "aal2" }, app_metadata: { role: "admin" }, factors: [{ id: "totp-factor", factor_type: "totp", status: "verified" }] };
function client(profile: Record<string, unknown> | null = { role: "user", must_change_password: false, account_ready: true }, error: unknown = null) {
  if (profile && !("account_ready" in profile)) profile = { ...profile, account_ready: true };
  const maybeSingle = vi.fn().mockResolvedValue({ data: profile, error });
  const eq = vi.fn(() => ({ maybeSingle }));
  const auth = {
    getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }),
    getClaims: vi.fn().mockResolvedValue({ data: { claims: { sub: user.id, aal: "aal2" } }, error: null }),
  };
  return { auth, from: vi.fn(() => ({ select: vi.fn(() => ({ eq })) })), maybeSingle, eq };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.demo = false;
  mocks.redirect.mockImplementation((path: string) => { throw new Error(`redirect:${path}`); });
});

describe("인증 가드의 프로필 확인", () => {
  it("같은 공용 계정의 독립 세션을 모두 허용하고 본인 프로필만 확인한다", async () => {
    const first = client(); const second = client();
    const [a, b] = await Promise.all([requireApiUser(first as never), requireApiUser(second as never)]);
    expect(a.ok).toBe(true); expect(b.ok).toBe(true);
    expect(first.eq).toHaveBeenCalledWith("id", user.id);
    expect(second.eq).toHaveBeenCalledWith("id", user.id);
  });

  it.each([false, true])("초기 비밀번호가 미변경인 계정을 관리자 여부(%s)와 무관하게 막는다", async (admin) => {
    const db = client({ role: admin ? "admin" : "user", must_change_password: true });
    mocks.createClient.mockResolvedValue(db);
    const result = admin ? await requireApiAdmin() : await requireApiUser(db as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it.each([
    { profile: null, error: null, status: 403, label: "프로필 누락" },
    { profile: null, error: { code: "57014" }, status: 503, label: "조회 오류" },
    { profile: { role: "admin" }, error: null, status: 503, label: "필수 컬럼 누락" },
  ])("$label 시 사용자·관리자 API 모두 거절한다", async ({ profile, error, status }) => {
    const db = client(profile, error); mocks.createClient.mockResolvedValue(db);
    for (const result of [await requireApiUser(db as never), await requireApiAdmin(), await requireApiPasswordChangeUser(db as never)]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(status);
    }
    await expect(getUserAndProfile()).rejects.toThrow();
  });

  it("네트워크 예외도 성공으로 바꾸지 않는다", async () => {
    const db = client(); db.maybeSingle.mockRejectedValue(new Error("private upstream details"));
    mocks.createClient.mockResolvedValue(db);
    for (const result of [await requireApiUser(db as never), await requireApiAdmin()]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(503);
        expect(await result.response.text()).not.toContain("private upstream details");
      }
    }
  });

  it("비밀번호 변경 전용 가드도 등록 계정만 허용하되 초기 비밀번호 플래그는 예외로 둔다", async () => {
    const db = client({ role: "user", must_change_password: true });
    expect((await requireApiPasswordChangeUser(db as never)).ok).toBe(true);
    db.auth.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const result = await requireApiPasswordChangeUser(db as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("메타데이터의 admin 주장보다 현재 DB 역할을 우선한다", async () => {
    mocks.createClient.mockResolvedValue(client());
    const result = await requireApiAdmin();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
    mocks.createClient.mockResolvedValue(client({ role: "admin", must_change_password: false }));
    expect((await requireApiAdmin()).ok).toBe(true);
  });

  it("페이지는 미들웨어와 별개로 미인증·초기 비밀번호 계정을 거절한다", async () => {
    const db = client(); db.auth.getUser.mockResolvedValue({ data: { user: null }, error: null });
    mocks.createClient.mockResolvedValue(db);
    const result = await requireApiUser(db as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
    await expect(requireUserAndProfile()).rejects.toThrow("redirect:/login");
    mocks.createClient.mockResolvedValue(client({ role: "user", must_change_password: true }));
    await expect(requireUserAndProfile()).rejects.toThrow("redirect:/change-password");
  });

  it.each([false, undefined])("발급 준비 상태(%s)가 확인되지 않으면 비밀번호 변경을 포함한 접근을 막는다", async (accountReady) => {
    const db = client({ role: "admin", must_change_password: false, account_ready: accountReady });
    mocks.createClient.mockResolvedValue(db);
    for (const result of [await requireApiUser(db as never), await requireApiAdmin(), await requireApiPasswordChangeUser(db as never), await requireApiAdminMfaSetup(db as never)]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect([403, 503]).toContain(result.response.status);
    }
  });

  it("AAL1 관리자는 MFA 등록과 일반 기능만 이용하고 관리자 API와 페이지는 차단된다", async () => {
    const db = client({ role: "admin", must_change_password: false });
    db.auth.getClaims.mockResolvedValue({ data: { claims: { sub: user.id, aal: "aal1" } }, error: null });
    mocks.createClient.mockResolvedValue(db);
    expect((await requireApiAdminMfaSetup(db as never)).ok).toBe(true);
    expect((await requireApiUser(db as never)).ok).toBe(true);
    expect((await requireAdminMfaSetup()).user?.id).toBe(user.id);
    const result = await requireApiAdmin(db as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect(result.response.headers.get("X-Admin-MFA-Required")).toBe("true");
    }
    await expect(requireAdminAndProfile()).rejects.toThrow("redirect:/admin-mfa");
  });

  it("서명 검증 실패 또는 다른 계정의 AAL2 주장을 허용하지 않는다", async () => {
    const db = client({ role: "admin", must_change_password: false });
    mocks.createClient.mockResolvedValue(db);
    for (const result of [
      { data: { claims: { sub: "different-user", aal: "aal2" } }, error: null },
      { data: null, error: { message: "private token content" } },
    ]) {
      db.auth.getClaims.mockResolvedValue(result);
      const access = await requireApiAdmin(db as never);
      expect(access.ok).toBe(false);
      if (!access.ok) { expect(access.response.status).toBe(503); expect(await access.response.text()).not.toContain("private token content"); }
    }
  });

  it("등록 수단이 삭제되면 남은 AAL2 토큰만으로 관리 API를 허용하지 않는다", async () => {
    const db = client({ role: "admin", must_change_password: false });
    db.auth.getUser.mockResolvedValue({ data: { user: { ...user, factors: [] } }, error: null });
    const access = await requireApiAdmin(db as never);
    expect(access.ok).toBe(false);
    if (!access.ok) expect(access.response.status).toBe(403);
  });

  it("검증된 AAL2 관리자는 API와 페이지를 이용한다", async () => {
    const db = client({ role: "admin", must_change_password: false });
    mocks.createClient.mockResolvedValue(db);
    expect((await requireApiAdmin(db as never)).ok).toBe(true);
    expect((await requireAdminAndProfile()).user?.id).toBe(user.id);
  });
});

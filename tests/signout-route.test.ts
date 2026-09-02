import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));

import { POST } from "@/app/auth/signout/route";

describe("POST /auth/signout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.signOut.mockResolvedValue({ error: null });
    mocks.createClient.mockResolvedValue({ auth: { signOut: mocks.signOut } });
  });

  it("같은 계정의 다른 브라우저 세션은 유지하고 현재 세션만 로그아웃한다", async () => {
    const response = await POST(
      new Request("https://example.test/auth/signout", { method: "POST" })
    );

    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://example.test/login");
  });
});

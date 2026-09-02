import { beforeEach, describe, expect, it, vi } from "vitest";

const statsMock = vi.hoisted(() => ({
  data: null as
    | { today_access: number; total_access: number }[]
    | null,
  error: null as { message: string } | null,
  shouldThrow: false,
  rpcName: "",
  signal: null as AbortSignal | null,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/demo-flag", () => ({ DEMO: false }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: (name: string) => {
      statsMock.rpcName = name;
      return {
        abortSignal: async (signal: AbortSignal) => {
          statsMock.signal = signal;
          if (statsMock.shouldThrow) throw new Error("network failure");
          return { data: statsMock.data, error: statsMock.error };
        },
      };
    },
  }),
}));

import { getLoginAccessStats } from "@/lib/login-access-stats";

describe("공용 접속 현황 서버 조회", () => {
  beforeEach(() => {
    statsMock.data = [{ today_access: 5, total_access: 21 }];
    statsMock.error = null;
    statsMock.shouldThrow = false;
    statsMock.rpcName = "";
    statsMock.signal = null;
  });

  it("로그인 화면과 사이드바에 같은 정규화된 수치를 제공한다", async () => {
    await expect(getLoginAccessStats()).resolves.toEqual({
      today: 5,
      total: 21,
    });
    expect(statsMock.rpcName).toBe("get_login_access_stats");
    expect(statsMock.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(["error", "throw"] as const)(
    "통계 조회가 %s여도 화면을 막지 않고 대시 표시용 값을 반환한다",
    async (mode) => {
      statsMock.error = mode === "error" ? { message: "unavailable" } : null;
      statsMock.shouldThrow = mode === "throw";

      await expect(getLoginAccessStats()).resolves.toEqual({
        today: null,
        total: null,
      });
    }
  );
});

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const supabaseMock = vi.hoisted(() => ({
  user: null as { id: string } | null,
  rpcCalls: 0,
  rpcMode: "success" as "success" | "error" | "throw",
  refreshAuthCookie: false,
  signal: null as AbortSignal | null,
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    options: {
      cookies: {
        setAll: (
          cookies: {
            name: string;
            value: string;
            options: Record<string, unknown>;
          }[],
          headers: Record<string, string>
        ) => void;
      };
    }
  ) => ({
    auth: {
      getUser: async () => {
        if (supabaseMock.refreshAuthCookie) {
          options.cookies.setAll(
            [
              {
                name: "sb-test-auth-token",
                value: "refreshed",
                options: { path: "/", sameSite: "lax" },
              },
            ],
            {
              "Cache-Control":
                "private, no-cache, no-store, must-revalidate, max-age=0",
              Expires: "0",
              Pragma: "no-cache",
            }
          );
        }
        return { data: { user: supabaseMock.user } };
      },
    },
    rpc: () => {
      supabaseMock.rpcCalls += 1;
      return {
        abortSignal: async (signal: AbortSignal) => {
          supabaseMock.signal = signal;
          if (supabaseMock.rpcMode === "throw") {
            throw new Error("network failure");
          }
          return {
            error:
              supabaseMock.rpcMode === "error"
                ? { message: "database unavailable" }
                : null,
          };
        },
      };
    },
  }),
}));

vi.mock("@/lib/demo-flag", () => ({ DEMO: false }));

import { middleware } from "@/middleware";

describe("미들웨어 접속 집계", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test";
    supabaseMock.user = null;
    supabaseMock.rpcCalls = 0;
    supabaseMock.rpcMode = "success";
    supabaseMock.refreshAuthCookie = false;
    supabaseMock.signal = null;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T03:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("미인증 보호 경로는 로그인으로 보내고 집계하지 않는다", async () => {
    const response = await middleware(
      new NextRequest("https://rescue.example/home")
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://rescue.example/login?redirect=%2Fhome"
    );
    expect(supabaseMock.rpcCalls).toBe(0);
  });

  it("인증 사용자의 로그인 화면은 홈으로 보내되 로그인 조회를 세지 않는다", async () => {
    supabaseMock.user = { id: "user-1" };
    const response = await middleware(
      new NextRequest("https://rescue.example/login")
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://rescue.example/home"
    );
    expect(supabaseMock.rpcCalls).toBe(0);
  });

  it("오늘 집계 쿠키가 있으면 보호 화면 새로고침을 다시 세지 않는다", async () => {
    supabaseMock.user = { id: "user-1" };
    const response = await middleware(
      new NextRequest("https://rescue.example/home", {
        headers: { cookie: "rescueai-access-day=2026-09-02" },
      })
    );

    expect(response.status).toBe(200);
    expect(supabaseMock.rpcCalls).toBe(0);
  });

  it("첫 보호 화면 진입 성공 시 다음 KST 자정까지 보안 쿠키를 설정한다", async () => {
    supabaseMock.user = { id: "user-1" };
    const response = await middleware(
      new NextRequest("https://rescue.example/home")
    );
    const setCookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(200);
    expect(supabaseMock.rpcCalls).toBe(1);
    expect(supabaseMock.signal).toBeInstanceOf(AbortSignal);
    expect(setCookie).toContain("rescueai-access-day=2026-09-02");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=43200");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=lax");
  });

  it.each(["error", "throw"] as const)(
    "집계 RPC가 %s여도 보호 화면은 열고 쿠키는 남기지 않는다",
    async (rpcMode) => {
      supabaseMock.user = { id: "user-1" };
      supabaseMock.rpcMode = rpcMode;
      const response = await middleware(
        new NextRequest("https://rescue.example/home")
      );

      expect(response.status).toBe(200);
      expect(response.cookies.get("rescueai-access-day")).toBeUndefined();
    }
  );

  it("인증 쿠키 갱신 응답에 Supabase의 비공개 캐시 헤더를 보존한다", async () => {
    supabaseMock.user = { id: "user-1" };
    supabaseMock.refreshAuthCookie = true;
    const response = await middleware(
      new NextRequest("https://rescue.example/home", {
        headers: { cookie: "rescueai-access-day=2026-09-02" },
      })
    );

    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("expires")).toBe("0");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.cookies.get("sb-test-auth-token")?.value).toBe(
      "refreshed"
    );
  });
});

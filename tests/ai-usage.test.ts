import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), abort: vi.fn(), client: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.client }));
import { guardAiUsage, guardNewsCronUsage } from "@/lib/ai-usage";

beforeEach(() => {
  vi.clearAllMocks(); mocks.rpc.mockReturnValue({ abortSignal: mocks.abort });
  mocks.client.mockResolvedValue({ rpc: mocks.rpc });
  mocks.abort.mockResolvedValue({ data: { ok: true, retry_after_seconds: 0 }, error: null });
});

describe("AI 사용량 서버 가드", () => {
  it("사용자나 임의 상한 없이 서버 action만 세션 RPC에 넘긴다", async () => {
    expect(await guardAiUsage("generate")).toBeNull();
    expect(mocks.rpc).toHaveBeenCalledWith("consume_ai_budget", { p_action: "generate" });
    expect(mocks.abort).toHaveBeenCalledWith(expect.any(AbortSignal));
  });
  it("정상 공유 계정의 요청을 별도 로그인/동시작업 잠금 없이 허용한다", async () => {
    expect(await Promise.all(Array.from({ length: 5 }, () => guardAiUsage("chat"))))
      .toEqual([null, null, null, null, null]);
  });
  it("일일 한도는 합산 계정 안내와 Retry-After를 반환한다", async () => {
    mocks.abort.mockResolvedValue({ data: { ok: false, limit_kind: "account_daily", retry_after_seconds: 300 }, error: null });
    const response = await guardAiUsage("chat");
    expect(response?.status).toBe(429);
    expect(response?.headers.get("retry-after")).toBe("300");
    expect(await response?.json()).toMatchObject({ code: "ai_usage_limited", scope: "account_daily", error: expect.stringContaining("공용 계정") });
  });
  it.each([
    { data: null, error: { code: "42883" } },
    { data: null, error: null },
    { data: { ok: "true" }, error: null },
  ])("DB 오류·잘못된 결과는 메모리 허용으로 폴백하지 않는다", async (reply) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.abort.mockResolvedValue(reply);
    expect((await guardAiUsage("chat"))?.status).toBe(503);
    log.mockRestore();
  });
  it("Cron은 별도 고정 RPC에 사용자/action 매개변수 없이 요청한다", async () => {
    expect(await guardNewsCronUsage({ rpc: mocks.rpc } as unknown as Parameters<typeof guardNewsCronUsage>[0])).toBeNull();
    expect(mocks.rpc).toHaveBeenCalledWith("consume_news_cron_budget");
    expect(mocks.client).not.toHaveBeenCalled();
  });
});

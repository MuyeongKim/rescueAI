import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatRequestError, chatErrorMessage, fetchChat } from "@/lib/chat-request";

afterEach(() => vi.unstubAllGlobals());

describe("튜터 실패 안내", () => {
  it("429 재시도 대기시간을 보존하되 서버 오류 원문은 노출하지 않는다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("internal token details", { status: 429, headers: { "retry-after": "12" } })));
    const failure = await fetchChat("/api/chat").catch(error => error);
    expect(failure).toBeInstanceOf(ChatRequestError);
    expect(failure.retryAfterSeconds).toBe(12);
    expect(chatErrorMessage(failure)).toContain("12초 후");
    expect(failure.message).not.toContain("token");
  });

  it("만료된 로그인은 로그인 확인 안내로 구분한다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })));
    const failure = await fetchChat("/api/chat").catch(error => error);
    expect(failure.status).toBe(401);
    expect(failure.message).toContain("로그인 상태");
  });

  it("성공 스트림을 읽거나 교체하지 않는다", async () => {
    const response = new Response("stream-content");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    expect(await fetchChat("/api/chat")).toBe(response);
    expect(response.bodyUsed).toBe(false);
  });

  it("네트워크/공급자 오류 원문 대신 미완성 답변을 안내한다", () => {
    expect(chatErrorMessage(new Error("provider internal credential details"))).toContain("일부 답변은 완성되지 않았을 수 있습니다");
    expect(chatErrorMessage(new Error("provider internal credential details"))).not.toContain("credential");
  });
});

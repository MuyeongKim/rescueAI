import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchHwpBytes, HWP_UPSTREAM_TIMEOUT_MS } from "@/lib/hwp-upstream";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("HWP 응답 바이트·시간 제한", () => {
  it.each([undefined, "1"])("Content-Length %s도 실제 수신 상한을 넘으면 취소한다", async (declared) => {
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(9)); }, cancel: cancelled });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, { headers: declared ? { "Content-Length": declared } : {} }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchHwpBytes("https://synthetic.invalid/file", {}, 8, new AbortController().signal)).rejects.toThrow("limit exceeded");
    expect(cancelled).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(fetchMock.mock.calls[0][1].redirect).toBe("error");
  });

  it("선언 크기 초과는 본문을 읽기 전에 취소한다", async () => {
    const cancelled = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel: cancelled }), { headers: { "Content-Length": "9" } })));
    await expect(fetchHwpBytes("https://synthetic.invalid/file", {}, 8, new AbortController().signal)).rejects.toThrow("limit exceeded");
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("정확히 상한인 여러 청크는 전부 전달한다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(c) { c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3, 4])); c.close(); },
    }))));
    expect(await fetchHwpBytes("https://synthetic.invalid/file", {}, 4, new AbortController().signal)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it.each(["headers", "body"])("%s 수신 정지는 20초 안에 중단한다", async (phase) => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const fetchMock = vi.fn().mockImplementation(() => phase === "headers" ? new Promise(() => undefined)
      : Promise.resolve(new Response(new ReadableStream({ cancel: cancelled }))));
    vi.stubGlobal("fetch", fetchMock);
    const result = fetchHwpBytes("https://synthetic.invalid/file", {}, 8, new AbortController().signal);
    const check = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(HWP_UPSTREAM_TIMEOUT_MS);
    await check;
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    if (phase === "body") expect(cancelled).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("사용자가 취소하면 느린 파일 수신도 종료한다", async () => {
    const cancelled = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel: cancelled }))));
    const client = new AbortController();
    const result = fetchHwpBytes("https://synthetic.invalid/file", {}, 8, client.signal);
    const check = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve(); await Promise.resolve();
    client.abort(); await check;
    expect(cancelled).toHaveBeenCalledOnce();
  });
});

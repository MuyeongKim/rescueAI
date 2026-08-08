import { describe, it, expect, vi, afterEach } from "vitest";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

// LLM 엔드포인트 비용 방어의 마지막 선 — 창(window) 경계 동작이 틀리면 무한 호출이 뚫린다.
describe("rateLimit", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("상한까지는 통과시키고 그 다음부터 막는다", () => {
    const key = `t1-${Math.random()}`;
    for (let i = 0; i < 3; i++) {
      expect(rateLimit(key, 3, 60_000).ok).toBe(true);
    }
    expect(rateLimit(key, 3, 60_000).ok).toBe(false);
  });

  it("키가 다르면 서로 영향을 주지 않는다", () => {
    const a = `t2a-${Math.random()}`;
    const b = `t2b-${Math.random()}`;
    expect(rateLimit(a, 1, 60_000).ok).toBe(true);
    expect(rateLimit(a, 1, 60_000).ok).toBe(false);
    expect(rateLimit(b, 1, 60_000).ok).toBe(true);
  });

  it("창이 지나면 다시 통과시킨다", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T00:00:00Z"));
    const key = `t3-${Math.random()}`;

    expect(rateLimit(key, 2, 60_000).ok).toBe(true);
    expect(rateLimit(key, 2, 60_000).ok).toBe(true);
    expect(rateLimit(key, 2, 60_000).ok).toBe(false);

    vi.setSystemTime(new Date("2026-08-08T00:01:01Z")); // 61초 경과
    expect(rateLimit(key, 2, 60_000).ok).toBe(true);
  });

  it("차단 시 남은 대기 시간(초)을 1초 이상으로 알려준다", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T00:00:00Z"));
    const key = `t4-${Math.random()}`;

    rateLimit(key, 1, 60_000);
    vi.setSystemTime(new Date("2026-08-08T00:00:30Z"));
    const blocked = rateLimit(key, 1, 60_000);

    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBe(30);
  });
});

describe("tooManyRequests", () => {
  it("429 와 Retry-After 헤더를 준다", () => {
    const res = tooManyRequests(12);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("12");
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/demo", () => ({ DEMO: true }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireApiUser: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(),
  tooManyRequests: vi.fn(),
}));

import { POST } from "@/app/api/generate/focus/route";

function requestWith(body: unknown): Request {
  return new Request("http://localhost/api/generate/focus", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("데모 세부 훈련 방향 요청", () => {
  it("공개 데모에서도 8KB를 넘는 본문을 전부 읽지 않고 413으로 거절한다", async () => {
    const response = await POST(
      requestWith({
        category: "산악",
        topic: "산악사고 대비 훈련",
        padding: "x".repeat(9_000),
      })
    );

    expect(response.status).toBe(413);
  });

  it("넓은 주제는 근거가 표시된 선택지를 제공한다", async () => {
    const response = await POST(
      requestWith({ category: "산악", topic: "산악사고 대비 훈련" })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.scope).toBe("broad");
    expect(payload.options).toHaveLength(4);
    expect(payload.options[0].sourceRefs).toEqual(["[데모 연결 교범 p.1]"]);
    expect(payload.recommendedId).toBeUndefined();
  });
});

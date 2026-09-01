import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  rateLimit: vi.fn(),
  generateObject: vi.fn(),
  getChatModel: vi.fn(),
}));

vi.mock("@/lib/demo", () => ({ DEMO: true }));
vi.mock("@/lib/auth", () => ({ requireApiUser: mocks.requireApiUser }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
  tooManyRequests: vi.fn(),
}));
vi.mock("ai", () => ({ generateObject: mocks.generateObject }));
vi.mock("@/lib/llm", () => ({ getChatModel: mocks.getChatModel }));

import { POST } from "@/app/api/generate/category/route";

function requestWith(body: unknown): Request {
  return new Request("http://localhost/api/generate/category", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const categories = [
  { name: "산악" },
  { name: "화재" },
  { name: "일반구조" },
  { name: "화학사고" },
];

describe("데모 주제 기반 분야 분류", () => {
  it("명확한 주제는 운영 경로와 같은 계약으로 결정론적 추천을 반환한다", async () => {
    const response = await POST(
      requestWith({ topic: "암모니아 누출 대응", categories })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      category: "화학사고",
      confidence: "high",
      alternatives: [],
      source: "deterministic",
    });
    expect(mocks.requireApiUser).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });

  it("애매한 데모 주제는 모델을 호출하지 않고 low와 확인 경고를 반환한다", async () => {
    const response = await POST(
      requestWith({ topic: "종합 현장 대응 훈련", categories })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(categories.map((category) => category.name)).toContain(payload.category);
    expect(payload.category).toBe("일반구조");
    expect(payload.confidence).toBe("low");
    expect(payload.source).toBe("deterministic");
    expect(payload.warning).toContain("데모");
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });

  it.each([
    ["알 수 없는 필드", { topic: "화재 대응", categories, unexpected: true }],
    [
      "구두점만 다른 중복 분야",
      {
        topic: "화학사고 대응",
        categories: [{ name: "화학사고" }, { name: "화학-사고" }],
      },
    ],
    [
      "자료 제목 누적 8,000자 초과",
      {
        topic: "종합 현장 대응",
        categories: [
          ...Array.from({ length: 8 }, (_, index) => ({
            name: `분야${index}`,
            sourceTitles: Array(5).fill("가".repeat(200)),
          })),
          { name: "분야8", sourceTitles: ["가"] },
        ],
      },
    ],
  ])("데모에서도 %s 입력을 엄격하게 거절한다", async (_label, body) => {
    const response = await POST(requestWith(body));

    expect(response.status).toBe(400);
  });
});

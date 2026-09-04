import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/lib/demo", () => ({
  DEMO: true,
  demoDocuments: [],
  demoGeneratedDoc: {
    title: "화재 교육",
    sections: [
      { heading: "훈련목표", content: "목표" },
      { heading: "훈련내용", content: "내용" },
    ],
    sources: [],
  },
  demoGeneratedSlides: {
    title: "화재 교육",
    slides: [
      { title: "목표", bullets: ["목표"], notes: "설명" },
      { title: "절차", bullets: ["절차"], notes: "설명" },
    ],
    sources: [],
  },
}));
vi.mock("@/lib/auth", () => ({ requireApiUser: mocks.requireApiUser }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
  tooManyRequests: vi.fn(),
}));
vi.mock("@/lib/generate-context", () => ({ fetchCategoryContext: vi.fn() }));
vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("@/lib/llm", () => ({ getChatModel: vi.fn() }));

import { POST as generate } from "@/app/api/generate/route";
import { POST as regenerate } from "@/app/api/generate/section/route";

function request(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("생성 API 데모 모드 입력 경계", () => {
  beforeEach(() => vi.clearAllMocks());

  it("전체 생성은 인증 없이도 제한된 정상 본문을 처리한다", async () => {
    const response = await generate(
      request("/api/generate", {
        type: "plan",
        category: "화재",
        audience: "일반 대원",
        duration: "1시간",
        topic: "공기호흡기 착용 방법",
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.requireApiUser).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it("부분 재생성도 인증 없이 제한된 정상 본문을 처리한다", async () => {
    const response = await regenerate(
      request("/api/generate/section", {
        kind: "section",
        category: "화재",
        audience: "일반 대원",
        duration: "1시간",
        topic: "공기호흡기 착용 방법",
        outline: ["훈련목표", "훈련내용"],
        index: 1,
        current: { heading: "훈련내용", content: "현재 내용" },
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.requireApiUser).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it("데모 모드도 전체 생성 8KB 본문 상한을 적용한다", async () => {
    const response = await generate(
      request("/api/generate", {
        type: "plan",
        category: "화재",
        audience: "일반 대원",
        duration: "1시간",
        topic: "공기호흡기 착용 방법",
        conditions: "x".repeat(9_000),
      })
    );

    expect(response.status).toBe(413);
    expect(mocks.requireApiUser).not.toHaveBeenCalled();
  });
});

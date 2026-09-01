import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  rateLimit: vi.fn(),
  fetchCategoryContext: vi.fn(),
  generateObject: vi.fn(),
  getChatModel: vi.fn(),
}));

vi.mock("@/lib/demo", () => ({ DEMO: true }));
vi.mock("@/lib/auth", () => ({ requireApiUser: mocks.requireApiUser }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
  tooManyRequests: vi.fn(),
}));
vi.mock("@/lib/generate-context", () => ({
  fetchCategoryContext: mocks.fetchCategoryContext,
}));
vi.mock("ai", () => ({ generateObject: mocks.generateObject }));
vi.mock("@/lib/llm", () => ({ getChatModel: mocks.getChatModel }));

import { POST } from "@/app/api/generate/evidence/route";

function requestWith(body: unknown): Request {
  return new Request("http://localhost/api/generate/evidence", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/generate/evidence 데모 모드", () => {
  it("실제 RAG·LLM과 인증을 호출하지 않고 검증 불가 상태를 422로 반환한다", async () => {
    const response = await POST(
      requestWith({
        category: "산악",
        audience: "일반 대원",
        duration: "1시간",
        topic: "경사면 구조 훈련",
        deck: {
          title: "경사면 구조 훈련",
          mode: "presenter",
          slides: [
            {
              title: "로프 시스템을 확인합니다",
              bullets: ["현장 조건을 확인합니다"],
              notes: "교관 설명",
              sourceRefs: ["[데모 교범 p.1]"],
            },
          ],
          sources: [{ document_id: 1, doc: "데모 교범", page: 1 }],
          sourceLabels: ["[데모 교범 p.1]"],
          sopEvidence: { status: "not_found", sourceLabels: [] },
        },
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(response.ok).toBe(false);
    expect(payload.code).toBe("demo_evidence_repair_unavailable");
    expect(payload).not.toHaveProperty("deck");
    expect(payload.repairedIndices).toEqual([]);
    expect(payload.unresolvedIndices).toEqual([0]);
    expect(payload.remainingIssuePaths).toEqual(["slides.0.sourceRefs"]);
    expect(mocks.requireApiUser).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.fetchCategoryContext).not.toHaveBeenCalled();
    expect(mocks.generateObject).not.toHaveBeenCalled();
    expect(mocks.getChatModel).not.toHaveBeenCalled();
  });
});
